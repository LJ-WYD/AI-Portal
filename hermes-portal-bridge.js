const http = require('http');

const MAX_BODY_BYTES = 64 * 1024;

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求内容超过 64KB 限制'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (_) {
        reject(new Error('请求体必须是 JSON'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function createHermesPortalBridge({ getHealth, createJob, getJob, token = '', host = '127.0.0.1', port = 8765 }) {
  if (typeof getHealth !== 'function') {
    throw new Error('Portal Bridge requires a getHealth handler');
  }

  const isAuthorized = request => !token || request.headers.authorization === `Bearer ${token}`;
  const server = http.createServer(async (request, response) => {
    try {
      if (!isAuthorized(request)) return sendJson(response, 401, { error: 'unauthorized' });

      const url = new URL(request.url, `http://${host}:${port}`);
      if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
        return sendJson(response, 200, {
          status: 'ok',
          service: 'ai-portal-bridge',
          models: await getHealth(),
        });
      }

      if (request.method === 'POST' && url.pathname === '/v1/jobs') {
        if (!token || typeof createJob !== 'function') {
          return sendJson(response, 503, { error: 'job_submission_not_enabled' });
        }
        const payload = await readJsonBody(request);
        if (typeof payload.prompt !== 'string' || !payload.prompt.trim()) {
          return sendJson(response, 400, { error: 'prompt is required' });
        }
        if (payload.prompt.length > 12000) {
          return sendJson(response, 400, { error: 'prompt exceeds 12000 characters' });
        }
        const job = await createJob({
          prompt: payload.prompt.trim(),
          userId: typeof payload.userId === 'string' ? payload.userId.slice(0, 128) : 'unknown',
          channel: typeof payload.channel === 'string' ? payload.channel.slice(0, 64) : 'unknown',
          conversationId: typeof payload.conversationId === 'string' ? payload.conversationId.slice(0, 128) : '',
          modelIds: Array.isArray(payload.modelIds) ? payload.modelIds.slice(0, 4) : [],
        });
        return sendJson(response, 202, { jobId: job.id, status: job.status });
      }

      const match = url.pathname.match(/^\/v1\/jobs\/([a-zA-Z0-9_-]+)$/);
      if (request.method === 'GET' && match) {
        if (!token || typeof getJob !== 'function') {
          return sendJson(response, 503, { error: 'job_submission_not_enabled' });
        }
        const job = await getJob(match[1]);
        return job ? sendJson(response, 200, job) : sendJson(response, 404, { error: 'job_not_found' });
      }

      return sendJson(response, 404, { error: 'not_found' });
    } catch (error) {
      return sendJson(response, 400, { error: error.message || 'bad_request' });
    }
  });

  return {
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve({ host, port });
      });
    }),
    stop: () => new Promise(resolve => server.close(resolve)),
  };
}

module.exports = { createHermesPortalBridge };
