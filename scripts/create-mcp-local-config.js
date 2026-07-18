const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', '.portal-mcp.local.json');
if (fs.existsSync(configPath)) {
  console.error('Local MCP configuration already exists.');
  process.exit(0);
}

const config = {
  port: 28365,
  token: crypto.randomBytes(32).toString('base64url'),
};
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.error(`Created local MCP configuration at ${configPath}`);
