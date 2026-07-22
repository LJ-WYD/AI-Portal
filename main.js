const { app, BrowserWindow, BrowserView, ipcMain, nativeTheme, session } = require('electron');
if (require('electron-squirrel-startup')) app.quit();

const crypto = require('crypto');
const path = require('path');
const { DEFAULT_RESPONSE_SELECTORS, MODEL_ADAPTERS } = require('./model-adapters');
const { createHermesPortalBridge } = require('./hermes-portal-bridge');

app.setAppUserModelId('com.squirrel.AIPortal.AIPortal');

const TOP_HEIGHT    = 52;
const BOTTOM_HEIGHT = 65;

// ===== 所有 AI 服务配置 =====
const AI_CONFIGS = Object.freeze(Object.fromEntries(
  Object.entries(MODEL_ADAPTERS).map(([modelId, adapter]) => [modelId, {
    label: adapter.label,
    url: adapter.url,
  }])
));

let mainWindow    = null;
let bottomBarView = null;
const views = {};
let lastBroadcastPrompt = '';
const modelHealth = new Map();
let hermesPortalBridge = null;
const backgroundJobs = new Map();
let backgroundJobRunnerActive = false;
const BACKGROUND_JOB_RETENTION_MS = 30 * 60 * 1000;
// 默认仅显示前 3 个；用户可通过顶栏开关激活更多
let activeModels = ['chatgpt', 'claude', 'gemini'];

let currentPage = 0;
const MAX_PER_PAGE = 3;
const SIDE_WIDTH = 0;

let leftBtnView = null;
let rightBtnView = null;
let summaryView = null;
let summaryModalView = null;
let summaryTaskView = null;
let summaryTask = null;
let preparedSummaryView = null;
let preparedSummaryModel = null;
let preparedSummaryPromise = null;
let isSummaryVisible = false;
const MIN_PANE_WIDTH = 500;

function publishModelHealth(modelId, status, reason = '') {
  const next = { modelId, status, reason, checkedAt: Date.now() };
  modelHealth.set(modelId, next);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('model-health', next);
  return next;
}

function startHermesPortalBridge() {
  if (process.env.PORTAL_BRIDGE_ENABLED !== 'true' || hermesPortalBridge) return;

  const port = Number.parseInt(process.env.PORTAL_BRIDGE_PORT || '8765', 10);
  hermesPortalBridge = createHermesPortalBridge({
    getHealth: () => Object.fromEntries(modelHealth),
    createJob: process.env.PORTAL_BRIDGE_TOKEN ? createBackgroundJob : undefined,
    getJob: process.env.PORTAL_BRIDGE_TOKEN ? getBackgroundJob : undefined,
    token: process.env.PORTAL_BRIDGE_TOKEN || '',
    port: Number.isInteger(port) && port > 0 ? port : 8765,
  });
  hermesPortalBridge.start()
    .then(({ host, port: listeningPort }) => console.log(`Portal MCP Bridge listening at http://${host}:${listeningPort}`))
    .catch(error => {
      console.error('Portal MCP Bridge failed to start:', error.message);
      hermesPortalBridge = null;
    });
}

async function checkModelHealth(modelId, targetView = views[modelId]) {
  const adapter = MODEL_ADAPTERS[modelId];
  if (!adapter || !targetView || targetView.webContents.isDestroyed()) {
    return publishModelHealth(modelId, 'unavailable', '模型页面未打开');
  }

  try {
    const probe = await Promise.race([
      targetView.webContents.executeJavaScript(`(() => {
        const selectors = ${JSON.stringify(adapter.composerSelectors)};
        const composerFound = selectors.some(selector => {
          const element = document.querySelector(selector);
          return element && element.offsetParent !== null && !element.disabled && !element.readOnly;
        });
        const bodyText = (document.body?.innerText || '').slice(0, 400).toLowerCase();
        return { composerFound, readyState: document.readyState, bodyText };
      })()`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('健康检查超时')), 3500)),
    ]);

    if (probe.composerFound) return publishModelHealth(modelId, 'ready', '可发送消息');
    if (/sign in|log in|登录|登入/.test(probe.bodyText)) return publishModelHealth(modelId, 'needs-login', '需要完成登录');
    return publishModelHealth(modelId, 'loading', probe.readyState === 'complete' ? '等待输入框就绪' : '页面加载中');
  } catch (error) {
    return publishModelHealth(modelId, 'unavailable', error.message || '页面无法响应');
  }
}

function scheduleModelHealthCheck(modelId, targetView) {
  checkModelHealth(modelId, targetView);
  setTimeout(() => checkModelHealth(modelId, targetView), 1500);
  setTimeout(() => checkModelHealth(modelId, targetView), 4500);
}

function relayout() {
  if (!mainWindow) return;
  const [w, h] = mainWindow.getContentSize();
  const visible = activeModels.filter(id => views[id]);
  if (bottomBarView && !bottomBarView.webContents.isDestroyed()) {
    bottomBarView.webContents.send('active-model-count', visible.length);
  }
  const totalCount = visible.length;
  const needsPaging = totalCount > MAX_PER_PAGE;

  let pageVisible = [];
  let maxPage = 1;

  if (needsPaging) {
    maxPage = Math.ceil(totalCount / MAX_PER_PAGE);
    if (currentPage >= maxPage) {
      currentPage = maxPage - 1;
    }
    if (currentPage < 0) {
      currentPage = 0;
    }
    const startIndex = currentPage * MAX_PER_PAGE;
    pageVisible = visible.slice(startIndex, startIndex + MAX_PER_PAGE);
  } else {
    currentPage = 0;
    pageVisible = visible;
  }

  // 遍历所有 active 的模型，确定哪些应该添加显示，哪些应该隐藏
  visible.forEach(id => {
    const isShown = pageVisible.includes(id);
    if (isShown) {
      try {
        mainWindow.addBrowserView(views[id]);
      } catch (e) {}
    } else {
      try {
        mainWindow.removeBrowserView(views[id]);
      } catch (e) {}
    }
  });

  // 对当前可见的模型进行排版（由于 SIDE_WIDTH 设为 0，不再留侧边栏）
  pageVisible.forEach((id, i) => {
    const paneW = Math.floor(w / pageVisible.length);
    const x = i * paneW;
    const width = (i === pageVisible.length - 1) ? (w - x) : paneW;
    const height = h - TOP_HEIGHT - BOTTOM_HEIGHT;
    const bounds = { x, y: TOP_HEIGHT, width, height };

    views[id].setBounds(bounds);

    // 当面板宽度不足时，自动缩放页面内容以适应窄面板
    const zoom = bounds.width >= MIN_PANE_WIDTH ? 1.0 : Math.max(bounds.width / MIN_PANE_WIDTH, 0.35);
    views[id].webContents.setZoomFactor(zoom);
  });

  const pageStatusData = {
    currentPage,
    maxPage,
    needsPaging,
    totalCount
  };

  // 发送分页状态到渲染进程及两个导航视图
  mainWindow.webContents.send('page-status', pageStatusData);
  if (leftBtnView && leftBtnView.webContents) {
    leftBtnView.webContents.send('page-status', pageStatusData);
  }
  if (rightBtnView && rightBtnView.webContents) {
    rightBtnView.webContents.send('page-status', pageStatusData);
  }

  // 悬浮翻页按钮置顶排列
  if (needsPaging && leftBtnView && rightBtnView) {
    try { mainWindow.removeBrowserView(leftBtnView); } catch(e) {}
    try { mainWindow.removeBrowserView(rightBtnView); } catch(e) {}

    const btnW = 60;
    const btnH = 120;
    const btnY = Math.floor(TOP_HEIGHT + (h - TOP_HEIGHT - BOTTOM_HEIGHT - btnH) / 2);

    leftBtnView.setBounds({ x: 0, y: btnY, width: btnW, height: btnH });
    rightBtnView.setBounds({ x: w - btnW, y: btnY, width: btnW, height: btnH });

    mainWindow.addBrowserView(leftBtnView);
    mainWindow.addBrowserView(rightBtnView);
  } else {
    if (leftBtnView) { try { mainWindow.removeBrowserView(leftBtnView); } catch(e) {} }
    if (rightBtnView) { try { mainWindow.removeBrowserView(rightBtnView); } catch(e) {} }
  }

  if (summaryView && isSummaryVisible) {
    const panelW = 380;
    const panelH = h - TOP_HEIGHT - BOTTOM_HEIGHT;
    summaryView.setBounds({ x: w - panelW, y: TOP_HEIGHT, width: panelW, height: panelH });
  }

  if (summaryModalView) {
    summaryModalView.setBounds({ x: 0, y: 0, width: w, height: h });
  }
  layoutSummaryTaskWindow();

  if (bottomBarView) {
    mainWindow.removeBrowserView(bottomBarView);
    bottomBarView.setBounds({ x: 0, y: h - BOTTOM_HEIGHT, width: w, height: BOTTOM_HEIGHT });
    mainWindow.addBrowserView(bottomBarView);
  }
}

