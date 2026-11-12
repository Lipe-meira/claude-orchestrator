import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bridge, claudeArgs, loadConfig } from '../src/bridge.mjs';

const fixture = fileURLToPath(new URL('fixtures/fake-claude.mjs', import.meta.url));
async function setup(t, options = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), 'claude-orchestrator-test-'));
  const bridge = await new Bridge({ claudeCommand: 'claude', projects: { demo: dir, other: dir }, stateDirectory: dir, timeoutMs: 5000, ...options },
    (_, args, settings) => spawn(process.execPath, [fixture, ...args], settings)).init();
  t.after(async () => { await bridge.close(); await rm(dir, { recursive: true, force: true }); });
  return bridge;
}
const input = changes => ({ request_id: 'one', project: 'demo', prompt: 'olá', model: 'haiku', effort: 'low', ...changes });
async function finish(bridge) { await bridge.active?.done; }

test('prompt é dado via stdin, resultado e consumo são preservados', async t => {
  const bridge = await setup(t);
  const prompt = '$(echo HACK) `whoami` & exit; ação 🐈';
  const task = await bridge.submit(input({ prompt }));
  await finish(bridge);
  const result = bridge.get(task.id);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result, prompt);
  assert.equal(result.usage.input_tokens, 5);
  assert.ok(!claudeArgs(input()).includes(prompt));
  assert.equal(bridge.get(task.id, 0, 5).next_offset, 5);
  const reloaded = await new Bridge(bridge.config).init();
  assert.equal(reloaded.get(task.id).result, prompt);
});
test('request_id é idempotente e não aceita parâmetros diferentes', async t => {
  const bridge = await setup(t);
  const first = await bridge.submit(input());
  assert.equal((await bridge.submit(input())).id, first.id);
  await assert.rejects(bridge.submit(input({ prompt: 'outra' })), /request_id/);
  await finish(bridge);
  assert.equal((await bridge.submit(input())).id, first.id);
});
test('bloqueia caminhos arbitrários e entradas inválidas antes de executar', async t => {
  const bridge = await setup(t);
  await assert.rejects(bridge.submit(input({ project: '../' })), /autorizado/);
  await assert.rejects(bridge.submit(input({ model: 'fake;exit' })));
  await assert.rejects(bridge.submit(input({ prompt: ' ' })));
  assert.equal(bridge.tasks.size, 0);
});
test('continua apenas sessão conhecida, concluída e do mesmo projeto', async t => {
  const bridge = await setup(t);
  const first = await bridge.submit(input()); await finish(bridge);
  await assert.rejects(bridge.submit(input({ request_id: 'cross', project: 'other', resume_task_id: first.id })), /mesmo projeto/);
  const follow = await bridge.submit(input({ request_id: 'two', resume_task_id: first.id })); await finish(bridge);
  assert.equal(bridge.get(follow.id).session_id, bridge.get(first.id).session_id);
});
test('falha do Claude é retornada sem fallback oculto', async t => {
  const bridge = await setup(t);
  const task = await bridge.submit(input({ prompt: '__FAIL__' })); await finish(bridge);
  assert.equal(bridge.get(task.id).status, 'failed');
  assert.match(bridge.get(task.id).error, /modelo indisponível/);
  assert.equal(bridge.tasks.size, 1);
});
test('timeout encerra o subprocesso', async t => {
  const bridge = await setup(t, { timeoutMs: 200 });
  const task = await bridge.submit(input({ prompt: '__WAIT__' })); await finish(bridge);
  assert.equal(bridge.get(task.id).status, 'failed');
  assert.match(bridge.get(task.id).error, /Tempo limite/);
});
test('cancelamento e concorrência são explícitos', async t => {
  const bridge = await setup(t);
  const task = await bridge.submit(input({ prompt: '__WAIT__' }));
  await assert.rejects(bridge.submit(input({ request_id: 'two' })), /execução/);
  assert.equal((await bridge.cancel(task.id)).status, 'cancelled');
  assert.equal(bridge.active, null);
});
test('recuperação marca tarefa em andamento como interrompida', async t => {
  const bridge = await setup(t);
  const id = '22222222-2222-4222-8222-222222222222';
  await writeFile(resolve(bridge.config.stateDirectory, `${id}.json`), JSON.stringify({ id, status: 'running' }));
  const restored = await new Bridge(bridge.config).init();
  assert.equal(restored.get(id).status, 'interrupted');
});
test('negações de ferramentas ficam visíveis ao coordenador', async t => {
  const bridge = await setup(t);
  const task = await bridge.submit(input({ prompt: '__DENIED__' })); await finish(bridge);
  assert.equal(bridge.get(task.id).permission_denials[0].tool_name, 'Read');
});
test('configuração resolve projetos em relação ao arquivo', async t => {
  const bridge = await setup(t);
  const file = resolve(bridge.config.stateDirectory, 'config.json');
  await writeFile(file, JSON.stringify({ projects: { demo: '.' } }));
  const config = await loadConfig(file);
  assert.equal(config.projects.demo, bridge.config.projects.demo);
});
