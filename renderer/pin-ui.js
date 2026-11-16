/* The PIN screen (profile lock): four boxes, a number pad (the keyboard's numbers work too),
   Forgot PIN? and Cancel. Full screen when picking a profile ("A · Full screen", chosen by the
   user); a smaller window in the same style for Settings and the profile editor. It draws in its
   own layer (#pin-root), above any open window. The PIN is checked in the main process
   (src/main/pins.js), which counts wrong tries and makes you wait after 5. */
const Pin = (() => {
  let root = null;
  let active = null; // { onKey } while open

  function layer() {
    if (!root) {
      root = document.createElement('div');
      root.id = 'pin-root';
      document.body.appendChild(root);
    }
    return root;
  }
  const close = () => {
    if (active) {
      document.removeEventListener('keydown', active.onKey, true);
      active.stop(); // a countdown that's still running
    }
    active = null;
    layer().innerHTML = '';
  };

  const PAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back'];
  function frame({ full, profile, title, note }) {
    const pic = profile ? `<div class="pin-av" style="background:${profile.color}">${avatarInner(profile)}</div>` : `<div class="pin-av pin-av-lock">${ICON.lock}</div>`;
    const body = `
      ${pic}
      <h2 class="pin-title">${esc(title)}</h2>
      ${note ? `<p class="pin-note">${esc(note)}</p>` : ''}
      <div class="pin-boxes" aria-live="polite">${[0, 1, 2, 3].map(() => '<span></span>').join('')}</div>
      <div class="pin-msg" role="status"></div>
      <div class="pin-pad">${PAD.map((k) => (k === '' ? '<span></span>' : `<button type="button" data-k="${k}" aria-label="${k === 'back' ? 'Delete' : k}">${k === 'back' ? ICON.back : k}</button>`)).join('')}</div>
      <div class="pin-foot"><button type="button" class="pin-link" data-pin="forgot">Forgot PIN?</button><button type="button" class="btn btn-sm btn-ghost" data-pin="cancel">Cancel</button></div>
      <div class="pin-after" hidden></div>`;
    return full
      ? `<div class="pin-screen" role="dialog" aria-label="${esc(title)}"><div class="brand">${brandHTML()}</div><div class="pin-body">${body}</div></div>`
      : `<div class="pin-overlay"><div class="pin-window" role="dialog" aria-label="${esc(title)}">${body}</div></div>`;
  }

  // The shared keypad logic. onFull(pin) runs when 4 numbers are in.
  function keypad(onFull, onCancel) {
    let digits = '';
    let busy = false;
    let waitTimer = null;
    const boxes = () => $$('.pin-boxes span', layer());
    const show = () => boxes().forEach((b, i) => b.classList.toggle('on', i < digits.length));
    const msg = (t) => {
      const m = $('.pin-msg', layer());
      if (m) m.textContent = t || '';
    };
    const add = async (k) => {
      if (busy || waitTimer) return;
      if (k === 'back') digits = digits.slice(0, -1);
      else if (/^\d$/.test(k) && digits.length < 4) digits += k;
      show();
      if (digits.length === 4) {
        busy = true;
        const pin = digits;
        await onFull(pin);
        busy = false;
      }
    };
    const wrong = (text) => {
      const b = $('.pin-boxes', layer());
      b.classList.remove('shake');
      void b.offsetWidth; // restart the animation
      b.classList.add('shake');
      digits = '';
      show();
      msg(text);
    };
    const wait = (s) => {
      digits = '';
      show();
      clearInterval(waitTimer);
      const tick = () => {
        if (s <= 0) {
          clearInterval(waitTimer);
          waitTimer = null;
          msg('');
          return;
        }
        msg(`Too many tries. Try again in ${s} second${s === 1 ? '' : 's'}.`);
        s--;
      };
      waitTimer = setInterval(tick, 1000);
      tick();
    };
    const reset = (text) => {
      digits = '';
      show();
      msg(text);
    };
    layer().onclick = (e) => {
      const k = e.target.closest('[data-k]');
      if (k) return add(k.dataset.k);
      const a = e.target.closest('[data-pin]');
      if (a && a.dataset.pin === 'cancel') onCancel();
    };
    const onKey = (e) => {
      e.stopPropagation(); // nothing behind the PIN screen reacts to keys
      if (/^\d$/.test(e.key)) add(e.key);
      else if (e.key === 'Backspace') add('back');
      else if (e.key === 'Escape') onCancel();
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey, true);
    const stop = () => {
      clearInterval(waitTimer);
      waitTimer = null;
    };
    active = { onKey, stop };
    return { wrong, wait, msg, reset, stop };
  }

  // Asks for a locked profile's PIN (profile), or a grown-up's (no profile: any locked
  // profile's PIN). Resolves true when it's right, or Forgot PIN? lets it through; false on
  // Cancel. With wantPin, resolves the PIN itself (or null), for Change and Remove PIN.
  function ask({ profile = null, full = false, title, note, wantPin = false, noForgot = false } = {}) {
    hideHover();
    close();
    title = title || (profile ? `Enter ${profile.name}'s PIN` : "Enter a grown-up's PIN");
    layer().innerHTML = frame({ full, profile, title, note });
    if (noForgot) $('[data-pin="forgot"]', layer()).hidden = true;
    return new Promise((resolve) => {
      const done = (v) => {
        pad.stop();
        close();
        resolve(v);
      };
      const pad = keypad(
        async (pin) => {
          const r = profile ? await cb.pinCheck(profile.id, pin) : await cb.pinCheckAny(pin);
          if (r.ok) return done(wantPin ? pin : true);
          if (r.wait) return pad.wait(r.wait);
          pad.wrong(r.left != null && r.left <= 2 ? `Wrong PIN. ${r.left} ${r.left === 1 ? 'try' : 'tries'} left before a short wait.` : 'Wrong PIN. Try again.');
        },
        () => done(wantPin ? null : false)
      );
      $('[data-pin="forgot"]', layer()).addEventListener('click', async () => {
        const kind = await cb.pinKind();
        pad.msg(kind === 'hello' ? 'Confirm with Windows Hello (your PC PIN, fingerprint or face)…' : 'Sign in with your Windows password in the window that opens…');
        const r = await cb.pinForgot(profile ? profile.id : null, profile ? profile.name : '');
        if (!r.ok) return pad.msg(r.error || "Windows couldn't confirm it's you.");
        if (r.profiles) syncProfiles(r.profiles);
        if (!profile || wantPin) return done(wantPin ? null : true);
        // The PIN is gone: offer to set a new one now.
        $('.pin-pad', layer()).hidden = true;
        $('.pin-boxes', layer()).hidden = true;
        $('.pin-foot', layer()).hidden = true;
        pad.msg(`${profile.name}'s PIN is removed.`);
        const after = $('.pin-after', layer());
        after.hidden = false;
        after.innerHTML = '<button type="button" class="btn btn-sm btn-accent" data-after="new">Set a new PIN</button><button type="button" class="btn btn-sm btn-ghost" data-after="skip">Not now</button>';
        after.onclick = async (e) => {
          const b = e.target.closest('[data-after]');
          if (!b) return;
          if (b.dataset.after === 'new') {
            pad.stop();
            const pin = await choose({ full, profile });
            if (pin) {
              const s = await cb.pinSet(profile.id, pin, null);
              if (s.ok) syncProfiles(s.profiles);
            }
            close();
            return resolve(true);
          }
          done(true);
        };
      });
    });
  }

  // Choosing a new PIN: typed twice. Resolves the PIN, or null on Cancel.
  function choose({ full = false, profile = null } = {}) {
    close();
    layer().innerHTML = frame({ full, profile, title: 'Choose a 4-number PIN', note: profile ? `For ${profile.name}` : '' });
    $('[data-pin="forgot"]', layer()).hidden = true;
    return new Promise((resolve) => {
      let first = null;
      const done = (v) => {
        pad.stop();
        close();
        resolve(v);
      };
      const pad = keypad(
        async (pin) => {
          if (!first) {
            first = pin;
            $('.pin-title', layer()).textContent = 'Enter it again';
            return pad.reset('');
          }
          if (pin === first) return done(pin);
          first = null;
          $('.pin-title', layer()).textContent = 'Choose a 4-number PIN';
          pad.wrong("Those didn't match. Choose it again.");
        },
        () => done(null)
      );
    });
  }

  // New profiles from the main process (a PIN added, changed or removed).
  function syncProfiles(list) {
    S.profiles = list;
    if (S.profile) S.profile = list.find((p) => p.id === S.profile.id) || S.profile;
  }

  return { ask, choose, isOpen: () => !!active, syncProfiles };
})();