function createView(modelId) {
  const partitionSession = session.fromPartition(`persist:${modelId}`, { cache: true });
  const view = new BrowserView({
    webPreferences: {
      session: partitionSession,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    }
  });
  publishModelHealth(modelId, 'loading', '页面加载中');
  view.webContents.on('did-finish-load', () => scheduleModelHealthCheck(modelId, view));
  view.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    if (errorCode !== -3) publishModelHealth(modelId, 'unavailable', errorDescription || '页面加载失败');
  });
  view.webContents.on('render-process-gone', () => publishModelHealth(modelId, 'unavailable', '页面渲染进程已退出'));
  mainWindow.addBrowserView(view);
  view.webContents.loadURL(AI_CONFIGS[modelId].url);
  views[modelId] = view;
}

function createBottomBar(winWidth, winHeight) {
  bottomBarView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'bottom-bar-preload.js'),
    }
  });
  bottomBarView.setBounds({ x: 0, y: winHeight - BOTTOM_HEIGHT, width: winWidth, height: BOTTOM_HEIGHT });
  mainWindow.addBrowserView(bottomBarView);
  bottomBarView.webContents.on('did-finish-load', () => {
    bottomBarView.webContents.send('active-model-count', activeModels.filter(id => views[id]).length);
  });
  bottomBarView.webContents.loadFile('bottom-bar.html');
}

function createNavButtons() {
  const preloadPath = path.join(__dirname, 'renderer-preload.js');
  
  leftBtnView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath
    }
  });
  leftBtnView.setBackgroundColor('#00000000');
  leftBtnView.webContents.loadFile('nav-btn.html', { hash: 'left' });
  
  rightBtnView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath
    }
  });
  rightBtnView.setBackgroundColor('#00000000');
  rightBtnView.webContents.loadFile('nav-btn.html', { hash: 'right' });
}

// ===== 侧边栏管理与数据提取 =====
function createSummaryView(winWidth, winHeight) {
  if (summaryView) return;
  summaryView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'summary-preload.js'),
    }
  });
  summaryView.setBackgroundColor('#00000000'); // 配合 CSS 毛玻璃
  summaryView.webContents.loadFile('summary.html');
}

let animationTimer = null;
function animateSummaryView(targetX, onComplete) {
  if (!summaryView || !mainWindow) return;
  if (animationTimer) clearInterval(animationTimer);

  const bounds = summaryView.getBounds();
  const startX = bounds.x;
  const duration = 200; // 动画时长 200ms
  const startTime = Date.now();

  animationTimer = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // ease-out 缓动算法使得动画丝滑
    const easeProgress = 1 - Math.pow(1 - progress, 3);
    const currentX = Math.round(startX + (targetX - startX) * easeProgress);

    if (summaryView) {
      summaryView.setBounds({
        x: currentX,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      });
    }

    if (progress >= 1) {
      clearInterval(animationTimer);
      animationTimer = null;
      if (onComplete) onComplete();
    }
  }, 16);
}

function showSummary() {
  if (!mainWindow || isSummaryVisible) return;
  const [w, h] = mainWindow.getContentSize();
  const wasCreated = !summaryView;

  createSummaryView(w, h);

  const panelW = 380;
  const panelH = h - TOP_HEIGHT - BOTTOM_HEIGHT;

  // 初始放置于右边界外
  summaryView.setBounds({ x: w, y: TOP_HEIGHT, width: panelW, height: panelH });
  mainWindow.addBrowserView(summaryView);

  isSummaryVisible = true;
  animateSummaryView(w - panelW);
  if (!wasCreated) setTimeout(() => fetchAndSendSummaryData(), 250);
  const defaultTarget = activeModels.find(id => views[id]);
  if (defaultTarget) prepareSummaryTaskView(defaultTarget);
}

function hideSummary() {
  if (!mainWindow || !isSummaryVisible || !summaryView) return;
  const [w, h] = mainWindow.getContentSize();

  isSummaryVisible = false;
  animateSummaryView(w, () => {
    if (summaryView) {
      try { mainWindow.removeBrowserView(summaryView); } catch(e) {}
    }
  });
}

