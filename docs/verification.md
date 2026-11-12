# Verificação do primeiro protótipo

Data: 12/11/2026. Ambiente: Windows, Node.js 24.21.0, Claude Code 2.1.322, autenticação local claude.ai.

- `npm.cmd test`: 10 testes passando, incluindo entrada por stdin, caracteres Unicode, projeto não autorizado, idempotência, retomada, erro do executor, timeout, cancelamento e recuperação de estado.
- `npm.cmd run doctor`: executável localizado e login válido, sem publicar dados pessoais da conta.
- `npm.cmd run smoke`: inicialização MCP, descoberta das quatro ferramentas e chamada de status aprovadas.
- `npm.cmd run smoke -- --live`: chamada MCP → Claude Code → Haiku com esforço baixo retornou exatamente `PONTE_OK`, status `succeeded`, em aproximadamente 14 segundos. Nenhuma ferramenta solicitada ou permissão negada.
- CLI reportou 2 tokens de entrada sem cache, 2.707 de criação de cache, 3.232 de leitura de cache e 9 de saída. Mostra que até uma pergunta curta tem custo de contexto; não é evidência de economia em tarefas reais.
- `npm audit`: zero vulnerabilidades reportadas após atualização de Zod para 4.6.7.

Não verificado: chamada pelo Chat normal; uso real de Read/Glob/Grep; continuidade em sessão real; disponibilidade de todos os modelos/esforços. As rotas de retomada e negação foram verificadas com um executor de teste.

Tentativa de abrir `chatgpt.com/plugins` pelo navegador integrado encontrou página sem sessão autenticada. Não foi criada conexão, túnel ou chave. O teste local não comprova a disponibilidade do plugin no Chat normal da conta.
