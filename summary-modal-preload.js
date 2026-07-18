const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('summaryTask', {
  ready: () => ipcRenderer.send('summary-task-ready'),
  close: () => ipcRenderer.send('close-summary-modal'),
  continueConversation: () => ipcRenderer.send('continue-summary-task'),
  onUpdate: (callback) => ipcRenderer.on('summary-task-update', (event, data) => callback(data)),
});