function extractLatestResponseScript(modelId) {
  const modelSelectors = MODEL_ADAPTERS[modelId]?.responseSelectors || DEFAULT_RESPONSE_SELECTORS;

  return `(() => {
    const selectors = ${JSON.stringify(modelSelectors)};
    const modelIdStr = ${JSON.stringify(modelId)};
    const providerFallbacks = {
      chatgpt: [
        '[data-message-author-role="assistant"] .markdown',
        '[data-message-author-role="assistant"]',
        '[data-testid*="conversation-turn"] .markdown'
      ],
      claude: [
        '[data-testid*="assistant"] .prose',
        '[data-testid*="assistant"]',
        'article'
      ],
      gemini: [
        '[id^="model-response-message-content"]',
        'model-response message-content',
        'message-content'
      ],
      grok: [
        '[data-testid*="assistant"] .prose',
        '[data-testid*="assistant"]',
        '.prose',
        '.markdown',
        'article'
      ]
    };
    const fallbacks = providerFallbacks[modelIdStr] || [];
    
    // 递归查找所有节点（支持穿透 Shadow DOM 和同源 iframe）
    function findNodes(root, selector) {
      let results = [];
      if (!root) return results;
      if (root.nodeType === Node.ELEMENT_NODE && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/i.test(root.tagName || '')) return results;
      
      if (root.querySelectorAll) {
        try {
          const matched = root.querySelectorAll(selector);
          results = results.concat(Array.from(matched));
        } catch (e) {}
      }
      
      const descendants = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
      if (root.shadowRoot) results = results.concat(findNodes(root.shadowRoot, selector));
      for (const child of descendants) {
        if (child.shadowRoot) results = results.concat(findNodes(child.shadowRoot, selector));
        if (child.tagName === 'IFRAME') {
          try {
            const doc = child.contentDocument || (child.contentWindow && child.contentWindow.document);
            if (doc) results = results.concat(findNodes(doc, selector));
          } catch (e) {}
        }
      }
      
      return results;
    }
    
    const allSelectors = [...selectors, ...fallbacks];

    // Claude 当前版使用语义 article + 隐藏标题区分用户与助手消息，旧的 prose 类名已不稳定。
    // 只接受明确标记为“Claude responded:”的文章，避免把用户消息或页面外壳误当回答。
    if (modelIdStr === 'claude') {
      const assistantArticles = Array.from(document.querySelectorAll('article, [role="article"]')).filter(article => {
        const marker = article.querySelector('h1, h2, h3, [role="heading"], [aria-label^="Claude responded:"]');
        const markerText = ((marker && (marker.innerText || marker.textContent || marker.getAttribute('aria-label'))) || '').trim();
        return /^Claude responded:/i.test(markerText);
      });
      if (assistantArticles.length) {
        const clone = assistantArticles[assistantArticles.length - 1].cloneNode(true);
        clone.querySelectorAll('button, [role="toolbar"], h1, h2, h3, script, style').forEach(item => item.remove());
        const claudeLines = (clone.innerText || clone.textContent || '').split(/\\r?\\n/)
          .map(line => line.trim()).filter(Boolean);
        const dedupedClaudeLines = claudeLines.filter((line, index) => index === 0 || line !== claudeLines[index - 1]);
        if (dedupedClaudeLines.length) return dedupedClaudeLines.join('\\n');
      }
    }
    
    // 免责声明/配置小字/联网搜索折叠栏黑名单
    const blacklist = [
      'can make mistakes', 
      'double-check responses', 
      '免责声明', 
      '可能存在偏差', 
      '内容由 ai',
      '内容为 ai',
      'ai 可能会犯错',
      '请核实重要信息',
      'sonnet',
      'haiku',
      'opus',
      'gemini',
      'gpt-4',
      'gpt-3',
      'searched the web',
      'searching the web',
      'searched 1 web',
      'session limit',
      'upgrade',
      'out of free messages',
      'message limit',
      '内容仅供参考',
      '文件数量',
      '文件类型',
      '千问思考',
      'ai生视频',
      'ai生图'
    ];
    
    const debugLogs = [];
    
    // 判断一个节点是否是无效的，同时记录其具体过滤原因
    function isInvalidNode(el, sel) {
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/i.test(el.tagName || '') || el.closest('script, style, noscript, template')) {
        return true;
      }
      const rect = el.getBoundingClientRect();
      const visible = el.offsetWidth > 0 && el.offsetHeight > 0 && rect.width > 0 && rect.height > 0;
      const text = (el.innerText || el.textContent || '').trim();
      // 使用双反斜杠，在模板字符串中正确转义为 \s
      const len = text.replace(/\\s/g, '').length;
      const lowerText = text.toLowerCase();
      if (/^(\\(?function\\s|window\\.__oai_|requestanimationframe\\(|performance\\.mark\\()/i.test(text) ||
          lowerText.includes('window.__oai_') || lowerText.includes('composer.first-prompt-input')) {
        debugLogs.push({ sel, len, reason: 'runtime_script' });
        return true;
      }
      
      // 豆包专属过滤：若不在消息项内，或是用户本人的发送消息，一律过滤
      if (modelIdStr === 'doubao') {
        const innerItem = el.closest ? el.closest('[class*="inner-item"]') : null;
        if (!innerItem) {
          debugLogs.push({ sel, len, reason: 'doubao_not_in_inner_item' });
          return true;
        }
        const classStr = typeof innerItem.className === 'string' ? innerItem.className.toLowerCase() : '';
        const html = innerItem.innerHTML || '';
        if (classStr.includes('justify-end') || classStr.includes('justify_end') || html.includes('bg-g-send-msg-bubble-bg')) {
          debugLogs.push({ sel, len, reason: 'doubao_user_msg' });
          return true;
        }
      }
      
      // 检查当前节点或其祖先是否为真正的输入框
      // 避免因为内部包含了可编辑的代码块（如代码高亮组件）而误杀整个外部 of AI 回答容器
      let isEditable = false;
      let curr = el;
      while (curr) {
        if (curr.nodeName === 'TEXTAREA' || curr.nodeName === 'INPUT') {
          const type = (curr.type || 'text').toLowerCase();
          if (['text', 'search', 'email', 'url', 'tel', 'password'].includes(type) && !curr.readOnly && !curr.disabled) {
            isEditable = true;
            break;
          }
        }
        if (curr.isContentEditable || curr.hasAttribute('contenteditable') || curr.getAttribute('role') === 'textbox') {
          isEditable = true;
          break;
        }
        curr = curr.parentElement;
      }
      
      if (isEditable) {
        debugLogs.push({ sel, len, reason: 'is_editable' });
        return true;
      }
      
      // 短确认（如 OK）也是合法回答。依靠模型专用容器过滤 UI 噪声，而不是长度猜测。
      const minimumLength = 2;
      if (len < minimumLength) {
        debugLogs.push({ sel, len, reason: 'too_short' });
        return true;
      }
      
      if (len < 200) {
        // 黑名单必须用含空格的原始小写文本匹配（多词短语含空格）
        const foundBlacklist = blacklist.find(kw => lowerText.includes(kw));
        if (foundBlacklist) {
          debugLogs.push({ sel, len, reason: 'blacklist_' + foundBlacklist });
          return true;
        }
      }
      
      debugLogs.push({ sel, len, reason: 'valid', snippet: text.slice(0, 15) });
      return false;
    }

    let content = '';
    
    for (const sel of allSelectors) {
      const allNodes = findNodes(document, sel);
      const validNodes = allNodes.filter(el => !isInvalidNode(el, sel));
      
      if (validNodes.length > 0) {
        const lastNode = validNodes[validNodes.length - 1];
        if (sel.includes('font-claude-message') && lastNode.parentElement) {
          content = lastNode.parentElement.innerText || lastNode.parentElement.textContent || '';
        } else if (modelIdStr === 'doubao') {
          // 豆包特殊清洗：克隆并清洗噪音元素（头像、复制等按钮、深度思考框）
          const clone = lastNode.cloneNode(true);
          clone.querySelectorAll("button, [role='button'], svg, [class*=invisible]").forEach(item => item.remove());
          clone.querySelectorAll("[class*=thinking-box]").forEach(item => item.remove());
          content = clone.innerText || clone.textContent || '';
        } else {
          const clone = lastNode.cloneNode(true);
          clone.querySelectorAll('script, style, noscript, template, button, [role="toolbar"]').forEach(item => item.remove());
          content = clone.innerText || clone.textContent || '';
        }
        if (content.trim()) {
          break;
        }
      }
    }
    
    if (!content.trim()) {
      // 提取出所有有代表性的日志摘要，转化为极简的单行字符串
      const summaryLogs = debugLogs.map(log => {
        if (log.reason === 'valid') {
          return \`\${log.sel}(\${log.len}c:\${log.snippet})\`;
        }
        return \`\${log.sel}(\${log.len}c:\${log.reason})\`;
      }).join(' | ');
      return "DEBUG_INFO: " + (summaryLogs || 'No elements found');
    }
    
    const lines = content.split(/\\r?\\n/).map(line => line.trim()).filter(Boolean);
    if (modelIdStr === 'claude' && lines.length > 1 && /^claude responded:/i.test(lines[0])) lines.shift();
    const deduped = lines.filter((line, index) => index === 0 || line !== lines[index - 1]);
    return deduped.join('\\n').trim();
  })();`;
}

// ===== 通用 Prompt 注入脚本（适配大多数聊天 UI）=====
function buildGenericScript(prompt) {
  return `(() => {
    const p = ${JSON.stringify(prompt)};

    // 优先尝试 React 控制的 textarea
    const textareas = Array.from(document.querySelectorAll('textarea'))
      .filter(el => !el.disabled && !el.readOnly && el.offsetParent !== null && el.offsetWidth > 50);

    if (textareas.length) {
      const ta = textareas.sort((a, b) => b.offsetHeight - a.offsetHeight)[0];
      try {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, p);
      } catch(e) { ta.value = p; }
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      ta.focus();
      setTimeout(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
          !b.disabled && /(send|发送|提交)/i.test((b.textContent || '') + (b.getAttribute('aria-label') || ''))
        ) || document.querySelector('button[type="submit"]');
        if (btn) btn.click();
        else ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }, 500);
      return;
    }

    // 再尝试 contenteditable div（ProseMirror / lexical 等富文本编辑器）
    const eds = Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .filter(el => el.offsetParent !== null && el.offsetWidth > 50);
    if (eds.length) {
      const ed = eds.sort((a, b) => b.offsetWidth - a.offsetWidth)[0];
      ed.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, p);
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
          !b.disabled && /(send|发送|提交)/i.test((b.textContent || '') + (b.getAttribute('aria-label') || ''))
        ) || document.querySelector('button[type="submit"]');
        if (btn) btn.click();
        else ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }, 500);
    }
  })();`;
}

