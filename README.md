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

Para atualizar, execute `codex plugin marketplace upgrade antigravity-mcp-bridge` e `codex plugin add antigravity@antigravity-mcp-bridge`. Abra uma **nova conversa** depois da instalação ou atualização. Peça, por exemplo: “Use `$antigravity` para implementar esta mudança e revisar o resultado.” A skill orienta a escolha de modelos, o acompanhamento da tarefa e a revisão final. Sessões já abertas não recarregam as ferramentas do plugin. Se o aplicativo não encontrar `agy`, configure `AGY_PATH` no ambiente em que o Codex é iniciado.

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
| `antigravity_preview` | Mostra A/M/D, totais de linhas, estatísticas por arquivo, patch, hash e testes relatados |
| `antigravity_record_test` | Registra comando, saída e exit code relatados pelo cliente, vinculados ao hash |
| `antigravity_verify` | Confere critérios da tarefa e evidências de revisão contra arquivos reais |
| `antigravity_integrate` | Solicita confirmação via MCP e aplica o patch revisado ao original |
| `antigravity_tasks` | Recupera IDs e metadados de tarefas persistidas localmente |
| `antigravity_status` | Consulta estado, processo, sessão, uso e snapshots Git |
| `antigravity_events` | Lê eventos após um cursor `after` |
| `antigravity_result` | Consulta o resultado ou informa `ready: false` |
| `antigravity_discard` | Remove a cópia e o baseline de uma tarefa finalizada |
| `antigravity_cleanup` | Remove cópias finalizadas cujo prazo de retenção expirou |
| `antigravity_cancel` | Cancela tarefa na fila ou encerra o processo local |
| `antigravity_sessions` | Lista sessões conhecidas no estado local |
| `antigravity_resume` | Retoma uma conversa conhecida pelo `sessionId` |

`antigravity_run` recebe `prompt`, `workingDirectory` absoluto na raiz de um repositório Git e, opcionalmente, `model`, `timeoutSeconds`, `mode` e `includePaths` (arquivos ou pastas relativos à raiz). Sem `includePaths`, copia todos os arquivos rastreados e não rastreados que **não** correspondam a `.gitignore`, `.git/info/exclude` ou às outras regras de ignore do Git. O filtro também exclui arquivos rastreados que passaram a ser ignorados. `includePaths` apenas reduz essa seleção; não permite incluir arquivos ignorados. Links simbólicos e caminhos fora da raiz são recusados. Consulte `antigravity_list_models` antes de selecionar um modelo.

Para revisão, diagnóstico ou segunda opinião, passe `mode: "read-only"`. O bridge exige suporte a `agy --mode plan`, confere ao final que nenhum arquivo foi criado, modificado ou removido (inclusive arquivos novos ignorados pelo Git) e recusa integração dessas tarefas. Esse modo é uma restrição do CLI com verificação posterior, sem garantia de bloqueio físico de escrita. O padrão `mode: "write"` preserva o fluxo de implementação na cópia. Uma sessão retomada mantém seu modo original.

Fluxo típico:

1. Consulte `antigravity_health` e `antigravity_list_models`.
2. Inicie a tarefa com `antigravity_run` e guarde o `taskId`.
3. Leia `antigravity_events` com `after: 0` e continue usando `nextCursor`.
4. Consulte `antigravity_result` até `ready: true`.
5. Use `antigravity_preview` para revisar o patch e executar os testes na cópia. Registre cada execução com `antigravity_record_test` (`command`, `exitCode`, `output` e `expectedSha256`). Chame `antigravity_integrate` com o `taskId` e o `sha256` da prévia para solicitar a confirmação final pelo cliente MCP. O bridge recusa integração se a cópia ou os arquivos afetados no original mudaram após a revisão.

