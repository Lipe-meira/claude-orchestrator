import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/bridge.mjs';

const config = await loadConfig();
const client = new Client({ name: 'orchestrator-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
  env: { ...process.env, ORCHESTRATOR_CONFIG: process.env.ORCHESTRATOR_CONFIG || fileURLToPath(new URL('../orchestrator.config.json', import.meta.url)) }
});
function decode(reply) {
  const data = JSON.parse(reply.content[0].text);
  if (reply.isError) throw new Error(data.error);
  return data;
}
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  console.log(JSON.stringify({ tools, status: decode(await client.callTool({ name: 'orchestrator_status', arguments: {} })) }));
  if (process.argv.includes('--live')) {
    const submitted = decode(await client.callTool({ name: 'claude_submit_task', arguments: {
      request_id: randomUUID(), project: Object.keys(config.projects)[0], model: 'haiku', effort: 'low',
      prompt: 'Responda exatamente PONTE_OK. Não use ferramentas.'
    } }));
    let task = submitted;
    while (task.status === 'running') {
      await new Promise(done => setTimeout(done, 2000));
      task = decode(await client.callTool({ name: 'claude_get_task', arguments: { task_id: task.id } }));
    }
    console.log(JSON.stringify(task, null, 2));
    if (task.status !== 'succeeded' || task.result.trim() !== 'PONTE_OK') process.exitCode = 1;
  }
} finally { await client.close(); }
