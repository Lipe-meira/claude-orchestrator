import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/bridge.mjs';

test('configuração permite localizar histórico sem depender da pasta do terminal', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'history-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = resolve(root, 'config.json');
  await writeFile(file, JSON.stringify({ projects: { demo: '.' }, claudeProjectsDirectory: 'saved-projects' }));
  assert.equal((await loadConfig(file)).claudeProjectsDirectory, resolve(root, 'saved-projects'));
});

test('cliente MCP lista e lê resposta de sessão existente sem iniciar Claude', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'history-mcp-'));
  const client = new Client({ name: 'history-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  const storage = resolve(root, 'saved-projects');
  const folder = resolve(storage, root.replace(/[^a-zA-Z0-9]/g, '-')); await mkdir(folder, { recursive: true });
  const id = '11111111-1111-4111-8111-111111111111';
  await writeFile(resolve(folder, `${id}.jsonl`), JSON.stringify({ type: 'assistant', cwd: root, sessionId: id,
    uuid: 'reply-1', message: { content: [{ type: 'text', text: 'Terminei a análise.' }] } }) + '\n');
  const config = resolve(root, 'config.json');
  await writeFile(config, JSON.stringify({ projects: { demo: '.' }, claudeProjectsDirectory: 'saved-projects', claudeCommand: resolve(root, 'nonexistent-claude.exe') }));
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], env: { ...process.env, ORCHESTRATOR_CONFIG: config } }));
  const tools = (await client.listTools()).tools;
  for (const name of ['claude_list_sessions', 'claude_read_session', 'claude_read_response']) {
    assert.equal(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint, true);
  }
  const call = async (name, args) => {
    const reply = await client.callTool({ name, arguments: args });
    assert.ok(!reply.isError, JSON.stringify(reply));
    return JSON.parse(reply.content[0].text);
  };
  const sessions = await call('claude_list_sessions', { project: 'demo' });
  assert.equal(sessions.sessions[0].session_id, id);
  const recent = await call('claude_read_session', { project: 'demo', session_id: id });
  assert.equal(recent.responses[0].text, 'Terminei a análise.');
  const full = await call('claude_read_response', { project: 'demo', session_id: id, response_id: 'reply-1', offset: 9, limit: 20 });
  assert.equal(full.text, 'a análise.');
  const denied = await client.callTool({ name: 'claude_read_session', arguments: { project: '../', session_id: id } });
  assert.equal(denied.isError, true);
});
