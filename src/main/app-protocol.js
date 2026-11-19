// Couchbox's private app:// protocol (the standard's 1.5). Pages never load from file:.
//
//   app://couchbox/renderer/index.html    the app's own files, only from inside the app folder
//   app://couchbox/media/<encoded path>   videos, subtitles, posters, thumbnails and profile
//                                         pictures, only from inside the video folder or
//                                         Couchbox's own data folder
//
// Media is streamed (the scheme has `stream`), and byte ranges are answered with 206 Partial
// Content, so the player and the scrub thumbnails can seek without reading the whole file.
// Anything outside those folders gets a 404. registerScheme() must run before the app is ready.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const { protocol, net } = require('electron');

const HOST = 'couchbox';
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv', '.ts': 'video/mp2t', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.vtt': 'text/vtt', '.srt': 'text/plain; charset=utf-8',
};

// Once only, and before the app is ready (tests that load main.js later call it first).
let registered = false;
function registerScheme() {
  if (registered) return;
  registered = true;
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ]);
}

const pageUrl = (rel) => `app://${HOST}/${rel}`;
// A file's media address. Encoding a folder with its trailing \ and then a name gives the same
// address as encoding the whole path, so profile pictures can be addressed as folder + name.
const mediaUrl = (p) => (p ? `app://${HOST}/media/${encodeURIComponent(p)}` : null);

// Is `file` inside `root`? (Not just a name that starts the same: C:\Videos2 isn't in C:\Videos.)
function inside(root, file) {
  if (!root) return false;
  const rel = path.relative(path.resolve(root), file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const status = (code, text) => new Response(text, { status: code, headers: { 'Content-Type': 'text/plain' } });

// A file from disk, whole or the byte range asked for.
async function serveFile(req, file) {
  let st;
  try {
    st = await fs.promises.stat(file);
    if (!st.isFile()) throw new Error('not a file');
  } catch (_) {
    return status(404, 'Not found');
  }
  const size = st.size;
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const stream = (start, end) => {
    const s = fs.createReadStream(file, { start, end });
    s.on('error', () => {}); // a seek or a closed page cancels the read: nothing to report
    return Readable.toWeb(s);
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec((req.headers.get('range') || '').trim());
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    return new Response(stream(start, end), {
      status: 206,
      headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' },
    });
  }
  return new Response(size ? stream(0, size - 1) : null, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
}

// appRoot: the app folder (pages). mediaRoots(): the folders media may come from, asked each
// time (the video folder can change).
function handle({ appRoot, mediaRoots }) {
  protocol.handle('app', (req) => {
    let u;
    try {
      u = new URL(req.url);
    } catch (_) {
      return status(404, 'Not found');
    }
    if (u.host !== HOST) return status(404, 'Not found');
    if (u.pathname.startsWith('/media/')) {
      let file;
      try {
        file = path.resolve(decodeURIComponent(u.pathname.slice('/media/'.length)));
      } catch (_) {
        return status(404, 'Not found');
      }
      if (!mediaRoots().some((root) => inside(root, file))) return status(404, 'Not found');
      return serveFile(req, file);
    }
    let file;
    try {
      file = path.resolve(appRoot, '.' + decodeURIComponent(u.pathname));
    } catch (_) {
      return status(404, 'Not found');
    }
    if (!inside(appRoot, file) || !fs.existsSync(file)) return status(404, 'Not found'); // (existsSync works inside app.asar)
    return net.fetch(pathToFileURL(file).toString()); // works inside app.asar too
  });
}

module.exports = { registerScheme, handle, pageUrl, mediaUrl, inside, HOST };
