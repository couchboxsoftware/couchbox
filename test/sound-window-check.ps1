# Runs test/sound-window-check.js through every step, in order (several app launches).
# Usage: powershell -File test\sound-window-check.ps1 -Library <sample library> -Out <snapshot folder>
param([string]$Library, [string]$Out)
$root = Split-Path $PSScriptRoot -Parent
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$env:SW_DATA = Join-Path ([IO.Path]::GetTempPath()) ('couchbox-sw-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$env:COUCHBOX_LIBRARY = $Library
$env:COUCHBOX_SNAP_OUT = $Out
$steps = @(
  @{ step = 'sounds-on'; fresh = '1' },
  @{ step = 'sounds-off' },
  @{ step = 'mode:window'; expect = 'window 1400x860' },
  @{ step = 'mode:maximized' },
  @{ step = 'mode:fullscreen' },
  # remember: last session ended in fullscreen -> reopens fullscreen; then maximised; then a moved window
  @{ step = 'mode:remember'; expect = 'fullscreen'; act = 'maximize' },
  @{ step = 'mode:remember'; expect = 'maximized'; act = 'bounds' },
  @{ step = 'mode:remember'; expect = 'window 1100x700 at 140,90' },
  # and again: a remembered window mustn't creep bigger launch after launch
  @{ step = 'mode:remember'; expect = 'window 1100x700 at 140,90' },
  @{ step = 'mode:remember'; expect = 'window 1100x700 at 140,90' }
)
foreach ($s in $steps) {
  $env:SW_STEP = $s.step
  $env:SW_FRESH = if ($s.fresh) { $s.fresh } else { '0' }
  $env:SW_EXPECT = if ($s.expect) { $s.expect } else { '' }
  $env:SW_ACT = if ($s.act) { $s.act } else { '' }
  & $electron (Join-Path $root 'test\sound-window-check.js') 2>&1 | Where-Object { $_ -match '^(PASS|FAIL|\[)' } | ForEach-Object { "$_" }
}
Remove-Item $env:SW_DATA -Recurse -Force -ErrorAction SilentlyContinue
