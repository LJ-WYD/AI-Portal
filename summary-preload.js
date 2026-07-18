const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('summaryPanel', {
  // 关闭汇总侧边栏
  closeSummary: () => ipcRenderer.send('close-summary'),
  // 监听并接收多模型的对话数据
  onSummaryData: (callback) => ipcRenderer.on('summary-data', (event, data) => callback(data)),
  refreshSummary: () => ipcRenderer.send('refresh-summary'),
  retryModelSummary: (modelId) => ipcRenderer.send('retry-model-summary', { modelId }),
  prepareSummaryModel: (modelId) => ipcRenderer.send('prepare-summary-model', { modelId }),
  // 触发某特定 AI 进行总结提炼
  triggerAISummary: (targetModelId, prompt) => ipcRenderer.send('trigger-ai-summary', { targetModelId, prompt }),
  // 通知主进程侧边栏页面已加载完毕
  sendSummaryReady: () => ipcRenderer.send('summary-ready'),
});