A integração exige suporte do cliente a **MCP form elicitation**. `antigravity_health` informa `integrationApproval.available`. O formulário mostra origem, tarefa, hash, arquivos e contagens de linhas; só `accept` com `confirm: true` permite aplicar. Recusa, cancelamento, timeout ou falta de suporte preservam o original. O hash identifica o patch e a confirmação vem de uma resposta separada do cliente; nenhum argumento `approved` é aceito como autorização. Após a resposta, o bridge confere novamente hash e origem. A confirmação depende de um cliente confiável que apresente a decisão ao usuário.

## Verificação dos resultados

Defina `acceptanceCriteria` antes de iniciar uma tarefa. Cada critério tem `id`, `description` e, opcionalmente, `check` com `kind`, `path` e `text`. As verificações disponíveis são `file-exists`, `file-absent`, `file-contains` e `file-not-contains`; as duas últimas exigem `text`. Critérios são preservados em retomadas e não podem ser substituídos depois da execução.

Após revisar o patch, chame `antigravity_verify` com o hash atual e `reviews`. Para cada critério, informe `criterionId`, `verdict` (`passed`, `failed` ou `unverified`), `path`, `line`, `quote` e `explanation`. O bridge lê os arquivos da cópia, executa as verificações e confere se a citação corresponde exatamente à linha indicada. Uma alegação do Gemini, um resultado `SUCCESS` ou um registro de teste do cliente não substitui essas evidências.

A integração exige todos os critérios aprovados e uma revisão atual. Critérios ausentes ou pendentes geram `VERIFICATION_REQUIRED`. Alterações no patch ou nos arquivos usados como evidência invalidam a verificação, inclusive alterações em arquivos ignorados que não aparecem no diff. O servidor verifica novamente após a confirmação humana. A prévia inclui `verification` e `stale`.

