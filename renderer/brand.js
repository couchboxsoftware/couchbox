/* Couchbox brand: the line-sofa mark. Used by the app, the splash and tools/render-icon.js. */
const BRAND = (() => {
  const orange = '#E8743B';
  // Sofa drawn on a 48x48 grid with round 3px strokes.
  const back = 'M11 23v-6a4 4 0 0 1 4-4h18a4 4 0 0 1 4 4v6';
  const body = 'M7 26a4 4 0 0 1 8 0v5h18v-5a4 4 0 0 1 8 0v8a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z';
  const legs = 'M11 36v4M37 36v4';
  const sofaPaths = (stroke, width, extra = '') =>
    `<g fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${extra}>` +
    `<path d="${back}" pathLength="1"/><path d="${body}" pathLength="1"/><path d="${legs}" pathLength="1"/></g>`;

  return {
    orange,
    paths: { back, body, legs },
    sofaPaths,
    // Inline logo mark for the app's top bar.
    icon: `<svg viewBox="5 9 38 34" aria-hidden="true" class="cb-icon">${sofaPaths(orange, 3)}</svg>`,
    // App icon tile (rendered to build/icon.png by tools/render-icon.js).
    tile: (size) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48">` +
      `<rect x="1" y="1" width="46" height="46" rx="11" fill="#141414"/>` +
      `<g transform="translate(24 26.5) scale(0.86) translate(-24 -26.5)">${sofaPaths(orange, 3.4)}</g></svg>`,
    wordmark: '<span class="cb-word">couch<b>box</b></span>',
  };
})();
if (typeof module !== 'undefined') module.exports = BRAND;
