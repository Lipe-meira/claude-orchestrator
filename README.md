# Claude Orchestrator

Primeiro protótipo da ponte ChatGPT → MCP → Claude Code no Windows, sem Codex na operação e sem API da OpenAI. O ChatGPT mantém o plano e avalia as entregas; o Claude recebe tarefas delimitadas. Nesta versão, o executor só tem ferramentas de leitura (`Read`, `Glob`, `Grep`). Edição, execução de comandos e roteamento automático ficam para depois de validar a conexão no Chat normal.

## Estado real

- Servidor MCP por stdio e cliente de diagnóstico/teste.
- Submissão, consulta paginada, cancelamento, retomada de sessão desta ponte e histórico local.
- Modelo e esforço explícitos; sem fallback ou repetição automática que aumente consumo.
- Só um processo servidor deve usar cada pasta de estado. Não rode dois clientes/servidores simultaneamente sobre a mesma configuração.
- Integração ponta a ponta no Chat normal **ainda não validada**.

## Preparar no Windows

Requisitos: Node.js 22+, Claude Code recente (desenvolvido com 2.1.322), login válido via `claude auth login`. Esta ponte usa o login local; não configure uma chave de API para ela.

```powershell
npm.cmd ci
Copy-Item orchestrator.config.example.json orchestrator.config.json
npm.cmd run doctor
npm.cmd test
npm.cmd run smoke
```

No arquivo `orchestrator.config.json`, cadastre apelidos e pastas dos projetos autorizados. Caminhos relativos são resolvidos em relação ao arquivo, não ao terminal. `claudeCommand` aceita `claude` pelo PATH ou caminho absoluto de `claude.exe`. Não use `.cmd` ou uma linha de shell. O arquivo de configuração e `.orchestrator/` ficam fora do Git.

Teste real, que **consome uma chamada da sua conta Claude**:

```powershell
npm.cmd run smoke -- --live
```

O teste descobre as ferramentas MCP, envia uma pergunta curta ao Haiku com esforço baixo e verifica `PONTE_OK`. Se a combinação não estiver disponível na sua conta, o erro é mostrado, sem trocar de modelo sozinho.

## Conectar ao ChatGPT normal

A conexão no Chat normal é uma etapa separada. Não confunda teste MCP local com plugin funcionando no Chat.

1. Confira em ChatGPT → Plugins → botão + se sua conta oferece **Add custom MCP server** e conexão **Tunnel**.
2. O caminho preferido é o [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), conectado a este servidor stdio. Ele exige um `tunnel_id`, uma chave de API de runtime para o `tunnel-client` e permissões da organização/workspace. Não usamos a API de modelos da OpenAI, mas esta opção de transporte requer uma credencial da Platform. Confira também se a versão atual do cliente oferece suporte ao seu ambiente Windows.
3. Inicie o servidor do túnel com `node <caminho absoluto>/src/server.mjs`, definindo `ORCHESTRATOR_CONFIG` como o caminho absoluto do seu arquivo de configuração. Não publique arquivos de credenciais do túnel.
4. Cadastre a conexão real e confira as quatro ferramentas. Abra um novo Chat normal, selecione o plugin e peça uma pergunta simples ao Claude.
5. Só considere concluído após a resposta aparecer no Chat normal.

Alternativa futura: transporte HTTP autenticado e HTTPS. Não está implementado neste protótipo. Não exponha stdio ou um terminal genérico à internet.

O pacote `plugin.json` + `mcp.json` descreve a execução local para um host compatível. Precisa de dependências instaladas e configuração acessível no host; não é um ZIP independente pronto para distribuição. Plugins desktop com execução local são limitados a conversas locais; esse pacote sozinho não resolve o Chat normal hospedado. Fontes oficiais: [plugins](https://learn.chatgpt.com/docs/plugins), [conexão e testes](https://developers.openai.com/plugins/deploy/connect-chatgpt), [limites de plugins locais](https://developers.openai.com/plugins/deploy/desktop-only).

## Ferramentas

| Ferramenta | Uso |
| --- | --- |
| `orchestrator_status` | Projetos disponíveis, modo e tarefa ativa; sem chamada ao Claude |
| `claude_submit_task` | `request_id`, `project`, `prompt`, `model`, `effort`, `resume_task_id` opcional |
| `claude_get_task` | `task_id`, `offset`, `limit`; sem chamada ao Claude |
| `claude_cancel_task` | Encerra a tarefa ativa e seus subprocessos no Windows |

Após enviar, consulte o ID retornado com intervalos razoáveis. Repetir o mesmo `request_id` e parâmetros recupera a tarefa; trocar os parâmetros com o mesmo ID retorna erro. Uma sessão pode ser retomada usando `resume_task_id` de uma tarefa bem-sucedida no mesmo projeto. Não toma controle de uma janela do CMD já aberta.

## Limites e consumo

Permissões usam `--restricted`, `--safe-mode`, ferramentas de leitura explícitas, MCPs externos desabilitados e negação de prompts não atendidos. Isso reduz a superfície de acesso, mas **não substitui isolamento do sistema operacional**. Arquivos lidos pelo Claude podem ir à Anthropic, e resultados retornados ao ChatGPT vão à OpenAI. Cadastre somente pastas apropriadas; esta versão não adiciona filtro próprio de arquivos secretos dentro delas.

Histórico local contém prompts e respostas. Exclua-o conforme sua política de retenção. Logs/resultados completos não são publicados no Git. A saída retornada é paginada para evitar trazer relatórios enormes ao chat; limite do processo: 2 MB e 120 s por padrão. Cancelar não desfaz consumo já realizado.

Tokens, cache e custo estimado são os valores reportados pelo CLI. O custo em dólares não comprova cobrança extra ou saldo da assinatura. Modelos, esforço e limites dependem da conta; combinações incompatíveis falham claramente. A ferramenta não implementa orçamento rígido por tokens nem garante economia.

O servidor não acorda uma conversa encerrada nem mantém um coordenador autônomo. Depois de reiniciar, tarefas em andamento ficam `interrupted`; confira processos anteriores antes de reenviá-las.

## Próximas entregas

1. Validar conexão e resposta no Chat normal da conta.
2. Persistir plano, dependências e critérios de aceitação.
3. Medir consumo por tarefa e definir regras de escolha/escalonamento com limites explícitos.
4. Adicionar execução de alterações somente com o escopo e as permissões definidos.

Referência do executor: [Claude Code CLI](https://code.claude.com/docs/en/cli-reference).