As verificações automáticas demonstram apenas as condições declaradas; a correção funcional mais ampla depende dos testes pertinentes e da revisão do Codex. O parecer permanece identificado como `client-reported`: conferir uma citação não demonstra que sua interpretação está correta. Esse fluxo aplica a distinção entre alegação e estado final e combina verificações determinísticas com revisão, conforme a [orientação sobre avaliações de agentes](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

## Eventos, sessões e cancelamento

O bridge usa os formatos `stream-json` anunciados pelo `agy` 1.2.11. Eventos estruturados chegam como NDJSON; diagnósticos de `stderr` permanecem separados. Linhas inválidas são expostas como `stream.unparsed`. O `EventStore` mantém um buffer limitado: `truncated: true` indica perda de eventos antigos. Registros de tarefas, sessões, eventos disponíveis e referências às cópias são persistidos por escrita atômica em `~/.antigravity-mcp-bridge` (ou `BRIDGE_STATE_DIRECTORY`). O modelo padrão continua restrito ao processo. O estado contém prompts e resultados: mantenha esse diretório privado, fora dos projetos versionados e de pastas compartilhadas.

`antigravity_resume` usa o `conversation_id` de uma tarefa concluída, inclusive após reinício, e reutiliza sua cópia isolada. Use `antigravity_tasks` para recuperar IDs e `antigravity_sessions` para consultar sessões persistidas. Execuções interrompidas não são repetidas automaticamente: recebem `SERVER_RESTARTED` quando o processo anterior já terminou. Se o PID registrado ainda estiver vivo, a cópia fica bloqueada com `ORPHAN_PROCESS_RUNNING`; o bridge não encerra processos recuperados apenas por PID. Tarefas de outro servidor ativo podem ser acompanhadas, mas devem ser canceladas no servidor que as iniciou. Locks locais impedem uso simultâneo da mesma cópia. O cancelamento encerra o subprocesso local; alterações parciais na cópia podem permanecer e devem ser revisadas.

## Cópia, revisão e integração

Antes de chamar `agy`, o bridge cria uma cópia temporária dos arquivos elegíveis e mantém um baseline Git separado da cópia. O CLI recebe a cópia como diretório de trabalho e a opção `--sandbox`. O projeto original só muda por `antigravity_integrate`, depois da revisão do patch. O bridge não faz commit, merge nem push.

O resultado informa `copyDirectory` e `includedFiles`. Cópias temporárias permanecem para revisão por 7 dias após a última tarefa finalizada. O servidor limpa cópias expiradas na inicialização e a cada minuto; `antigravity_cleanup` permite antecipar a verificação. Use `antigravity_discard` para remover imediatamente uma cópia pelo MCP. Tarefas retomadas compartilham a mesma cópia; todas perdem acesso após descarte. Cópias em uso são preservadas. A expulsão do último registro pelo limite de retenção também remove sua cópia. `isolateWorktree: true` é aceito apenas por compatibilidade e usa o mesmo fluxo de cópia; `false` é recusado.

`antigravity_preview` preserva `files`, `patch` e `sha256` e acrescenta `summary` (totais A/M/D, linhas e arquivos binários), `fileSummaries` (inserções/remoções por caminho) e `tests`. Binários usam `null` nas contagens de linhas. Os testes são relatos do cliente, identificados por `source: "client-reported"`; o bridge não executa nem verifica o comando. Cada registro leva hash, data, exit code e até 4.000 caracteres de saída. Resultados antigos recebem `stale: true` se o patch atual diferir. Falhas são preservadas e devem ser apresentadas na revisão.

A cópia aceita até 10.000 arquivos e 256 MiB por padrão. A seleção é medida antes da criação e os bytes efetivamente copiados são conferidos novamente para detectar crescimento da origem. `includePaths` pode reduzir a seleção. Mais de 100 arquivos alterados gera `CHANGE_LIMIT_EXCEEDED` ao finalizar, revisar ou integrar. O original permanece intacto; reduza a tarefa ou ajuste os limites explicitamente no ambiente do servidor.

## Configuração e segurança

| Variável | Padrão | Uso |
| --- | --- | --- |
| `AGY_PATH` | `agy` | Caminho do CLI oficial |
| `MAX_CONCURRENT_TASKS` | `1` | Processos simultâneos |
| `MAX_QUEUED_TASKS` | `20` | Tarefas aguardando |
| `MAX_RETAINED_TASKS` | `100` | Tarefas persistidas retidas |
| `DEFAULT_TIMEOUT_SECONDS` | `1800` | Prazo máximo por execução |
| `EVENT_BUFFER_SIZE` | `2000` | Eventos mantidos em memória |
| `BRIDGE_STATE_DIRECTORY` | `~/.antigravity-mcp-bridge` | Diretório privado de tarefas e sessões |
| `MAX_COPY_FILES` | `10000` | Máximo de arquivos selecionados para a cópia |
| `MAX_COPY_BYTES` | `268435456` | Máximo de bytes copiados (256 MiB) |
| `MAX_CHANGED_FILES` | `100` | Máximo de arquivos alterados para revisão e integração |
| `COPY_RETENTION_HOURS` | `168` | Prazo de retenção das cópias finalizadas |
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

`npm test` usa um mock do `agy` e não consome quota. A integração real é opcional: `npm run test:integration` cria um repositório descartável, executa uma tarefa pelo cliente MCP, confere que o original permanece intacto até a integração e remove o repositório. Esse teste simula a resposta de confirmação somente para seu projeto descartável; a confirmação humana da interface deve ser usada nos projetos reais. Execute-a apenas com `agy` autenticado e quando quiser usar a conta real.

## Licença e políticas

O projeto usa a [licença MIT](LICENSE). Consulte a [política de segurança](SECURITY.md), a [política de privacidade](PRIVACY.md), o [histórico de versões](CHANGELOG.md) e os [avisos das dependências distribuídas](THIRD_PARTY_NOTICES.md). `npm run build:plugin` atualiza o bundle e os avisos a partir das dependências efetivamente incluídas.
