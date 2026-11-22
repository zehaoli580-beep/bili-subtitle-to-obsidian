'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  parseVideo: (input) => invoke('video:parse', input),
  getSubtitles: (payload) => invoke('subtitle:fetch', payload),
  getSubtitleContent: (payload) => invoke('subtitle:content', payload),
  loginStatus: () => invoke('login:status'),
  qrGenerate: () => invoke('login:qr'),
  qrPoll: (key) => invoke('login:poll', key),
  setCookie: (text) => invoke('login:cookie', text),
  logout: () => invoke('login:logout'),
  getConfig: () => invoke('config:get'),
  saveConfig: (patch) => invoke('config:set', patch),
  chooseDir: () => invoke('dialog:chooseDir'),
  previewExport: (payload) => invoke('export:preview', payload),
  exportMarkdown: (payload) => invoke('export:write', payload),
  showInFolder: (target) => invoke('shell:show', target),
});
