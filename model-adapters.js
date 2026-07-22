const DEFAULT_RESPONSE_SELECTORS = [
  '.markdown',
  '.markdown-body',
  '.prose',
  '[class*="markdown"]',
];

const MODEL_ADAPTERS = Object.freeze({
  chatgpt: Object.freeze({
    label: 'ChatGPT',
    url: 'https://chatgpt.com',
    newChatUrl: 'https://chatgpt.com/',
    sendStrategy: 'chatgpt',
    composerSelectors: ['#prompt-textarea', '[contenteditable="true"][data-placeholder]', 'div[contenteditable="true"][role="textbox"]'],
    responseSelectors: ['.markdown.prose', '.markdown', '.agent-turn .markdown'],
  }),
  claude: Object.freeze({
    label: 'Claude',
    url: 'https://claude.ai',
    newChatUrl: 'https://claude.ai/new',
    sendStrategy: 'claude',
    composerSelectors: ['[aria-label="Write your prompt to Claude"]', '[role="textbox"][contenteditable="true"]', '[contenteditable="true"]'],
    responseSelectors: ['[data-testid*="assistant"] .prose', '[data-testid*="assistant"]', '[role="article"]', '.font-claude-message', '[class*="font-claude-message"]', '.prose'],
  }),
  gemini: Object.freeze({
    label: 'Gemini',
    url: 'https://gemini.google.com',
    newChatUrl: 'https://gemini.google.com/app',
    sendStrategy: 'gemini',
    composerSelectors: ['rich-textarea [contenteditable="true"]', 'div[role="textbox"][contenteditable="true"]', 'div[role="textbox"]'],
    responseSelectors: ['[id^="model-response-message-content"]', 'model-response message-content', 'message-content .message-content', 'message-content', '.message-content'],
  }),
  grok: Object.freeze({
    label: 'Grok',
    url: 'https://grok.com',
    newChatUrl: 'https://grok.com/',
    sendStrategy: 'grok',
    composerSelectors: ['div.tiptap[role="textbox"]', 'div.ProseMirror[contenteditable="true"]', 'div[role="textbox"][contenteditable="true"]'],
    responseSelectors: ['.prose', '.markdown', '[class*="message"] .markdown', 'article'],
  }),
  glm: Object.freeze({
    label: 'Zhipu AI',
    url: 'https://chatglm.cn',
    newChatUrl: 'https://chatglm.cn/',
    sendStrategy: 'generic',
    composerSelectors: ['textarea', 'div[contenteditable="true"]'],
    responseSelectors: ['.markdown-body', '.message-content'],
  }),
  qianwen: Object.freeze({
    label: 'Qwen',
    url: 'https://www.qianwen.com/',
    newChatUrl: 'https://www.qianwen.com/',
    sendStrategy: 'qianwen',
    composerSelectors: ['div[role="textbox"]', 'div[contenteditable="true"]'],
    responseSelectors: ['.markdown-body', '[class*="markdown"]', '.message-content'],
  }),
  deepseek: Object.freeze({
    label: 'DeepSeek',
    url: 'https://chat.deepseek.com',
    newChatUrl: 'https://chat.deepseek.com/',
    sendStrategy: 'generic',
    composerSelectors: ['textarea', 'div[contenteditable="true"]'],
    responseSelectors: ['.ds-markdown', '.markdown-body', '[class*="markdown"]', '.md-body', '.message-content'],
  }),
  doubao: Object.freeze({
    label: 'Doubao',
    url: 'https://www.doubao.com',
    newChatUrl: 'https://www.doubao.com/',
    sendStrategy: 'generic',
    composerSelectors: ['textarea', 'div[contenteditable="true"]'],
    responseSelectors: ['[class*="inner-item"]'],
  }),
  minimax: Object.freeze({
    label: 'Hailuo AI',
    url: 'https://www.hailuo.ai',
    newChatUrl: 'https://www.hailuo.ai/',
    sendStrategy: 'generic',
    composerSelectors: ['textarea', 'div[contenteditable="true"]'],
    responseSelectors: ['.markdown-body', '.message-content'],
  }),
  kimi: Object.freeze({
    label: 'Kimi',
    url: 'https://kimi.moonshot.cn',
    newChatUrl: 'https://kimi.moonshot.cn/',
    sendStrategy: 'generic',
    composerSelectors: ['textarea', 'div[contenteditable="true"]'],
    responseSelectors: ['.markdown-body', '.kimi-markdown', '.message-content'],
  }),
});

function getModelAdapter(modelId) {
  const adapter = MODEL_ADAPTERS[modelId];
  if (!adapter) throw new Error(`Unknown model adapter: ${modelId}`);
  return adapter;
}

module.exports = {
  DEFAULT_RESPONSE_SELECTORS,
  MODEL_ADAPTERS,
  getModelAdapter,
};
