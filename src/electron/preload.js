'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The renderer sees exactly this surface and nothing else. All privileged
 * work (network, shell, settings persistence) stays in the main process.
 */
contextBridge.exposeInMainWorld('aistatus', {
  getSnapshot: () => ipcRenderer.invoke('snapshot:get'),
  getHistory: () => ipcRenderer.invoke('history:get'),
  refresh: () => ipcRenderer.invoke('refresh'),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  quit: () => ipcRenderer.invoke('quit'),
  onSnapshot: (cb) => {
    const listener = (_event, snapshot) => cb(snapshot);
    ipcRenderer.on('snapshot', listener);
    return () => ipcRenderer.removeListener('snapshot', listener);
  },
  onSettings: (cb) => {
    const listener = (_event, s) => cb(s);
    ipcRenderer.on('settings', listener);
    return () => ipcRenderer.removeListener('settings', listener);
  },
});