// ===== 通用 新建会话 注入脚本 =====
function buildNewChatScript(modelId) {
  const targetUrl = MODEL_ADAPTERS[modelId]?.newChatUrl || 'about:blank';

  return `(() => {
    const keywords = ['New chat', 'New Chat', '新建对话', '新建會話', '新建会话', '新对话', '新会话', '开启新对话', '开始新对话'];
    const clickableElements = Array.from(document.querySelectorAll('a, button, div[role="button"], span'))
      .filter(el => {
        if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;
        const text = el.textContent ? el.textContent.trim() : '';
        const label = el.getAttribute('aria-label') || '';
        return keywords.some(kw => text.includes(kw) || label.includes(kw));
      });

    if (clickableElements.length > 0) {
      clickableElements.sort((a, b) => {
        const aScore = (a.tagName === 'A' || a.tagName === 'BUTTON') ? 1 : 0;
        const bScore = (b.tagName === 'A' || b.tagName === 'BUTTON') ? 1 : 0;
        if (aScore !== bScore) return bScore - aScore;
        return a.textContent.length - b.textContent.length;
      });
      try {
        clickableElements[0].click();
        return;
      } catch (e) {
        console.error('点击新建会话 DOM 节点失败', e);
      }
    }

    const targetUrl = ${JSON.stringify(targetUrl)};
    if (targetUrl !== 'about:blank') {
      window.location.href = targetUrl;
    }
  })();`;
}

// ===== 注入 Prompt 并自动发送的通用控制器 =====
function injectPromptIntoModel(modelId, prompt, targetView) {
  const view = targetView || views[modelId];
  if (!view) return;

  const chatgptScript = `new Promise((resolve) => {
    let attempts = 0;
    const sendWhenReady = () => {
      const editor = document.querySelector('#prompt-textarea')
        || document.querySelector('[contenteditable="true"][data-placeholder]')
        || document.querySelector('div[contenteditable="true"][role="textbox"]');
      if (!editor) {
        if (++attempts < 30) setTimeout(sendWhenReady, 250);
        else resolve(false);
        return;
      }
      editor.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, ${JSON.stringify(prompt)});
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(prompt)} }));
      setTimeout(() => {
        const btn = document.querySelector('button[data-testid="send-button"]')
          || document.querySelector('button[aria-label="Send prompt"]')
          || document.querySelector('[data-testid="fruitjuice-send-button"]');
        if (btn && !btn.disabled) btn.click();
        else editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        resolve(true);
      }, 350);
    };
    sendWhenReady();
  });`;

  const claudeScript = `new Promise((resolve) => {
    const ed = document.querySelector('[contenteditable="true"]');
    if (!ed) { resolve(false); return; }
    ed.focus();
    ed.innerHTML = '<p>' + ${JSON.stringify(prompt)} + '</p>';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    let attempts = 0;
    const clickSend = () => {
      const btn = document.querySelector('button[aria-label="Send Message"], button[aria-label="Send message"]')
        || document.querySelector('button[type="submit"]')
        || document.querySelector('button[data-testid*="send" i]')
        || Array.from(document.querySelectorAll('button')).find(button => {
          const label = (button.getAttribute('aria-label') || '') + ' ' + (button.textContent || '');
          return /send message/i.test(label) && button.offsetParent !== null;
        })
        || (() => {
          const container = ed.closest('form') || ed.parentElement?.parentElement || ed.parentElement;
          const localButtons = container ? Array.from(container.querySelectorAll('button')) : [];
          return localButtons.reverse().find(button => button.offsetParent !== null && !button.disabled);
        })();
      if (btn && !btn.disabled) { btn.click(); resolve(true); return; }
      if (++attempts < 20) setTimeout(clickSend, 200);
      else {
        ed.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
        }));
        resolve(true);
      }
    };
    setTimeout(clickSend, 200);
  });`;

  const geminiScript = `new Promise((resolve) => {
    const promptText = ${JSON.stringify(prompt)};
    let attempts = 0;
    const findComposer = () => Array.from(document.querySelectorAll(
      'rich-textarea [contenteditable="true"], div[role="textbox"][contenteditable="true"], div[contenteditable="true"], textarea'
    )).find(element => element.offsetParent !== null && !element.disabled && !element.readOnly);
    const findSendButton = () => Array.from(document.querySelectorAll('button')).find(button => {
      if (button.disabled || button.offsetParent === null) return false;
      const label = (button.getAttribute('aria-label') || '') + ' ' + (button.textContent || '');
      return /send message|send|发送|提交/i.test(label);
    });
    const sendWhenReady = () => {
      const box = findComposer();
      if (!box) {
        if (++attempts < 30) setTimeout(sendWhenReady, 250);
        else resolve(false);
        return;
      }
      box.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(box);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('delete', false, null);
      let sendAttempts = 0;
      const clickSend = () => {
        const button = findSendButton();
        if (button) { button.click(); resolve(true); return; }
        if (++sendAttempts < 12) setTimeout(clickSend, 200);
        else box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })), resolve(true);
      };
      const insertPromptInChunks = async () => {
        const chunkSize = 2400;
        for (let offset = 0; offset < promptText.length; offset += chunkSize) {
          const chunk = promptText.slice(offset, offset + chunkSize);
          document.execCommand('insertText', false, chunk);
          box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: chunk }));
          await new Promise(done => setTimeout(done, 35));
        }
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        setTimeout(clickSend, 450);
      };
      insertPromptInChunks();
    };
    sendWhenReady();
  });`;

  const qianwenScript = `(() => {
    const box = document.querySelector('div[role="textbox"]') || document.querySelector('div[contenteditable="true"]');
    if (!box) return;
    
    box.focus();
    
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(box);
    selection.removeAllRanges();
    selection.addRange(range);
    
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, ${JSON.stringify(prompt)});
    
    const dataObj = { bubbles: true, cancelable: true, inputType: 'insertText', data: ${JSON.stringify(prompt)} };
    box.dispatchEvent(new InputEvent('beforeinput', dataObj));
    box.dispatchEvent(new InputEvent('input', dataObj));
    
    setTimeout(() => {
      const btn = document.querySelector('button[aria-label="发送消息"]')
        || document.querySelector('button[aria-label*="发送"]')
        || Array.from(document.querySelectorAll('button')).find(b => /(发送消息|发送|submit|send)/i.test(b.textContent || b.getAttribute('aria-label') || ''));
      
      if (btn) {
        btn.removeAttribute('disabled');
        btn.disabled = false;
        btn.click();
      } else {
        const enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        });
        box.dispatchEvent(enterEvent);
      }
    }, 300);
  })();`;

  const grokScript = `(() => {
    const editor = document.querySelector('div.tiptap[role="textbox"]')
      || document.querySelector('div.ProseMirror[contenteditable="true"]')
      || document.querySelector('div[role="textbox"][contenteditable="true"]');
      
    if (!editor) return;
    
    editor.focus();
    
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, ${JSON.stringify(prompt)});
    
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: ${JSON.stringify(prompt)} }));
    
    setTimeout(() => {
      let btn = document.querySelector('button[aria-label="提交"]')
        || document.querySelector('button[aria-label="Submit"]')
        || document.querySelector('form button[type="submit"]');
      let container = editor.parentElement;
      
      for (let i = 0; !btn && i < 6 && container; i++) {
        const localBtns = Array.from(container.querySelectorAll('button'));
        if (localBtns.length > 0) {
          const filtered = localBtns.filter(b => {
            const label = (b.getAttribute('aria-label') || '');
            return !label.includes('附件') && !label.includes('模型选择') && 
                   !label.includes('听写') && !label.includes('语音') &&
                   !label.includes('搜索') && !label.includes('历史') &&
                   !label.includes('侧边栏') &&
                   !label.includes('Attach') && !label.includes('Model') &&
                   !label.includes('Dictation') && !label.includes('Voice') &&
                   !label.includes('Search') && !label.includes('History') &&
                   !label.includes('Sidebar');
          });
          if (filtered.length > 0) {
            btn = filtered[filtered.length - 1];
          }
          break;
        }
        container = container.parentElement;
      }
      
      if (btn) {
        btn.removeAttribute('disabled');
        btn.disabled = false;
        btn.click();
      } else {
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
    }, 400);
  })();`;

  const specificScripts = { chatgpt: chatgptScript, claude: claudeScript, gemini: geminiScript, qianwen: qianwenScript, grok: grokScript };
  const strategy = MODEL_ADAPTERS[modelId]?.sendStrategy || 'generic';
  const script = specificScripts[strategy] || buildGenericScript(prompt);
  return view.webContents.executeJavaScript(script).catch(error => {
    console.error(error);
    return false;
  });
}

