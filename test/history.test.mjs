import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { SessionHistory } from '../src/history.mjs';
const session = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
async function setup(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'claude-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = resolve(root, 'project'); await mkdir(project);
  const storage = resolve(root, 'transcripts'); await mkdir(storage);
  const folder = resolve(storage, project.replace(/[^a-zA-Z0-9]/g, '-')); await mkdir(folder);
  const file = resolve(folder, `${session}.jsonl`);
  const row = (uuid, text, extra = {}) => ({ type: 'assistant', uuid, sessionId: session, cwd: project,
    timestamp: '2026-11-12T14:00:00Z', isSidechain: false, message: { model: 'test-model', content: [{ type: 'text', text }] }, ...extra });
  const put = rows => writeFile(file, rows.map(value => JSON.stringify(value)).join('\n') + '\n');
  const history = new SessionHistory({ projects: { demo: project }, claudeProjectsDirectory: storage });
  return { history, root, folder, file, project, row, put };
}
test('lista somente sessões do projeto autorizado, sem conteúdo privado no resumo', async t => {
  const f = await setup(t);
  await f.put([f.row('a', 'resposta privada')]);
  await writeFile(resolve(f.folder, `${other}.jsonl`), JSON.stringify(f.row('b', 'outro projeto', { cwd: f.root, sessionId: other })) + '\n');
  const result = await f.history.list('demo');
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].session_id, session);
  assert.equal(result.sessions[0].response_count, 1);
  assert.ok(!JSON.stringify(result).includes('resposta privada'));
  await assert.rejects(f.history.list('../'), /autorizado/);
  await assert.rejects(f.history.read('demo', '../secrets'), /identificador/i);
});
test('lê texto do assistente sem incluir usuário, raciocínio ou ferramentas', async t => {
  const f = await setup(t);
  await f.put([f.row('a', 'Olá 🐈'), f.row('hidden', 'subagente', { isSidechain: true }),
    f.row('user', 'pedido privado', { type: 'user' }),
    f.row('tools', '', { message: { content: [{ type: 'thinking', thinking: 'segredo' }, { type: 'tool_use', input: { secret: 'x' } }] } }),
    f.row('wrong', 'sessão errada', { sessionId: other }), f.row('b', 'Concluído')]);
  const result = await f.history.read('demo', session);
  assert.deepEqual(result.responses.map(item => item.text), ['Olá 🐈', 'Concluído']);
  assert.equal(result.next_after, 'b');
});
test('retorna respostas recentes e permite buscar trecho completo sem perder texto', async t => {
  const f = await setup(t);
  await f.put([f.row('a', 'primeira'), f.row('b', '0123456789'), f.row('c', 'última')]);
  const recent = await f.history.read('demo', session, { limit: 2, max_chars: 4 });
  assert.deepEqual(recent.responses.map(item => item.id), ['b', 'c']);
  assert.equal(recent.responses[0].text, '0123');
  assert.equal(recent.responses[0].truncated, true);
  const page = await f.history.response('demo', session, 'b', { offset: 4, limit: 4 });
  assert.equal(page.text, '4567'); assert.equal(page.next_offset, 8);
  const last = await f.history.response('demo', session, 'b', { offset: 8, limit: 4 });
  assert.equal(last.text, '89'); assert.equal(last.next_offset, null);
});
test('consulta incremental lê append e pagina na ordem sem saltar respostas', async t => {
  const f = await setup(t);
  await f.put([f.row('a', 'antes')]);
  assert.equal((await f.history.read('demo', session)).next_after, 'a');
  await appendFile(f.file, [f.row('b', 'nova'), f.row('c', 'nova 2')].map(JSON.stringify).join('\n') + '\n');
  const next = await f.history.read('demo', session, { after: 'a', limit: 1 });
  assert.equal(next.responses[0].id, 'b'); assert.equal(next.has_more, true);
  assert.equal((await f.history.read('demo', session, { after: next.next_after })).responses[0].id, 'c');
  assert.equal((await f.history.read('demo', session, { after: 'c' })).responses.length, 0);
  await assert.rejects(f.history.read('demo', session, { after: 'missing' }), /cursor/i);
});
test('tolera última linha incompleta e registra corrupção sem devolver conteúdo bruto', async t => {
  const f = await setup(t);
  await f.put([f.row('a', 'válida')]);
  await appendFile(f.file, 'invalid-secret\n{"type":');
  const result = await f.history.read('demo', session);
  assert.equal(result.responses.length, 1);
  assert.equal(result.skipped_lines, 1);
  assert.equal(result.partial_tail, true);
  await appendFile(f.file, '"assistant"}\n');
  assert.equal((await f.history.read('demo', session)).partial_tail, false);
});
test('não duplica registro atualizado e não segue links para fora do histórico', async t => {
  const f = await setup(t);
  await f.put([f.row('a', 'inicial'), f.row('a', 'atualizado')]);
  assert.deepEqual((await f.history.read('demo', session)).responses.map(item => item.text), ['atualizado']);
  await rm(f.file);
  const outside = resolve(f.root, 'outside.jsonl');
  await writeFile(outside, JSON.stringify(f.row('a', 'fora')) + '\n');
  try { await symlink(outside, f.file); } catch (error) {
    if (error.code === 'EPERM') { t.diagnostic('Subcaso de symlink não executado: Windows não autorizou a criação do link.'); return; }
    throw error;
  }
  await assert.rejects(f.history.read('demo', session), /fora|link/i);
});
test('projeto sem histórico retorna lista vazia e sessão ausente dá erro claro', async t => {
  const f = await setup(t);
  await rm(f.folder, { recursive: true });
  assert.deepEqual((await f.history.list('demo')).sessions, []);
  await assert.rejects(f.history.read('demo', session), /encontrad/i);
});
