import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/bridge.mjs';

const config = await loadConfig();
const options = { encoding: 'utf8', windowsHide: true, timeout: 15000 };
const version = execFileSync(config.claudeCommand, ['--version'], options).trim();
const auth = JSON.parse(execFileSync(config.claudeCommand, ['auth', 'status'], options));
console.log(JSON.stringify({ node: process.version, claude: version, loggedIn: auth.loggedIn,
  authentication: auth.authMethod, projects: Object.keys(config.projects), mode: 'read-only' }, null, 2));
if (!auth.loggedIn) process.exitCode = 1;