async function sendPromptWithRetry(modelId, prompt, targetView = views[modelId]) {
  const maxAttempts = 2;
  const label = AI_CONFIGS[modelId]?.label || modelId;

  if (!targetView || targetView.webContents.isDestroyed()) {
    publishModelHealth(modelId, 'unavailable', '模型页面未打开，无法发送');
    return { ok: false, reason: '模型页面未打开' };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const health = await checkModelHealth(modelId, targetView);
    if (health.status === 'needs-login') {
      return { ok: false, reason: `${label} 需要完成登录` };
    }
    if (health.status === 'unavailable') {
      return { ok: false, reason: health.reason || `${label} 页面不可用` };
    }
    if (health.status !== 'ready') {
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1200));
        continue;
      }
      return { ok: false, reason: `${label} 输入框尚未就绪` };
    }

    publishModelHealth(modelId, 'ready', `正在发送（${attempt}/${maxAttempts}）`);
    try {
      const injected = await Promise.race([
        injectPromptIntoModel(modelId, prompt, targetView),
        new Promise((_, reject) => setTimeout(() => reject(new Error('发送操作超时')), 12000)),
      ]);
      if (injected !== false) {
        publishModelHealth(modelId, 'ready', '消息已发送');
        return { ok: true, attempt };
      }
    } catch (error) {
      if (attempt === maxAttempts) {
        publishModelHealth(modelId, 'unavailable', error.message || '发送失败');
        return { ok: false, reason: error.message || '发送失败' };
      }
    }

    if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 800));
  }

  publishModelHealth(modelId, 'unavailable', '未找到可用输入框，已重试两次');
  return { ok: false, reason: '未找到可用输入框' };
}

function publicBackgroundJob(job) {
  if (!job) return null;
  const completedResults = job.results.filter(result => result.status === 'complete' || result.status === 'partial');
  const failedResults = job.results.filter(result => result.status === 'error');
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    modelIds: job.modelIds,
    results: job.results.map(result => ({ ...result })),
    participatingModels: completedResults.map(result => ({ id: result.modelId, label: result.label, status: result.status })),
    unavailableModels: failedResults.map(result => ({ id: result.modelId, label: result.label, reason: result.error || '任务未完成' })),
    error: job.error || '',
  };
}

function getBackgroundJob(jobId) {
  return publicBackgroundJob(backgroundJobs.get(jobId));
}

function createBackgroundJob({ prompt, modelIds, userId, channel, conversationId }) {
  const requested = Array.isArray(modelIds) ? modelIds : [];
  const available = requested.filter(modelId => AI_CONFIGS[modelId]);
  const fallback = activeModels.filter(modelId => AI_CONFIGS[modelId]);
  const selectedModels = (available.length ? available : fallback).slice(0, 4);
  if (!selectedModels.length) throw new Error('没有可用于后台任务的模型');

  const job = {
    id: crypto.randomUUID(),
    prompt,
    userId,
    channel,
    conversationId,
    modelIds: selectedModels,
    status: 'queued',
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    results: [],
    error: '',
  };
  backgroundJobs.set(job.id, job);
  setTimeout(() => backgroundJobs.delete(job.id), BACKGROUND_JOB_RETENTION_MS).unref?.();
  processBackgroundJobs();
  return publicBackgroundJob(job);
}

async function waitForBackgroundResponse(taskView, modelId) {
  let previous = '';
  let stableReads = 0;
  let diagnostic = '';
  for (let attempt = 1; attempt <= 24; attempt++) {
    try {
      const text = await Promise.race([
        taskView.webContents.executeJavaScript(extractLatestResponseScript(modelId)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('页面响应超时')), 2200)),
      ]);
      const normalized = typeof text === 'string' && !text.startsWith('DEBUG_INFO:') ? text.trim() : '';
      if (typeof text === 'string' && text.startsWith('DEBUG_INFO:')) diagnostic = text.slice(0, 1200);
      if (normalized && normalized.length > 12) {
        stableReads = normalized === previous ? stableReads + 1 : 0;
        previous = normalized;
        if (stableReads >= 2) return { text: normalized, complete: true };
      }
    } catch (_) {}
    await delay(1800);
  }
  return { text: previous, complete: false, diagnostic };
}

async function sendPromptInBackground(modelId, prompt, taskView) {
  const ready = await waitForTaskComposer(modelId, taskView);
  if (!ready) throw new Error('输入框未就绪');

  if (modelId === 'chatgpt') {
    taskView.webContents.focus();
    const sent = await taskView.webContents.executeJavaScript(`new Promise(resolve => {
      const prompt = ${JSON.stringify(prompt)};
      let attempts = 0;
      const findEditor = () => Array.from(document.querySelectorAll('#prompt-textarea, [contenteditable="true"][data-placeholder], div[contenteditable="true"][role="textbox"]'))
        .find(element => element.offsetParent !== null && !element.disabled && !element.readOnly);
      const send = () => {
        const editor = findEditor();
        if (!editor) {
          if (++attempts < 40) return setTimeout(send, 250);
          return resolve({ ok: false, reason: 'composer_not_ready' });
        }
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, prompt);
        editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: prompt }));
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
        let clicks = 0;
        const clickSend = () => {
          const button = document.querySelector('button[data-testid="send-button"]')
            || document.querySelector('button[aria-label="Send prompt"]')
            || document.querySelector('[data-testid="fruitjuice-send-button"]');
          if (button && !button.disabled) {
            button.click();
            return setTimeout(() => resolve({ ok: !((editor.innerText || editor.textContent || '').trim()), reason: 'button_click' }), 800);
          }
          if (++clicks < 24) return setTimeout(clickSend, 200);
          resolve({ ok: false, reason: button ? 'send_button_disabled' : 'send_button_missing' });
        };
        setTimeout(clickSend, 350);
      };
      send();
    })`);
    if (!sent?.ok) throw new Error(`ChatGPT 发送失败：${sent?.reason || 'unknown'}`);
    return;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const injected = await Promise.race([
      injectPromptIntoModel(modelId, prompt, taskView),
      new Promise((_, reject) => setTimeout(() => reject(new Error('发送操作超时')), 12000)),
    ]);
    if (injected !== false) return;
    await delay(900);
  }
  throw new Error('未能注入问题');
}

async function getBackgroundTaskDiagnostics(taskView, modelId, prompt) {
  try {
    return await taskView.webContents.executeJavaScript(`(() => {
      const editor = document.querySelector('#prompt-textarea')
        || document.querySelector('[contenteditable="true"][data-placeholder]')
        || document.querySelector('div[contenteditable="true"][role="textbox"]');
      const button = document.querySelector('button[data-testid="send-button"]')
        || document.querySelector('button[aria-label="Send prompt"]')
        || document.querySelector('[data-testid="fruitjuice-send-button"]');
      const bodyText = (document.body?.innerText || '').slice(0, 5000);
      return {
        modelId: ${JSON.stringify(modelId)},
        url: location.href,
        readyState: document.readyState,
        promptVisible: bodyText.includes(${JSON.stringify(prompt)}),
        composerVisible: !!(editor && editor.offsetParent !== null),
        sendButtonFound: !!button,
        sendButtonDisabled: button ? !!button.disabled : null,
        assistantTurns: document.querySelectorAll('[data-message-author-role="assistant"]').length,
      };
    })()`);
  } catch (error) {
    return { diagnosticError: error.message || '诊断读取失败' };
  }
}

