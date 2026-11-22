'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 极简 JSON 持久化：配置与 Cookie 分开存两份文件 */
function createStore(file) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    data = {};
  }

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  }

  return {
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback;
    },
    set(patch) {
      data = { ...data, ...patch };
      persist();
    },
    remove(key) {
      delete data[key];
      persist();
    },
    all() {
      return { ...data };
    },
  };
}

module.exports = { createStore };
