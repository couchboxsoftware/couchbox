/* Shared helpers and icons for the renderer. */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.round(sec / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60 ? (m % 60) + 'm' : '');
}

function hashHue(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

const PROFILE_COLOURS = ['#E8743B', '#3B82C4', '#2E9E6B', '#B4478A', '#C9A227', '#6D5BD0', '#D2453D', '#2AA3A3'];

const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${d}</svg>`;
const ICON = {
  play: svg('<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" fill="currentColor"/>'),
  pause: svg('<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>'),
  plus: svg('<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
  info: svg('<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 11v6M12 7.5v.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  down: svg('<path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
  left: svg('<path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
  right: svg('<path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
  back: svg('<path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  volume: svg('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'),
  mute: svg('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  full: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
  unfull: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
  rew: svg('<path d="M12 5a7.5 7.5 0 1 1-7.1 5.1" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M4 4.5v5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><text x="12" y="15.6" font-size="7" text-anchor="middle" fill="currentColor" font-family="Segoe UI, sans-serif" font-weight="700">10</text>'),
  fwd: svg('<path d="M12 5a7.5 7.5 0 1 0 7.1 5.1" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M20 4.5v5h-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><text x="12" y="15.6" font-size="7" text-anchor="middle" fill="currentColor" font-family="Segoe UI, sans-serif" font-weight="700">10</text>'),
  subs: svg('<rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M7 12.5h3M12.5 12.5H17M7 15.5h6M15 15.5h2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  speed: svg('<path d="M4.5 16a8 8 0 1 1 15 0" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M12 15l4-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  next: svg('<path d="M5 5.5v13a1 1 0 0 0 1.5.86L16 13.5V18a1 1 0 0 0 2 0V6a1 1 0 0 0-2 0v4.5L6.5 4.64A1 1 0 0 0 5 5.5z" fill="currentColor"/>'),
  gear: svg('<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4L5.3 5.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/>'),
  pencil: svg('<path d="M4 20h4L19 9l-4-4L4 16v4z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/>'),
  episodes: svg('<rect x="3" y="4" width="18" height="5" rx="1.5" stroke="currentColor" stroke-width="2" fill="none"/><rect x="3" y="12" width="18" height="5" rx="1.5" stroke="currentColor" stroke-width="2" fill="none"/>'),
  star: svg('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5z" fill="currentColor"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="2" fill="none"/>'),
  logo: svg('<rect x="1.5" y="5" width="21" height="14" rx="3.5" fill="currentColor"/><path d="M10 9v6l5-3-5-3z" fill="#121212"/>'),
};

function brandHTML() {
  return `<span class="brand-icon">${BRAND.icon}</span>${BRAND.wordmark}`;
}

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
