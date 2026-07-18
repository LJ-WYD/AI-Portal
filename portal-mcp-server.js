#!/usr/bin/env node

const readline = require('readline');
const http = require('http');

const PORT = Number.parseInt(process.env.PORTAL_BRIDGE_PORT || '8765', 10);
const TOKEN = process.env.PORTAL_BRIDGE_TOKEN || '';
const HEALTH_TOOL = {
  name: 'portal_get_health',
  description: '读取 AI Portal 当前已打开模型的可用状态；不会修改会话、登录态或模型选择。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};
const SUBMIT_TOOL = {
  name: 'portal_submit_question',
  description: '把移动端问题提交给 AI Portal 的隔离后台会话，最多并行请求四个指定模型；不会改动当前可见会话。需要配置 PORTAL_BRIDGE_TOKEN。',
  inputSchema: {
    type: 'object',
    required: ['prompt'],
    properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 12000 },
      modelIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 },
      userId: { type: 'string', maxLength: 128 },
      channel: { type: 'string', maxLength: 64 },
      conversationId: { type: 'string', maxLength: 128 },
    },
    additionalProperties: false,
  },
};
const JOB_TOOL = {
  name: 'portal_get_job',
  description: '读取已提交的 AI Portal 后台任务进度和各模型原始回答。',
  inputSchema: {
    type: 'object', required: ['jobId'],
    properties: { jobId: { type: 'string', minLength: 1 } }, additionalProperties: false,
  },
};

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  write({ jsonrpc: '2.0', id, result: value });
}

function failure(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function requestJson(path, method = 'GET', payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const request = http.request({
      host: '127.0.0.1',
      port: PORT,
      path,
      method,
      timeout: 4000,
      headers: {
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`Portal Bridge responded with ${response.statusCode}: ${body}`));
        try {
          resolve(JSON.parse(body));
        } catch (_) {
          reject(new Error('Portal Bridge returned invalid JSON'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Portal Bridge timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

const getHealth = () => requestJson('/v1/health');

async function handle(message) {
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'initialize') {
    return result(message.id, {
      protocolVersion: message.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'ai-portal', version: '0.1.0' },
    });
  }
  if (message.method === 'ping') return result(message.id, {});
  if (message.method === 'tools/list') return result(message.id, { tools: [HEALTH_TOOL, SUBMIT_TOOL, JOB_TOOL] });
  if (message.method === 'tools/call') {
    try {
      const toolName = message.params?.name;
      const args = message.params?.arguments || {};
      if (toolName === SUBMIT_TOOL.name && !TOKEN) throw new Error('后台提交未启用：请配置 PORTAL_BRIDGE_TOKEN');
      const data = toolName === HEALTH_TOOL.name
        ? await getHealth()
        : toolName === SUBMIT_TOOL.name
          ? await requestJson('/v1/jobs', 'POST', args)
          : toolName === JOB_TOOL.name
            ? await requestJson(`/v1/jobs/${encodeURIComponent(args.jobId || '')}`)
            : null;
      if (!data) return failure(message.id, -32602, 'Unknown tool');
      return result(message.id, {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
      });
    } catch (error) {
      return result(message.id, {
        content: [{ type: 'text', text: `无法连接 Portal MCP Bridge：${error.message}` }],
        isError: true,
      });
    }
  }
  return failure(message.id, -32601, 'Method not found');
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  try {
    Promise.resolve(handle(JSON.parse(line))).catch(error => failure(null, -32603, error.message));
  } catch (_) {
    failure(null, -32700, 'Parse error');
  }
});
