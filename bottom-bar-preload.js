// bottom-bar-preload.js
// 底部输入条的 preload，暴露群发接口给页面
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bottomBar', {
  // 群发 Prompt 到所有当前激活的 AI
  sendPrompt: (prompt) => ipcRenderer.send('broadcast-prompt', { prompt }),
  // 一键新建会话
  newChat: () => ipcRenderer.send('broadcast-new-chat'),
  // 一键汇总对话
  triggerSummary: () => ipcRenderer.send('broadcast-summary'),
});
