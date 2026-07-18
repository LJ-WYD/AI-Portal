const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiPortal', {
  toggleModel: (modelId, visible) => ipcRenderer.send('toggle-model', { modelId, visible }),
  clearModelSessions: () => ipcRenderer.invoke('clear-model-sessions'),
  setTheme: (mode) => ipcRenderer.invoke('set-theme', mode),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  getModelHealth: () => ipcRenderer.invoke('get-model-health'),
  prevPage: () => ipcRenderer.send('prev-page'),
  nextPage: () => ipcRenderer.send('next-page'),
  onPageStatus: (callback) => ipcRenderer.on('page-status', (event, data) => callback(data)),
  onModelHealth: (callback) => ipcRenderer.on('model-health', (event, data) => callback(data)),
});
