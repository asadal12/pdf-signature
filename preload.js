'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  isDesktop: true,
  getInitialFile: () => ipcRenderer.invoke('get-initial-file'),
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  fileExists: (p) => ipcRenderer.invoke('file-exists', p),
  saveDialog: (defaultPath, data) => ipcRenderer.invoke('save-dialog', defaultPath, data),
  writeFile: (p, data) => ipcRenderer.invoke('write-file', p, data),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  pathInfo: (p) => ipcRenderer.invoke('path-info', p),
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file) || null; } catch (_) { return null; } },
  setDirty: (v) => ipcRenderer.send('set-dirty', v),
  setTitle: (t) => ipcRenderer.send('set-title', t),
  forceClose: () => ipcRenderer.send('force-close'),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, p) => cb(p)),
  onCloseRequest: (cb) => ipcRenderer.on('close-request', () => cb()),
});
