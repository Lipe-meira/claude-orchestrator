import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, realpath, rename } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const taskSchema = z.object({
  request_id: z.string().min(1).max(100),
  project: z.string().min(1).max(100),
  prompt: z.string().trim().min(1).max(24000),
  model: z.enum(['haiku', 'sonnet', 'opus']).default('haiku'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  resume_task_id: z.string().uuid().optional()
}).strict();

const configSchema = z.object({
  claudeCommand: z.string().min(1).default('claude'),
  projects: z.record(z.string(), z.string().min(1)),
  stateDirectory: z.string().min(1).default('.orchestrator'),
  timeoutMs: z.number().int().min(100).max(600000).default(120000)
}).strict();

export async function loadConfig(file = process.env.ORCHESTRATOR_CONFIG || 'orchestrator.config.json') {
  const path = resolve(file);
  const config = configSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const projects = {};
  for (const [name, folder] of Object.entries(config.projects)) projects[name] = await realpath(resolve(dirname(path), folder));
  if (!Object.keys(projects).length) throw new Error('Cadastre pelo menos um projeto no arquivo de configuração.');
  if (config.claudeCommand !== 'claude' && !isAbsolute(config.claudeCommand)) throw new Error('claudeCommand deve ser claude ou um caminho absoluto para o executável.');
  return { ...config, projects, stateDirectory: resolve(dirname(path), config.stateDirectory) };
}

export function claudeArgs(task, session) {
  const args = ['--print', '--output-format', 'json', '--model', task.model, '--effort', task.effort,
    '--safe-mode', '--restricted', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--append-system-prompt',
    'Você recebe tarefas de um coordenador. Responda de forma concisa: resultado, evidências, limitações e próximo passo. Nunca afirme ter feito verificações que não fez.'];
  if (session) args.push('--resume', session);
  return args;
}

function stopTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else child.kill('SIGTERM');
}

export class Bridge {
  constructor(config, launch = spawn) {
    this.config = config;
    this.launch = launch;
    this.tasks = new Map();
    this.active = null;
  }
  async init() {
    await mkdir(this.config.stateDirectory, { recursive: true });
    for (const file of await readdir(this.config.stateDirectory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const task = JSON.parse(await readFile(resolve(this.config.stateDirectory, file), 'utf8'));
      if (task.status === 'running') {
        task.status = 'interrupted';
        task.error = 'A ponte foi reiniciada. Confira o processo anterior antes de repetir a tarefa.';
        await this.save(task);
      }
      this.tasks.set(task.id, task);
    }
    return this;
  }
  async save(task) {
    const file = resolve(this.config.stateDirectory, `${task.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(task, null, 2), 'utf8');
    await rename(temporary, file);
  }
  describe(task, offset = 0, limit = 4000) {
    const { prompt, result, ...meta } = task;
    const text = result || '';
    return { ...meta, result: text.slice(offset, offset + limit), result_length: text.length,
      next_offset: offset + limit < text.length ? offset + limit : null };
  }
  get(id, offset = 0, limit = 4000) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Tarefa não encontrada.');
    return this.describe(task, offset, limit);
  }
  async submit(input) {
    const data = taskSchema.parse(input);
    if (!Object.hasOwn(this.config.projects, data.project)) throw new Error('Projeto não autorizado.');
    for (const task of this.tasks.values()) {
      if (task.request_id !== data.request_id) continue;
      if (task.prompt !== data.prompt || task.project !== data.project || task.model !== data.model || task.effort !== data.effort || task.resume_task_id !== data.resume_task_id) throw new Error('request_id já usado para outra tarefa.');
      return this.describe(task);
    }
    if (this.active) throw new Error('Já existe uma tarefa em execução. Consulte seu resultado antes de enviar outra.');
    let session;
    if (data.resume_task_id) {
      const prior = this.tasks.get(data.resume_task_id);
      if (!prior || prior.status !== 'succeeded' || !prior.session_id || prior.project !== data.project) throw new Error('Só é possível continuar uma tarefa concluída desta ponte no mesmo projeto.');
      session = prior.session_id;
    }
    const task = { ...data, id: randomUUID(), status: 'running', started_at: new Date().toISOString() };
    this.active = { task, child: null, done: null };
    this.tasks.set(task.id, task);
    try { await this.save(task); } catch (error) { this.tasks.delete(task.id); this.active = null; throw error; }
    this.active.done = this.run(task, session);
    return this.describe(task);
  }
  async run(task, session) {
    let timer;
    try {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      // Reuse the local Claude login; do not accidentally switch to API billing.
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      const child = this.launch(this.config.claudeCommand, claudeArgs(task, session), {
        cwd: this.config.projects[task.project], env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      });
      this.active.child = child;
      let stdout = '', stderr = '', reason;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      const done = new Promise((accept, reject) => {
        child.once('error', reject);
        child.once('close', code => accept(code));
      });
      child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => {
        if (reason) return;
        stdout += chunk;
        if (Buffer.byteLength(stdout) > 2 * 1024 * 1024 && !reason) { reason = 'Saída excedeu 2 MB.'; stopTree(child); }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
      timer = setTimeout(() => { reason = 'Tempo limite excedido.'; stopTree(child); }, this.config.timeoutMs);
      child.stdin.end(task.prompt);
      const code = await done;
      if (task.status === 'cancelled') return;
      if (reason) throw new Error(reason);
      if (code !== 0) throw new Error(`Claude terminou com código ${code}: ${stderr || stdout.slice(-2000)}`);
      const response = JSON.parse(stdout);
      task.session_id = response.session_id;
      task.result = response.result || '';
      task.usage = response.usage || null;
      task.model_usage = response.modelUsage || null;
      task.estimated_cost_usd = response.total_cost_usd ?? null;
      task.permission_denials = response.permission_denials || [];
      task.status = response.is_error ? 'failed' : 'succeeded';
      if (response.is_error) task.error = task.result || response.subtype || 'Claude reportou falha.';
    } catch (error) {
      if (task.status !== 'cancelled') { task.status = 'failed'; task.error = error.message; }
    } finally {
      clearTimeout(timer);
      task.finished_at = new Date().toISOString();
      try { await this.save(task); } catch (error) { console.error('Não foi possível salvar resultado:', error.message); }
      this.active = null;
    }
  }
  async cancel(id) {
    if (this.active?.task.id !== id) throw new Error('Esta tarefa não está em execução.');
    const { task, child, done } = this.active;
    task.status = 'cancelled';
    if (child) stopTree(child);
    await done;
    return this.describe(task);
  }
  async close() {
    if (this.active) await this.cancel(this.active.task.id);
  }
}
