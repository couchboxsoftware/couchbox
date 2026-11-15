// Shared by the test scripts: mutes every window (so tests never play sounds out loud) and
// gives the settings tests start from: a normal 1400 x 860 window, no opening sounds, and no
// automatic conversion (it would rewrite the sample videos in place; conversion-check.js turns
// it back on for its own throwaway folder).
const { app } = require('electron');

app.on('web-contents-created', (_e, wc) => wc.setAudioMuted(true));

const TEST_SETTINGS = { openMode: 'window', openingSounds: false, autoConvert: false };

module.exports = { TEST_SETTINGS };
