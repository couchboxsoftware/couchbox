/* Profile picture cropper: shows the whole picture with a square box on top. Drag the box to
   move it, drag a corner to resize it (it stays square and inside the picture), rotate in 90°
   steps, and see live previews. Returns a 200 x 200 JPEG data URL, null on Cancel, or
   { error } if the picture can't be read. */
const Cropper = (() => {
  const OUT = 200; // saved size
  const MIN = 24; // smallest box, in picture pixels
  const MAX_SRC = 2400; // big photos are scaled down to this first, for speed
  const STAGE_W = 560, STAGE_H = 420;
  const HANDLE = 14; // corner grab distance, in screen pixels
  let st = null;

  function open(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => start(img, resolve);
      img.onerror = () => resolve({ error: "Couchbox can't read that picture. Try a JPG or PNG." });
      img.src = dataUrl;
    });
  }

  // The picture, rotated and (if huge) scaled down, on its own canvas.
  function sourceCanvas(img, rot) {
    const s = Math.min(1, MAX_SRC / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
    const c = document.createElement('canvas');
    const side = rot % 180 === 0;
    c.width = side ? w : h;
    c.height = side ? h : w;
    const x = c.getContext('2d');
    x.translate(c.width / 2, c.height / 2);
    x.rotate((rot * Math.PI) / 180);
    x.drawImage(img, -w / 2, -h / 2, w, h);
    return c;
  }

  function start(img, resolve) {
    st = { img, resolve, rot: 0, drag: null };
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.id = 'crop-ov';
    ov.dataset.close = '';
    ov.style.zIndex = 95;
    ov.innerHTML = `<div class="dialog crop-dialog" role="dialog" aria-label="Choose the square">
      <h2>Choose the square</h2>
      <p>Drag the square to move it. Drag a corner to make it bigger or smaller.</p>
      <div class="crop-body">
        <div class="crop-stage"><canvas id="crop-cv"></canvas></div>
        <div class="crop-side">
          <div class="crop-prev"><canvas id="crop-p1" width="192" height="192"></canvas><small>Profile tile</small></div>
          <div class="crop-prev"><canvas id="crop-p2" width="68" height="68" class="tiny"></canvas><small>Top bar</small></div>
          <button class="btn btn-sm btn-ghost" data-crop="rotate">${ICON.rotate || ''}Rotate</button>
        </div>
      </div>
      <div class="row-btns"><button class="btn btn-sm btn-ghost" data-crop="cancel">Cancel</button><button class="btn btn-sm btn-accent" data-crop="use">Use picture</button></div>
    </div>`;
    $('#modal-root').appendChild(ov);
    st.ov = ov;
    st.cv = $('#crop-cv', ov);
    ov.addEventListener('click', onClick);
    st.cv.addEventListener('pointerdown', onDown);
    st.cv.addEventListener('pointermove', onMove);
    st.cv.addEventListener('pointerup', onUp);
    st.cv.addEventListener('pointercancel', onUp);
    document.addEventListener('keydown', onKey, true);
    layout();
  }

  // Fit the (rotated) picture into the stage and start with the largest centred square.
  function layout() {
    st.src = sourceCanvas(st.img, st.rot);
    st.W = st.src.width;
    st.H = st.src.height;
    st.k = Math.min(STAGE_W / st.W, STAGE_H / st.H, 4);
    const cw = Math.round(st.W * st.k), ch = Math.round(st.H * st.k);
    const dpr = window.devicePixelRatio || 1;
    st.cv.width = Math.round(cw * dpr);
    st.cv.height = Math.round(ch * dpr);
    st.cv.style.width = cw + 'px';
    st.cv.style.height = ch + 'px';
    st.dpr = dpr;
    const s = Math.min(st.W, st.H);
    st.box = { x: (st.W - s) / 2, y: (st.H - s) / 2, s };
    draw();
  }

  function draw() {
    const { cv, src, k, dpr, box } = st;
    const x = cv.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cw = st.W * k, ch = st.H * k;
    x.clearRect(0, 0, cw, ch);
    x.drawImage(src, 0, 0, cw, ch);
    // Dim everything, then put the kept square back at full brightness.
    x.fillStyle = 'rgba(0,0,0,0.6)';
    x.fillRect(0, 0, cw, ch);
    const bx = box.x * k, by = box.y * k, bs = box.s * k;
    x.drawImage(src, box.x, box.y, box.s, box.s, bx, by, bs, bs);
    // Thirds guides, the border and the corner handles.
    x.strokeStyle = 'rgba(255,255,255,0.35)';
    x.lineWidth = 1;
    x.beginPath();
    for (const f of [1 / 3, 2 / 3]) {
      x.moveTo(bx + bs * f, by);
      x.lineTo(bx + bs * f, by + bs);
      x.moveTo(bx, by + bs * f);
      x.lineTo(bx + bs, by + bs * f);
    }
    x.stroke();
    x.strokeStyle = '#fff';
    x.lineWidth = 2;
    x.strokeRect(bx, by, bs, bs);
    x.fillStyle = '#e8743b';
    for (const [cx, cy] of corners()) {
      x.fillRect(cx * k - 6, cy * k - 6, 12, 12);
      x.strokeStyle = '#fff';
      x.lineWidth = 1.5;
      x.strokeRect(cx * k - 6, cy * k - 6, 12, 12);
    }
    for (const id of ['#crop-p1', '#crop-p2']) {
      const p = $(id, st.ov);
      const px = p.getContext('2d');
      px.imageSmoothingQuality = 'high';
      px.clearRect(0, 0, p.width, p.height);
      px.drawImage(src, box.x, box.y, box.s, box.s, 0, 0, p.width, p.height);
    }
  }

  // Corners in picture pixels, in the order: top-left, top-right, bottom-left, bottom-right.
  function corners() {
    const { x, y, s } = st.box;
    return [[x, y], [x + s, y], [x, y + s], [x + s, y + s]];
  }

  function toPic(e) {
    const r = st.cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) / st.k, y: (e.clientY - r.top) / st.k };
  }

  function hitCorner(p) {
    const reach = HANDLE / st.k;
    return corners().findIndex(([cx, cy]) => Math.abs(p.x - cx) <= reach && Math.abs(p.y - cy) <= reach);
  }

  const inside = (p) => p.x >= st.box.x && p.x <= st.box.x + st.box.s && p.y >= st.box.y && p.y <= st.box.y + st.box.s;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function onDown(e) {
    const p = toPic(e);
    const c = hitCorner(p);
    if (c >= 0) {
      // Resize: the opposite corner stays put.
      const [ax, ay] = corners()[3 - c];
      st.drag = { mode: 'resize', ax, ay, dx: c % 2 ? 1 : -1, dy: c >= 2 ? 1 : -1 };
    } else if (inside(p)) st.drag = { mode: 'move', ox: p.x - st.box.x, oy: p.y - st.box.y };
    else return;
    try {
      st.cv.setPointerCapture(e.pointerId); // keeps the drag going if the mouse leaves the picture
    } catch (_) {}
    e.preventDefault();
  }

  function onMove(e) {
    const p = toPic(e);
    const d = st.drag;
    if (!d) {
      const c = hitCorner(p);
      st.cv.style.cursor = c === 0 || c === 3 ? 'nwse-resize' : c === 1 || c === 2 ? 'nesw-resize' : inside(p) ? 'move' : 'default';
      return;
    }
    if (d.mode === 'move') {
      st.box.x = clamp(p.x - d.ox, 0, st.W - st.box.s);
      st.box.y = clamp(p.y - d.oy, 0, st.H - st.box.s);
    } else {
      const room = Math.min(d.dx > 0 ? st.W - d.ax : d.ax, d.dy > 0 ? st.H - d.ay : d.ay);
      const want = Math.max((p.x - d.ax) * d.dx, (p.y - d.ay) * d.dy);
      const s = clamp(want, Math.min(MIN, room), room);
      st.box = { x: d.dx > 0 ? d.ax : d.ax - s, y: d.dy > 0 ? d.ay : d.ay - s, s };
    }
    draw();
  }

  function onUp() {
    st.drag = null;
  }

  // The kept square at 200 x 200. Big squares are halved in steps first, which looks sharper
  // than one big jump down.
  function result() {
    let c = st.src, { x, y, s } = st.box;
    while (s > OUT * 2) {
      const h = document.createElement('canvas');
      h.width = h.height = Math.round(s / 2);
      const hx = h.getContext('2d');
      hx.imageSmoothingQuality = 'high';
      hx.drawImage(c, x, y, s, s, 0, 0, h.width, h.height);
      c = h;
      x = y = 0;
      s = h.width;
    }
    const out = document.createElement('canvas');
    out.width = out.height = OUT;
    const ox = out.getContext('2d');
    ox.imageSmoothingQuality = 'high';
    ox.drawImage(c, x, y, s, s, 0, 0, OUT, OUT);
    return out.toDataURL('image/jpeg', 0.9);
  }

  function finish(value) {
    document.removeEventListener('keydown', onKey, true);
    st.ov.remove();
    const r = st.resolve;
    st = null;
    r(value);
  }

  function onClick(e) {
    const b = e.target.closest('[data-crop]');
    if (!b) return;
    const a = b.dataset.crop;
    if (a === 'rotate') {
      st.rot = (st.rot + 90) % 360;
      layout();
    } else if (a === 'cancel') finish(null);
    else if (a === 'use') finish(result());
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      e.preventDefault();
      finish(null);
    }
  }

  // For the tests: where the box is, in picture pixels, and the picture's size.
  const state = () => (st ? { W: st.W, H: st.H, k: st.k, rot: st.rot, box: { ...st.box } } : null);

  return { open, state };
})();
