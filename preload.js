const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  saveFiles: (opts) => ipcRenderer.invoke('save-files', opts),
  autosaveWrite: (data) => ipcRenderer.invoke('autosave-write', data),
  autosaveRead: () => ipcRenderer.invoke('autosave-read'),
  projectsList: () => ipcRenderer.invoke('projects-list'),
  projectRead: (id) => ipcRenderer.invoke('project-read', id),
  projectWrite: (id, data, meta) => ipcRenderer.invoke('project-write', id, data, meta),
  projectDelete: (id) => ipcRenderer.invoke('project-delete', id),
  onUpdated: (cb) => ipcRenderer.on('app-updated', (e, info) => cb(info)),
  relaunch: () => ipcRenderer.invoke('relaunch'),
  updateCheck: (manual) => ipcRenderer.invoke('update-check', manual),
  updateSkip: (ver) => ipcRenderer.invoke('update-skip', ver),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  updateOpenPage: () => ipcRenderer.invoke('update-open-page'),
  version: () => ipcRenderer.invoke('app-version'),
});
