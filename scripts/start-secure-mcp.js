const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const configPath = path.join(root, '.portal-mcp.local.json');
if (!fs.existsSync(configPath)) {
  console.error('Missing .portal-mcp.local.json. Run: node scripts/create-mcp-local-config.js');
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (_) {
  console.error('Invalid .portal-mcp.local.json.');
  process.exit(1);
}

if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || typeof config.token !== 'string' || config.token.length < 32) {
  console.error('Local MCP configuration is incomplete.');
  process.exit(1);
}

const child = spawn(require('electron'), ['.'], {
  cwd: root,
  env: {
    ...process.env,
    PORTAL_BRIDGE_ENABLED: 'true',
    PORTAL_BRIDGE_PORT: String(config.port),
    PORTAL_BRIDGE_TOKEN: config.token,
  },
  stdio: 'inherit',
  windowsHide: false,
});
child.on('exit', code => process.exit(code || 0));
