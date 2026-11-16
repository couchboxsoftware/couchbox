// Proves the person at the PC is its owner, for "Forgot PIN?" (pins.js):
// - Windows Hello (the PC's own PIN, fingerprint or face), when it's set up;
// - otherwise the Windows account password, in Windows' own sign-in prompt, checked by Windows.
// Couchbox never sees, stores or shows the password: it stays inside Windows' prompt and the
// short PowerShell check, which only answers "Verified" or not. No native modules: Windows
// PowerShell 5.1 runs the Windows APIs, hidden, with a 2-minute time limit.
// Tests: COUCHBOX_HELLO_STUB = "ok" | "fail" (Hello) or "password-ok" | "password-fail" (no Hello).
const { spawn } = require('child_process');
const path = require('path');

const TIMEOUT_MS = 2 * 60 * 1000;
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const WINRT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$V = [Windows.Security.Credentials.UI.UserConsentVerifier]
`;

const AVAILABLE = WINRT + `
"RESULT:" + (Await ($V::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]))
`;

const VERIFY_HELLO = WINRT + `
"RESULT:" + (Await ($V::RequestVerificationAsync($env:CB_MESSAGE)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult]))
`;

// Windows' own credential prompt, then LogonUser; the account must be the one signed in.
const VERIFY_PASSWORD = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text; using System.Security.Principal;
public static class CbCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct INFO { public int cbSize; public IntPtr parent; public string message; public string caption; public IntPtr banner; }
  [DllImport("credui.dll", CharSet = CharSet.Unicode)] static extern int CredUIPromptForWindowsCredentials(ref INFO info, int err, ref uint pkg, IntPtr inBuf, uint inSize, out IntPtr outBuf, out uint outSize, ref bool save, int flags);
  [DllImport("credui.dll", CharSet = CharSet.Unicode)] static extern bool CredUnPackAuthenticationBuffer(int flags, IntPtr buf, uint size, StringBuilder user, ref int userLen, StringBuilder domain, ref int domainLen, StringBuilder pass, ref int passLen);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LogonUser(string user, string domain, string pass, int type, int provider, out IntPtr token);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr p);
  public static string Run(string caption, string message) {
    INFO info = new INFO(); info.cbSize = Marshal.SizeOf(typeof(INFO)); info.caption = caption; info.message = message;
    uint pkg = 0; IntPtr buf; uint size; bool save = false;
    int r = CredUIPromptForWindowsCredentials(ref info, 0, ref pkg, IntPtr.Zero, 0, out buf, out size, ref save, 0x200);
    if (r == 1223) return "Canceled";
    if (r != 0) return "Unavailable";
    StringBuilder u = new StringBuilder(514), d = new StringBuilder(338), p = new StringBuilder(258);
    int ul = 514, dl = 338, pl = 258;
    bool unpacked = CredUnPackAuthenticationBuffer(0, buf, size, u, ref ul, d, ref dl, p, ref pl);
    for (int i = 0; i < size; i++) Marshal.WriteByte(buf, i, 0);
    CoTaskMemFree(buf);
    if (!unpacked) return "Unavailable";
    string user = u.ToString(), dom = d.ToString();
    if (dom.Length == 0 && user.Contains("\\\\")) { string[] parts = user.Split('\\\\'); dom = parts[0]; user = parts[1]; }
    IntPtr tok;
    bool ok = LogonUser(user, dom.Length > 0 ? dom : ".", p.ToString(), 2, 0, out tok);
    p.Length = 0;
    if (!ok) return "NotVerified";
    bool same;
    using (WindowsIdentity who = new WindowsIdentity(tok)) same = who.User == WindowsIdentity.GetCurrent().User;
    CloseHandle(tok);
    return same ? "Verified" : "NotVerified";
  }
}
'@
"RESULT:" + [CbCred]::Run('Couchbox', $env:CB_MESSAGE)
`;

// Runs a script in hidden Windows PowerShell; resolves the text after "RESULT:" (or '').
function runPs(script, message) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child;
    try {
      // The script goes in encoded (UTF-16LE base64): piping a multi-line script in is unreliable.
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: true,
        env: { ...process.env, CB_MESSAGE: message || 'Couchbox' },
      });
    } catch (_) {
      return resolve('');
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish('TimedOut');
    }, TIMEOUT_MS);
    child.stdout.on('data', (b) => (out += b));
    child.on('error', () => finish(''));
    child.on('close', () => {
      const m = /RESULT:(\w+)/.exec(out);
      finish(m ? m[1] : '');
    });
    child.stdin.end();
  });
}

let helloAvailable = null; // checked once
async function kind() {
  const stub = process.env.COUCHBOX_HELLO_STUB;
  if (stub) return /^password/.test(stub) ? 'password' : 'hello';
  if (helloAvailable == null) helloAvailable = (await runPs(AVAILABLE)) === 'Available';
  return helloAvailable ? 'hello' : 'password';
}

const REASONS = {
  Canceled: 'Cancelled.',
  NotVerified: "Windows couldn't confirm it's you.",
  RetriesExhausted: 'Too many tries. Try again later.',
  DeviceBusy: 'Windows Hello is busy. Try again.',
  TimedOut: 'That took too long. Try again.',
};

// { ok: true } or { ok: false, error }.
async function verify(message) {
  const stub = process.env.COUCHBOX_HELLO_STUB;
  if (stub) return /ok$/.test(stub) ? { ok: true } : { ok: false, error: REASONS.NotVerified };
  const how = await kind();
  const r = await runPs(how === 'hello' ? VERIFY_HELLO : VERIFY_PASSWORD, message);
  if (r === 'Verified') return { ok: true };
  return { ok: false, error: REASONS[r] || "Windows couldn't check it's you on this PC." };
}

module.exports = { kind, verify };