function createBackgroundTaskWindow(modelId) {
  const taskSession = session.fromPartition(`persist:${modelId}`, { cache: true });
  const taskWindow = new BrowserWindow({
    show: false,
    title: `AI Portal 后台任务 · ${AI_CONFIGS[modelId].label}`,
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    autoHideMenuBar: true,
    webPreferences: {
      session: taskSession,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  taskWindow.webContents.setBackgroundThrottling(false);
  return taskWindow;
}

async function prepareBackgroundTask(job, modelId) {
  const taskWindow = createBackgroundTaskWindow(modelId);
  const startedAt = Date.now();
  try {
    await taskWindow.webContents.loadURL(AI_CONFIGS[modelId].newChatUrl || AI_CONFIGS[modelId].url);
    // Each provider runs in its own real BrowserWindow. Prompts are injected one by one below,
    // then all windows generate concurrently without replacing any Portal pane.
    taskWindow.show();
    return { modelId, taskWindow, startedAt };
  } catch (error) {
    try { taskWindow.destroy(); } catch (_) {}
    return {
      modelId,
      label: AI_CONFIGS[modelId].label,
      status: 'error',
      answer: '',
      error: error.message || '任务窗口加载失败',
      startedAt,
      completedAt: Date.now(),
    };
  }
}

async function injectBackgroundTask(job, task) {
  const { modelId, taskWindow, startedAt } = task;
  try {
    taskWindow.focus();
    await waitForTaskComposer(modelId, taskWindow);
    await sendPromptInBackground(modelId, job.prompt, taskWindow);
    return task;
  } catch (error) {
    try { taskWindow.destroy(); } catch (_) {}
    return {
      modelId,
      label: AI_CONFIGS[modelId].label,
      status: 'error',
      answer: '',
      error: error.message || '任务问题注入失败',
      startedAt,
      completedAt: Date.now(),
    };
  }
}

async function collectBackgroundTask(job, task) {
  const { modelId, taskWindow, startedAt } = task;
  try {
    const response = await waitForBackgroundResponse(taskWindow, modelId);
    if (!response.text) {
      const pageState = await getBackgroundTaskDiagnostics(taskWindow, modelId, job.prompt);
      throw new Error(`未获取到模型回答：${JSON.stringify({ response: response.diagnostic || '', pageState }).slice(0, 1800)}`);
    }
    return {
      modelId,
      label: AI_CONFIGS[modelId].label,
      status: response.complete ? 'complete' : 'partial',
      answer: response.text,
      startedAt,
      completedAt: Date.now(),
    };
  } catch (error) {
    return {
      modelId,
      label: AI_CONFIGS[modelId].label,
      status: 'error',
      answer: '',
      error: error.message || '后台任务失败',
      startedAt,
      completedAt: Date.now(),
    };
  } finally {
    try { taskWindow.destroy(); } catch (_) {}
  }
}

async function runBackgroundJob(job) {
  job.status = 'running';
  job.startedAt = Date.now();
  const prepared = await Promise.all(job.modelIds.map(modelId => prepareBackgroundTask(job, modelId)));
  const readyTasks = prepared.filter(task => task.taskWindow);
  job.results.push(...prepared.filter(task => !task.taskWindow));

  // Inject sequentially because browser editors need foreground focus, but do not wait for
  // generation here: every successfully injected provider generates in parallel afterward.
  const generationTasks = [];
  for (const task of readyTasks) {
    const injected = await injectBackgroundTask(job, task);
    if (injected.taskWindow) generationTasks.push(injected);
    else job.results.push(injected);
  }
  const generated = await Promise.all(generationTasks.map(task => collectBackgroundTask(job, task)));
  job.results.push(...generated);
  const successful = job.results.filter(result => result.status !== 'error');
  job.status = successful.length === job.modelIds.length ? 'complete' : successful.length ? 'partial' : 'error';
  job.error = job.status === 'error' ? '所有后台模型任务均失败' : '';
  job.completedAt = Date.now();
}

async function processBackgroundJobs() {
  if (backgroundJobRunnerActive) return;
  backgroundJobRunnerActive = true;
  try {
    while (true) {
      const nextJob = [...backgroundJobs.values()].find(job => job.status === 'queued');
      if (!nextJob) break;
      await runBackgroundJob(nextJob);
    }
  } finally {
    backgroundJobRunnerActive = false;
  }
}

// ===== IPC：显示/隐藏分栏 =====
ipcMain.on('toggle-model', (event, { modelId, visible }) => {
  if (visible) {
    if (!activeModels.includes(modelId)) activeModels.push(modelId);
    if (!views[modelId]) createView(modelId);
    else mainWindow.addBrowserView(views[modelId]);
  } else {
    activeModels = activeModels.filter(id => id !== modelId);
    if (views[modelId]) mainWindow.removeBrowserView(views[modelId]);
    publishModelHealth(modelId, 'inactive', '模型未启用');
  }
  relayout();
});

ipcMain.handle('get-model-health', () => Object.fromEntries(modelHealth));

ipcMain.on('prev-page', () => {
  if (currentPage > 0) {
    currentPage--;
    relayout();
  }
});

ipcMain.on('next-page', () => {
  const visible = activeModels.filter(id => views[id]);
  const maxPage = Math.ceil(visible.length / MAX_PER_PAGE);
  if (currentPage < maxPage - 1) {
    currentPage++;
    relayout();
  }
});

// ===== IPC：一键新建会话 =====
ipcMain.on('broadcast-new-chat', (event) => {
  // 新建会话时，自动关闭并消除当前展示的汇总展板状态（防止手动刺激前已稳定的页面数据在重载期间指向旧内容）
  if (summaryView && !summaryView.webContents.isDestroyed()) {
    try { mainWindow.removeBrowserView(summaryView); } catch (e) {}
    summaryView = null;
  }
  isSummaryVisible = false;

  activeModels.forEach(modelId => {
    const view = views[modelId];
    if (!view) return;
    const script = buildNewChatScript(modelId);
    view.webContents.executeJavaScript(script).catch(console.error);
  });
});

// ===== IPC：群发 Prompt =====
ipcMain.on('broadcast-prompt', (event, { prompt }) => {
  lastBroadcastPrompt = prompt;
  activeModels.forEach(modelId => {
    sendPromptWithRetry(modelId, prompt);
  });
});

// ===== 提取各模型数据并发送给侧边栏 =====
function fetchAndSendLegacySummaryData() {
  const visible = activeModels.filter(id => views[id]);
  const contents = {};
  let completedCount = 0;

  if (visible.length === 0) {
    if (summaryView && !summaryView.webContents.isDestroyed()) {
      summaryView.webContents.send('summary-data', { activeModels: [], contents: {} });
    }
    return;
  }

  visible.forEach(modelId => {
    const view = views[modelId];
    if (!view) {
      completedCount++;
      if (completedCount === visible.length) sendDataToSummaryView();
      return;
    }

    const script = extractLatestResponseScript(modelId);
    let runScriptPromise;
    try {
      runScriptPromise = view.webContents.executeJavaScript(script);
    } catch (e) {
      runScriptPromise = Promise.reject(e);
    }
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('executeJavaScript timeout')), 2000);
    });

    Promise.race([runScriptPromise, timeoutPromise])
      .then(text => {
        contents[modelId] = text;
      })
      .catch(err => {
        console.error(`抓取 ${modelId} 回复失败/超时:`, err);
        contents[modelId] = '';
      })
      .finally(() => {
        completedCount++;
        if (completedCount === visible.length) {
          sendDataToSummaryView();
        }
      });
  });

  function sendDataToSummaryView() {
    if (summaryView && !summaryView.webContents.isDestroyed()) {
      summaryView.webContents.send('summary-data', {
        activeModels: visible,
        contents
      });
    }
  }
}

// ===== IPC：一键汇总对话 =====
let summaryResponses = {};
let summaryCollectionId = 0;
const SUMMARY_MAX_ATTEMPTS = 8;
const SUMMARY_POLL_INTERVAL = 900;
const SUMMARY_SCRIPT_TIMEOUT = 1500;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function publishSummaryData() {
  if (summaryView && !summaryView.webContents.isDestroyed()) {
    summaryView.webContents.send('summary-data', {
      activeModels: activeModels.filter(id => views[id]),
      responses: summaryResponses,
      originalPrompt: lastBroadcastPrompt,
    });
  }
}

