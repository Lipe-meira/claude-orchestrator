let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (prompt === '__WAIT__') await new Promise(done => setTimeout(done, 30000));
if (prompt === '__FAIL__') { console.error('modelo indisponível'); process.exit(1); }
const args = process.argv.slice(2);
const resume = args.indexOf('--resume');
console.log(JSON.stringify({ result: prompt, session_id: resume >= 0 ? args[resume + 1] : '11111111-1111-4111-8111-111111111111',
  usage: { input_tokens: 5, output_tokens: 2 }, total_cost_usd: 0.001,
  permission_denials: prompt === '__DENIED__' ? [{ tool_name: 'Read' }] : [], is_error: false }));
