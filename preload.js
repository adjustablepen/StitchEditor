const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  saveFiles: (opts) => ipcRenderer.invoke('save-files', opts),
  autosaveWrite: (data) => ipcRenderer.invoke('autosave-write', data),
  autosaveRead: () => ipcRenderer.invoke('autosave-read'),
  onUpdated: (cb) => ipcRenderer.on('app-updated', (e, info) => cb(info)),
  relaunch: () => ipcRenderer.invoke('relaunch'),
  updateCheck: (manual) => ipcRenderer.invoke('update-check', manual),
  updateSkip: (ver) => ipcRenderer.invoke('update-skip', ver),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  updateOpenPage: () => ipcRenderer.invoke('update-open-page'),
  version: () => ipcRenderer.invoke('app-version'),
});
