// Small JSON file store with debounced, atomic writes.
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.data = structuredClone(defaults);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      this.data = Object.assign(this.data, raw);
    } catch (_) {
      /* first run or unreadable file: keep defaults */
    }
    this._timer = null;
  }

  save(immediate = false) {
    clearTimeout(this._timer);
    const write = () => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    };
    if (immediate) write();
    else this._timer = setTimeout(write, 400);
  }
}

module.exports = { JsonStore };
