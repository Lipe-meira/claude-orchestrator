import { open, readdir, realpath, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, normalize, sep } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

const sessionId = z.string().uuid();
const readOptions = z.object({ after: z.string().min(1).max(200).optional(), limit: z.number().int().min(1).max(20).default(5),
  max_chars: z.number().int().min(1).max(8000).default(2000) });
const pageOptions = z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(16000).default(4000) });
const canonical = path => {
  const normalized = normalize(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
function within(root, path) {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

export class SessionHistory {
  constructor(config) {
    this.projects = config.projects;
    this.root = config.claudeProjectsDirectory || resolve(process.env.CLAUDE_CONFIG_DIR || resolve(homedir(), '.claude'), 'projects');
  }
  project(name) {
    if (!Object.hasOwn(this.projects, name)) throw new Error('Projeto não autorizado.');
    return this.projects[name];
  }
  async folder(name) {
    const project = this.project(name);
    const root = await realpath(this.root);
    const folder = await realpath(resolve(root, project.replace(/[^a-zA-Z0-9]/g, '-')));
    if (!within(root, folder)) throw new Error('Diretório de sessões fora do histórico permitido.');
    return { project, root, folder };
  }
  async snapshot(name, id) {
    if (!sessionId.safeParse(id).success) throw new Error('Identificador de sessão inválido.');
    let info;
    try { info = await this.folder(name); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('Sessão não encontrada.'); throw error; }
    const path = resolve(info.folder, `${id}.jsonl`);
    let handle;
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Links de histórico não são permitidos.');
      const actual = await realpath(path);
      if (!within(info.folder, actual)) throw new Error('Arquivo fora do histórico permitido.');
      handle = await open(actual, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Histórico não é um arquivo regular.');
      if (stat.size > 64 * 1024 * 1024) throw new Error('Sessão excede o limite de leitura de 64 MB.');
      const responses = new Map();
      let skipped = 0, matched = false;
      const consume = line => {
        if (!line.trim()) return;
        let row;
        try { row = JSON.parse(line); } catch { skipped++; return; }
        if (!row || typeof row !== 'object' || row.isSidechain === true || (row.sessionId ?? row.session_id) !== id ||
          typeof row.cwd !== 'string' || canonical(row.cwd) !== canonical(info.project)) return;
        matched = true;
        if (row.type !== 'assistant' || typeof row.uuid !== 'string' || !Array.isArray(row.message?.content)) return;
        const text = row.message.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
        if (!text.trim()) return;
        responses.set(row.uuid, { id: row.uuid, timestamp: typeof row.timestamp === 'string' ? row.timestamp : null,
          model: typeof row.message.model === 'string' ? row.message.model : null, text });
      };
      let tail = '';
      if (stat.size) {
        // Freeze the upper byte boundary: an active writer cannot keep this read open forever.
        const stream = handle.createReadStream({ start: 0, end: stat.size - 1, encoding: 'utf8', autoClose: false });
        for await (const chunk of stream) {
          tail += chunk;
          let end;
          while ((end = tail.indexOf('\n')) >= 0) { consume(tail.slice(0, end)); tail = tail.slice(end + 1); }
        }
      }
      let partial = false;
      if (tail.trim()) {
        try { JSON.parse(tail); consume(tail); } catch { partial = true; }
      }
      if (!matched) throw new Error('Sessão não encontrada neste projeto ou ainda sem registros reconhecidos.');
      return { project: name, session_id: id, updated_at: stat.mtime.toISOString(), bytes_read: stat.size,
        skipped_lines: skipped, partial_tail: partial, responses: [...responses.values()] };
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Sessão não encontrada.');
      throw error;
    } finally { await handle?.close(); }
  }
  async list(project, { limit = 20 } = {}) {
    z.number().int().min(1).max(100).parse(limit);
    this.project(project);
    let folder;
    try { ({ folder } = await this.folder(project)); }
    catch (error) { if (error.code === 'ENOENT') return { project, sessions: [], skipped_sessions: 0 }; throw error; }
    const sessions = [];
    let skipped = 0;
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !sessionId.safeParse(entry.name.slice(0, -6)).success) continue;
      try {
        const snapshot = await this.snapshot(project, entry.name.slice(0, -6));
        const latest = snapshot.responses.at(-1);
        sessions.push({ session_id: snapshot.session_id, updated_at: snapshot.updated_at,
          response_count: snapshot.responses.length, last_response_id: latest?.id || null, model: latest?.model || null });
      } catch { skipped++; }
    }
    sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.session_id.localeCompare(b.session_id));
    return { project, sessions: sessions.slice(0, limit), has_more: sessions.length > limit, skipped_sessions: skipped };
  }
  async read(project, id, options = {}) {
    const { after, limit, max_chars } = readOptions.parse(options);
    const snapshot = await this.snapshot(project, id);
    const all = snapshot.responses;
    const index = after === undefined ? -1 : all.findIndex(response => response.id === after);
    if (after !== undefined && index < 0) throw new Error('Cursor não encontrado. Releia as respostas recentes desta sessão.');
    const available = after === undefined ? all.slice(-limit) : all.slice(index + 1);
    const selected = available.slice(0, limit);
    return { ...snapshot, responses: selected.map(response => ({ ...response, text: response.text.slice(0, max_chars),
      text_length: response.text.length, truncated: response.text.length > max_chars })),
      next_after: selected.at(-1)?.id || after || null, has_more: available.length > limit, total_responses: all.length };
  }
  async response(project, id, responseId, options = {}) {
    const { offset, limit } = pageOptions.parse(options);
    const snapshot = await this.snapshot(project, id);
    const response = snapshot.responses.find(item => item.id === responseId);
    if (!response) throw new Error('Resposta não encontrada.');
    return { project, session_id: id, ...response, text: response.text.slice(offset, offset + limit),
      text_length: response.text.length, next_offset: offset + limit < response.text.length ? offset + limit : null };
  }
}
