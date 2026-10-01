# Antigravity MCP Bridge

Servidor MCP local para delegar tarefas de programação ao Google Antigravity por meio do CLI oficial `agy`. O Codex pode iniciar tarefas, acompanhar eventos, consultar resultados e cancelar processos. O projeto é independente e não é afiliado ao Google ou à OpenAI.

```text
Codex -- MCP stdio --> bridge -- subprocesso --> agy oficial --> Antigravity
Codex <-- eventos e resultado estruturados <-- bridge <-- stdout/stderr
```

O bridge não acessa endpoints privados, cookies ou arquivos de autenticação. A comunicação com o serviço é feita pelo próprio `agy`.

## Requisitos

- Node.js 24 ou mais recente e npm.
- [Antigravity CLI oficial](https://www.antigravity.google/docs/cli/overview/) instalado e disponível no `PATH`. Você também pode definir `AGY_PATH` com o caminho absoluto do executável.
- Autenticação concluída no `agy` interativo. Consulte a [documentação oficial do modo headless](https://www.antigravity.google/docs/cli/headless/).

O bridge foi testado com `agy` 1.2.12 e `@modelcontextprotocol/sdk` 1.30.1. Ele exige que o CLI anuncie `--sandbox` e `stream-json`; versões futuras podem exigir adaptação.

## Instalação

```powershell
git clone https://github.com/Zythenth/antigravity-mcp-bridge.git
cd antigravity-mcp-bridge
npm ci
npm run build:plugin
npm test
```

`npm run build:plugin` compila o servidor e gera `plugin/server.mjs`. Esse arquivo também acompanha o repositório para que o plugin possa ser instalado sem executar o build. `npm start` inicia o servidor MCP em stdio; a saída padrão fica reservada para JSON-RPC.

### Instalar como plugin do Codex

O repositório contém um catálogo em `.agents/plugins/marketplace.json` e o plugin em `plugin/`. Instale o catálogo e o plugin:

```powershell
codex plugin marketplace add Zythenth/antigravity-mcp-bridge
codex plugin add antigravity@antigravity-mcp-bridge
```

Abra uma **nova conversa** depois da instalação. Peça, por exemplo: “Use `$antigravity` para implementar esta mudança e revisar o resultado.” A skill orienta a escolha de modelos, o acompanhamento da tarefa e a revisão final. Sessões já abertas não recarregam as ferramentas do plugin. Se o aplicativo não encontrar `agy`, configure `AGY_PATH` no ambiente em que o Codex é iniciado.

O [guia oficial de plugins](https://developers.openai.com/plugins/build/plugins) explica o formato do catálogo e outras opções de instalação.

### Registrar somente o servidor MCP

Para usar o bridge sem a skill do plugin, compile o projeto e registre o servidor:

```powershell
$server = (Resolve-Path .\dist\src\index.js).Path
codex mcp add antigravity -- node $server
```

Há também um [exemplo de configuração TOML](codex-mcp-example.toml). Use **uma** forma de registro por vez para evitar ferramentas duplicadas.

## Ferramentas

| Ferramenta | Função |
| --- | --- |
| `antigravity_health` | Verifica executável, versão, autenticação aparente e capacidades |
| `antigravity_list_models` | Lista os IDs devolvidos por `agy models` |
| `antigravity_get_model` / `antigravity_set_model` | Consulta ou define o modelo padrão em memória |
| `antigravity_run` | Inicia uma tarefa e retorna o `taskId` |
| `antigravity_list_project_files` | Lista os arquivos elegíveis para a cópia |
| `antigravity_preview` | Mostra os arquivos alterados, patch e hash para revisão |
| `antigravity_integrate` | Aplica o patch revisado ao projeto original após aprovação |
| `antigravity_status` | Consulta estado, processo, sessão, uso e snapshots Git |
| `antigravity_events` | Lê eventos após um cursor `after` |
| `antigravity_result` | Consulta o resultado ou informa `ready: false` |
| `antigravity_cancel` | Cancela tarefa na fila ou encerra o processo local |
| `antigravity_sessions` | Lista sessões vistas pela instância atual do bridge |
| `antigravity_resume` | Retoma uma conversa conhecida pelo `sessionId` |

`antigravity_run` recebe `prompt`, `workingDirectory` absoluto na raiz de um repositório Git e, opcionalmente, `model`, `timeoutSeconds` e `includePaths` (arquivos ou pastas relativos à raiz). Sem `includePaths`, copia todos os arquivos rastreados e não rastreados que **não** correspondam a `.gitignore`, `.git/info/exclude` ou às outras regras de ignore do Git. O filtro também exclui arquivos rastreados que passaram a ser ignorados. `includePaths` apenas reduz essa seleção; não permite incluir arquivos ignorados. Links simbólicos e caminhos fora da raiz são recusados. Consulte `antigravity_list_models` antes de selecionar um modelo.

Fluxo típico:

1. Consulte `antigravity_health` e `antigravity_list_models`.
2. Inicie a tarefa com `antigravity_run` e guarde o `taskId`.
3. Leia `antigravity_events` com `after: 0` e continue usando `nextCursor`.
4. Consulte `antigravity_result` até `ready: true`.
5. Use `antigravity_preview` para revisar o patch e executar os testes na cópia. Após aprovação do usuário, chame `antigravity_integrate` com o `taskId` e o `sha256` da prévia. O bridge recusa integração se a cópia ou os arquivos afetados no original mudaram após a revisão.

## Eventos, sessões e cancelamento

O bridge usa os formatos `stream-json` anunciados pelo `agy` 1.2.11. Eventos estruturados chegam como NDJSON; diagnósticos de `stderr` permanecem separados. Linhas inválidas são expostas como `stream.unparsed`. O `EventStore` mantém um buffer limitado em memória: `truncated: true` indica perda de eventos antigos. Tarefas, eventos e modelos selecionados em memória desaparecem ao reiniciar o servidor.

`antigravity_resume` usa o `conversation_id` de uma tarefa concluída nesta instância e reutiliza sua cópia isolada. `antigravity_sessions` não lista conversas antigas desconhecidas pelo processo atual. O cancelamento encerra o subprocesso local; alterações parciais na cópia podem permanecer e devem ser revisadas.

## Cópia, revisão e integração

Antes de chamar `agy`, o bridge cria uma cópia temporária dos arquivos elegíveis e mantém um baseline Git separado da cópia. O CLI recebe a cópia como diretório de trabalho e a opção `--sandbox`. O projeto original só muda por `antigravity_integrate`, depois da revisão do patch. O bridge não faz commit, merge nem push.

O resultado informa `copyDirectory` e `includedFiles`. Cópias temporárias permanecem para revisão até sua remoção manual. `isolateWorktree: true` é aceito apenas por compatibilidade e usa o mesmo fluxo de cópia; `false` é recusado.

## Configuração e segurança

| Variável | Padrão | Uso |
| --- | --- | --- |
| `AGY_PATH` | `agy` | Caminho do CLI oficial |
| `MAX_CONCURRENT_TASKS` | `1` | Processos simultâneos |
| `MAX_QUEUED_TASKS` | `20` | Tarefas aguardando |
| `MAX_RETAINED_TASKS` | `100` | Tarefas mantidas em memória |
| `DEFAULT_TIMEOUT_SECONDS` | `1800` | Prazo máximo por execução |
| `EVENT_BUFFER_SIZE` | `2000` | Eventos mantidos em memória |
| `MAX_PROMPT_CHARS` | `50000` | Tamanho máximo do prompt |
| `FORBIDDEN_DIRECTORIES` | vazio | Diretórios bloqueados, separados por `;` no Windows |

Entradas e diretórios são validados. O processo é iniciado com `spawn` sem shell e exige `--sandbox`; não passa `--dangerously-skip-permissions`. Não inclua credenciais ou documentos privados nos prompts. O sandbox do CLI restringe comandos de terminal, mas não constitui garantia de isolamento completo do sistema de arquivos no Windows. Mantenha arquivos sensíveis fora da cópia por regras de ignore e selecione apenas os caminhos necessários com `includePaths`. Consulte a [documentação do sandbox](https://antigravity.google/docs/sandbox/) e [do modo headless](https://www.antigravity.google/docs/cli/headless/).

Erros comuns incluem `AGY_NOT_FOUND`, `AGY_AUTH_REQUIRED`, `MODEL_NOT_AVAILABLE`, `INVALID_WORKING_DIRECTORY`, `QUEUE_FULL` e `AGY_PROCESS_FAILED`. Se houver `AGY_AUTH_REQUIRED`, faça login no `agy` interativo. Se as ferramentas não aparecerem no Codex, confirme a instalação com `codex plugin list --json` e abra uma conversa nova.

## Testes

```powershell
npm run typecheck
npm run lint
npm test
```

`npm test` usa um mock do `agy` e não consome quota. A integração real é opcional: `npm run test:integration` cria um repositório descartável, executa uma tarefa pelo cliente MCP, confere que o original permanece intacto até a integração e remove o repositório. Execute-a apenas com `agy` autenticado e quando quiser usar a conta real.
