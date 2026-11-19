// Shared by the test scripts: mutes every window (so tests never play sounds out loud) and
// gives the settings tests start from: a normal 1400 x 860 window, no opening sounds, and no
// automatic conversion (it would rewrite the sample videos in place; conversion-check.js turns
// it back on for its own throwaway folder), and hint pop-ups already turned off (hints-check.js
// turns them on).
const { app } = require('electron');

app.on('web-contents-created', (_e, wc) => wc.setAudioMuted(true));

const HINTS_OFF = { 'plus-menu': 1, 'delete-bin': 1 };
const TEST_SETTINGS = { openMode: 'window', openingSounds: false, autoConvert: false, hintsOff: HINTS_OFF };

module.exports = { TEST_SETTINGS };
