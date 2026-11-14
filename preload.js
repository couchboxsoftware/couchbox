const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('cb', {
  init: invoke('init'),
  ready: () => ipcRenderer.send('app-ready'),
  chooseFolder: invoke('choose-folder'),
  setTmdbKey: invoke('set-tmdb-key'),
  setSettings: invoke('settings:set'),
  saveProfiles: invoke('profiles:save'),
  setLastProfile: invoke('profiles:last'),
  getProgress: invoke('progress:get'),
  setProgress: invoke('progress:set'),
  bulkProgress: invoke('progress:bulk'),
  getList: invoke('list:get'),
  toggleList: invoke('list:toggle'),
  setIntro: invoke('intro:set'),
  setKidsAllow: invoke('kids:set'),
  subtitle: invoke('subtitle'),
  convert: invoke('convert'),
  cancelConvert: invoke('convert:cancel'),
  searchMatches: invoke('match:search'),
  fixMatch: invoke('match:fix'),
  refresh: invoke('library:refresh'),
  clearMetadata: invoke('library:clear-meta'),
  openFolder: invoke('library:open'),
  fullscreen: invoke('fullscreen'),
  reveal: invoke('reveal'),
  openTmdb: invoke('open-tmdb'),
  updateState: invoke('update:state'),
  checkForUpdate: invoke('update:check'),
  downloadUpdate: invoke('update:download'),
  onUpdate: on('update'),
  onLibrary: on('library'),
  onStatus: on('status'),
  onConvertProgress: on('convert-progress'),
  onFullscreen: on('fullscreen'),
});
