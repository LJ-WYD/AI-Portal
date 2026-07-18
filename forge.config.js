const path = require('node:path');

const projectRoot = __dirname;

module.exports = {
  packagerConfig: {
    asar: true,
    icon: path.join(projectRoot, 'assets', 'icons', 'app'),
    executableName: 'AI Portal',
    prune: true,
    ignore: [
      /^\/\.git($|\/)/,
      /^\/\.github($|\/)/,
      /^\/\.portal-mcp\.local\.json$/,
      /^\/\.env($|\.)/,
      /^\/(coverage|dist|out|output|release)($|\/)/,
      /^\/(README|PRIVACY|SECURITY)\.md$/,
    ],
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'AIPortal',
        authors: 'AI Portal',
        description: 'Multi-AI Workspace Portal',
        setupExe: 'AI-Portal-Setup.exe',
        setupIcon: path.join(projectRoot, 'assets', 'icons', 'app.ico'),
        noMsi: true,
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
      config: {},
    },
  ],
};