async function collectModelSummary(modelId, collectionId) {
  const view = views[modelId];
  if (!view) {
    summaryResponses[modelId] = { status: 'error', text: '', error: '模型页面未打开', updatedAt: Date.now() };
    publishSummaryData();
    return;
  }

  let previousText = '';
  let stableReads = 0;
  let latestText = '';

  for (let attempt = 1; attempt <= SUMMARY_MAX_ATTEMPTS; attempt++) {
    if (collectionId !== summaryCollectionId) return;
    try {
      const text = await Promise.race([
        view.webContents.executeJavaScript(extractLatestResponseScript(modelId)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('页面响应超时')), SUMMARY_SCRIPT_TIMEOUT)),
      ]);
      const normalized = typeof text === 'string' && !text.startsWith('DEBUG_INFO:') ? text.trim() : '';

      if (normalized) {
        latestText = normalized;
        stableReads = normalized === previousText ? stableReads + 1 : 0;
        previousText = normalized;
        summaryResponses[modelId] = {
          status: stableReads >= 1 ? 'ready' : 'collecting',
          text: normalized,
          complete: stableReads >= 1,
          attempt,
          updatedAt: Date.now(),
        };
        publishSummaryData();
        if (stableReads >= 1) return;
      }
    } catch (error) {
      summaryResponses[modelId] = {
        status: 'collecting', text: latestText, complete: false, attempt,
        error: error.message, updatedAt: Date.now(),
      };
      publishSummaryData();
    }
    if (attempt < SUMMARY_MAX_ATTEMPTS) await delay(SUMMARY_POLL_INTERVAL);
  }

  if (collectionId !== summaryCollectionId) return;
  summaryResponses[modelId] = latestText
    ? { status: 'partial', text: latestText, complete: false, error: '回答仍在变化，请稍后重试', updatedAt: Date.now() }
    : { status: 'error', text: '', complete: false, error: '未找到可用回答，请重试', updatedAt: Date.now() };
  publishSummaryData();
}

function fetchAndSendSummaryData(modelIds) {
  const visible = activeModels.filter(id => views[id]);
  const targets = (modelIds || visible).filter(id => visible.includes(id));
  if (!modelIds) summaryCollectionId++;
  const collectionId = summaryCollectionId;

  if (targets.length === 0) {
    summaryResponses = {};
    publishSummaryData();
    return;
  }

  targets.forEach(modelId => {
    summaryResponses[modelId] = { status: 'collecting', text: '', complete: false, updatedAt: Date.now() };
  });
  publishSummaryData();
  Promise.all(targets.map(modelId => collectModelSummary(modelId, collectionId))).catch(console.error);
}

ipcMain.on('broadcast-summary', (event) => {
  if (activeModels.filter(id => views[id]).length < 2) return;
  if (!isSummaryVisible) {
    // 侧边栏未打开，此时打开侧边栏，不立即抓取（等待侧边栏就绪发来 summary-ready 信号后再拉取）
    showSummary();
  } else {
    // 侧边栏已经是打开状态，直接重新抓取并派发最新数据（实现刷新动作）
    fetchAndSendSummaryData();
  }
});

// ===== IPC：监听侧边栏就绪信号 =====
ipcMain.on('summary-ready', (event) => {
  fetchAndSendSummaryData();
  const defaultTarget = activeModels.find(id => views[id]);
  if (defaultTarget) prepareSummaryTaskView(defaultTarget);
});

ipcMain.on('refresh-summary', () => fetchAndSendSummaryData());
ipcMain.on('retry-model-summary', (event, { modelId }) => fetchAndSendSummaryData([modelId]));
ipcMain.on('prepare-summary-model', (event, { modelId }) => prepareSummaryTaskView(modelId));

// ===== IPC：关闭汇总侧边栏 =====
ipcMain.on('close-summary', () => {
  hideSummary();
});

// ===== IPC：触发 AI 总结提炼 =====
ipcMain.on('legacy-trigger-ai-summary', (event, { targetModelId, prompt }) => {
  // 1. 自动定位翻页滑动
  const visible = activeModels.filter(id => views[id]);
  const idx = visible.indexOf(targetModelId);
  if (idx !== -1) {
    const page = Math.floor(idx / MAX_PER_PAGE);
    if (currentPage !== page) {
      currentPage = page;
      relayout();
    }
  }

  // 2. 注入 Prompt 并触发该模型发送
  // 稍微延迟 300 毫秒，等待翻页布局完成
  setTimeout(() => {
    sendPromptWithRetry(targetModelId, prompt);
  }, 300);
});

// 清除各模型独立分区中的登录信息；重新加载后由服务商自己的登录页完成验证。
function sendSummaryTaskUpdate(update) {
  if (summaryModalView && !summaryModalView.webContents.isDestroyed()) {
    summaryModalView.webContents.send('summary-task-update', { ...summaryTask, ...update });
  }
}

function showSummaryModal() {
  if (!mainWindow) return;
  const [width, height] = mainWindow.getContentSize();
  summaryModalView = new BrowserView({
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'summary-modal-preload.js') }
  });
  summaryModalView.setBackgroundColor('#00000000');
  summaryModalView.setBounds({ x: 0, y: 0, width, height });
  mainWindow.addBrowserView(summaryModalView);
  summaryModalView.webContents.loadFile('summary-modal.html');
}

function layoutSummaryTaskWindow() {
  if (!mainWindow || !summaryTaskView) return;
  const [width, height] = mainWindow.getContentSize();
  const modalWidth = Math.min(980, width - 100);
  const modalHeight = Math.min(720, height - 80);
  const x = Math.round((width - modalWidth) / 2);
  const y = Math.round((height - modalHeight) / 2);
  summaryTaskView.setBounds({ x, y: y + 52, width: modalWidth, height: modalHeight - 52 });
}

function hideTaskSidebar(modelId, taskView) {
  if (modelId !== 'chatgpt') return;
  return taskView.webContents.executeJavaScript(`(() => {
    if (!window.__aiPortalCompactSidebar) {
      window.__aiPortalCompactSidebar = true;
      const style = document.createElement('style');
      style.textContent = '#stage-slideover-sidebar,'
        + '[data-testid="conversation-sidebar"],'
        + '[data-testid="sidebar"],'
        + '[data-testid="sidebar-container"] { display: none !important; }';
      document.documentElement.appendChild(style);
    }

    const hide = () => {
      const nodes = document.querySelectorAll('aside, nav, #stage-slideover-sidebar, [data-testid*="sidebar"]');
      for (const node of nodes) {
        let candidate = node;
        for (let i = 0; i < 4 && candidate; i++, candidate = candidate.parentElement) {
          const rect = candidate.getBoundingClientRect();
          if (rect.left <= 8 && rect.width >= 180 && rect.width <= 380 && rect.height >= 400) {
            candidate.style.setProperty('display', 'none', 'important');
            break;
          }
        }
      }
    };
    hide();
  })();`).catch(() => {});
}

function waitForTaskComposer(modelId, taskView) {
  const modelSelectors = MODEL_ADAPTERS[modelId]?.composerSelectors;
  if (!modelSelectors) return Promise.resolve(true);
  return taskView.webContents.executeJavaScript(`new Promise(resolve => {
    const selectors = ${JSON.stringify(modelSelectors)};
    let attempts = 0;
    const check = () => {
      const ready = selectors.some(selector => {
        const element = document.querySelector(selector);
        return element && element.offsetParent !== null && !element.disabled && !element.readOnly;
      });
      if (ready) return resolve(true);
      if (++attempts >= 40) return resolve(false);
      setTimeout(check, 250);
    };
    check();
  })`).catch(() => false);
}

function disposePreparedSummaryView() {
  if (preparedSummaryView && !preparedSummaryView.webContents.isDestroyed()) {
    try { preparedSummaryView.webContents.close(); } catch (_) {}
  }
  preparedSummaryView = null;
  preparedSummaryModel = null;
  preparedSummaryPromise = null;
}

function prepareSummaryTaskView(modelId) {
  if (!AI_CONFIGS[modelId] || summaryTaskView) return Promise.resolve(null);
  if (preparedSummaryView && preparedSummaryModel === modelId) return preparedSummaryPromise;
  disposePreparedSummaryView();

  const taskSession = session.fromPartition(`persist:${modelId}`, { cache: true });
  const view = new BrowserView({
    webPreferences: { session: taskSession, contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  preparedSummaryView = view;
  preparedSummaryModel = modelId;
  preparedSummaryPromise = view.webContents.loadURL(AI_CONFIGS[modelId].url)
    .then(async () => {
      await hideTaskSidebar(modelId, view);
      await waitForTaskComposer(modelId, view);
      return view;
    })
    .catch(() => {
      if (preparedSummaryView === view) disposePreparedSummaryView();
      return null;
    });
  return preparedSummaryPromise;
}

function closeSummaryModal() {
  if (!mainWindow) return;
  if (summaryTaskView) {
    try { mainWindow.removeBrowserView(summaryTaskView); } catch (_) {}
    try { summaryTaskView.webContents.close(); } catch (_) {}
    summaryTaskView = null;
  }
  if (summaryModalView) {
    try { mainWindow.removeBrowserView(summaryModalView); } catch (_) {}
  }
  summaryModalView = null;
}

async function waitForSummaryTaskResponse(taskView, modelId) {
  let previous = '', latest = '', stableReads = 0;
  for (let attempt = 1; attempt <= 16; attempt++) {
    sendSummaryTaskUpdate({ status: 'generating', attempt, message: `正在生成综合报告（${attempt}/16）…` });
    try {
      const text = await Promise.race([
        taskView.webContents.executeJavaScript(extractLatestResponseScript(modelId)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('页面响应超时')), 1800)),
      ]);
      const normalized = typeof text === 'string' && !text.startsWith('DEBUG_INFO:') ? text.trim() : '';
      if (normalized) {
        latest = normalized;
        stableReads = normalized === previous ? stableReads + 1 : 0;
        previous = normalized;
        if (stableReads >= 1) return { text: normalized, complete: true };
      }
    } catch (_) {}
    await delay(1000);
  }
  return { text: latest, complete: false };
}

async function startSummaryTask(targetModelId, prompt) {
  if (!AI_CONFIGS[targetModelId]) return;
  if (summaryTaskView && !summaryTaskView.webContents.isDestroyed()) {
    try { summaryTaskView.webContents.close(); } catch (_) {}
  }
  summaryTask = { targetModelId, status: 'creating', message: '正在创建独立的综合会话…', report: '', complete: false };
  if (isSummaryVisible && summaryView) {
    try { mainWindow.removeBrowserView(summaryView); } catch (_) {}
    isSummaryVisible = false;
  }
  showSummaryModal();

  let preloadPromise = null;
  if (preparedSummaryView && preparedSummaryModel === targetModelId) {
    summaryTaskView = preparedSummaryView;
    preloadPromise = preparedSummaryPromise;
    preparedSummaryView = null;
    preparedSummaryModel = null;
    preparedSummaryPromise = null;
  } else {
    disposePreparedSummaryView();
    const taskSession = session.fromPartition(`persist:${targetModelId}`, { cache: true });
    summaryTaskView = new BrowserView({
      webPreferences: { session: taskSession, contextIsolation: true, sandbox: true, nodeIntegration: false }
    });
  }
  try {
    if (preloadPromise) {
      const readyView = await preloadPromise;
      if (!readyView) throw new Error('独立会话预加载失败，请重试');
    } else {
      await summaryTaskView.webContents.loadURL(AI_CONFIGS[targetModelId].url);
      await hideTaskSidebar(targetModelId, summaryTaskView);
      const composerReady = await waitForTaskComposer(targetModelId, summaryTaskView);
      if (!composerReady) throw new Error(`${AI_CONFIGS[targetModelId].label} 输入框尚未就绪`);
    }
    if (targetModelId !== 'chatgpt') {
      await delay(500);
      await summaryTaskView.webContents.executeJavaScript(buildNewChatScript(targetModelId)).catch(() => {});
      // “新建会话”可能触发站内路由跳转或整页导航。必须重新等待新的
      // composer，而不能复用预加载阶段已经失效的 DOM 节点。
      await delay(500);
      const freshComposerReady = await waitForTaskComposer(targetModelId, summaryTaskView);
      if (!freshComposerReady) throw new Error(`${AI_CONFIGS[targetModelId].label} 新会话输入框尚未就绪`);
    }
    sendSummaryTaskUpdate({ status: 'sending', message: `正在发送至 ${AI_CONFIGS[targetModelId].label}…` });
    const sendResult = await sendPromptWithRetry(targetModelId, prompt, summaryTaskView);
    if (!sendResult.ok) throw new Error(sendResult.reason || '未找到可用的输入框，请重试');
    await hideTaskSidebar(targetModelId, summaryTaskView);
    mainWindow.addBrowserView(summaryTaskView);
    layoutSummaryTaskWindow();
    summaryTask = { ...summaryTask, status: 'ready', message: '综合会话已就绪，可直接继续对话', conversationUrl: summaryTaskView.webContents.getURL() };
    sendSummaryTaskUpdate({});
    return;
    const result = await waitForSummaryTaskResponse(summaryTaskView, targetModelId);
    summaryTask = { ...summaryTask, status: result.complete ? 'complete' : 'partial', message: result.complete ? '综合报告已生成' : '已获取部分报告，可继续在模型中查看', report: result.text, complete: result.complete, conversationUrl: summaryTaskView.webContents.getURL() };
    sendSummaryTaskUpdate({});
  } catch (error) {
    summaryTask = { ...summaryTask, status: 'error', message: error.message || '创建综合会话失败' };
    sendSummaryTaskUpdate({});
  }
}

ipcMain.on('trigger-ai-summary', (event, { targetModelId, prompt }) => startSummaryTask(targetModelId, prompt));
ipcMain.on('summary-task-ready', () => sendSummaryTaskUpdate({}));
ipcMain.on('close-summary-modal', () => closeSummaryModal());
ipcMain.on('continue-summary-task', () => {
  if (!summaryTask || !summaryTask.conversationUrl || !views[summaryTask.targetModelId]) return;
  const visible = activeModels.filter(id => views[id]);
  currentPage = Math.floor(visible.indexOf(summaryTask.targetModelId) / MAX_PER_PAGE);
  relayout();
  views[summaryTask.targetModelId].webContents.loadURL(summaryTask.conversationUrl);
  closeSummaryModal();
});

ipcMain.handle('clear-model-sessions', async () => {
  const results = await Promise.all(Object.keys(AI_CONFIGS).map(async (modelId) => {
    try {
      const modelSession = session.fromPartition(`persist:${modelId}`, { cache: true });
      await modelSession.clearStorageData();
      await modelSession.clearCache();
      if (views[modelId]) await views[modelId].webContents.loadURL(AI_CONFIGS[modelId].url);
      return true;
    } catch (_) {
      return false;
    }
  }));
  return { success: results.every(Boolean) };
});

// 使用 Electron 的颜色偏好，让本地界面和支持该标准的模型网页同步切换。
ipcMain.handle('set-theme', (event, mode) => {
  nativeTheme.themeSource = mode === 'dark' ? 'dark' : 'light';
  return { dark: nativeTheme.shouldUseDarkColors };
});

ipcMain.handle('get-theme', () => ({ dark: nativeTheme.shouldUseDarkColors }));

// ===== 主窗口 =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600, height: 900,
    title: 'Multi-AI Workspace',
    backgroundColor: '#f7f7f5',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'renderer-preload.js'),
    }
  });
  mainWindow.setMaxListeners(30);
  mainWindow.loadFile('index.html');
  mainWindow.on('resize', relayout);
  mainWindow.webContents.on('did-finish-load', () => {
    const [w, h] = mainWindow.getContentSize();
    activeModels.forEach(id => { if (!views[id]) createView(id); });
    createBottomBar(w, h);
    createNavButtons();
    relayout();
  });
}

app.whenReady().then(() => {
  createWindow();
  startHermesPortalBridge();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (hermesPortalBridge) hermesPortalBridge.stop();
});
