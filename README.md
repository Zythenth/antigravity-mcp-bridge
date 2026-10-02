# Antigravity MCP Bridge

Servidor MCP local para delegar tarefas de programação ao Google Antigravity por meio do CLI oficial `agy`. O Codex pode iniciar tarefas, acompanhar eventos, consultar resultados e cancelar processos. O projeto é independente e não é afiliado ao Google ou à OpenAI.

```text
Codex -- MCP stdio --> bridge -- subprocesso --> agy oficial --> Antigravity
Codex <-- eventos e resultado estruturados <-- bridge <-- stdout/stderr
```

O bridge não acessa endpoints privados, cookies ou arquivos de autenticação. A comunicação com o serviço é feita pelo próprio `agy`.

## Requisitos

- Node.js 24 ou mais recente e npm.
- Git instalado e disponível no `PATH`.
- [Antigravity CLI oficial](https://www.antigravity.google/docs/cli/overview/) instalado e disponível no `PATH`. Você também pode definir `AGY_PATH` com o caminho absoluto do executável.
- Autenticação concluída no `agy` interativo. Consulte a [documentação oficial do modo headless](https://www.antigravity.google/docs/cli/headless/).

O bridge foi testado com `agy` 1.2.14 e `@modelcontextprotocol/sdk` 1.30.1. Ele exige que o CLI anuncie `--sandbox` e `stream-json`; versões futuras podem exigir adaptação. Consulte abaixo a limitação observada na execução de testes no Windows.

## Instalação

### Servidor MCP via npm/npx

Para iniciar o servidor pelo pacote npm 0.4.0, configure seu cliente MCP com:

```json
{
  "mcpServers": {
    "antigravity": {
      "command": "npx",
      "args": ["--yes", "antigravity-mcp-bridge@0.4.0"]
    }
  }
}
```

No Windows, clientes que exigem o nome completo do comando podem usar `npx.cmd`. O executável inicia o servidor em stdio; não é um comando interativo. O pacote contém o servidor compilado e os avisos das dependências incluídas. Node.js 24, Git e o `agy` autenticado continuam necessários. Para validar uma versão ainda não publicada, use `npm run build:plugin`, `npm pack` e o tarball local com `npx --yes --package <caminho-do-tarball> antigravity-mcp-bridge`.

### Instalação pelo código-fonte

Os exemplos PowerShell usam `npm.cmd`, o lançador do npm para Windows, que funciona mesmo quando a política de execução bloqueia `npm.ps1`. Em outros shells, use `npm`.

```powershell
git clone https://github.com/Zythenth/antigravity-mcp-bridge.git
cd antigravity-mcp-bridge
npm.cmd ci
npm.cmd run build:plugin
npm.cmd test
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

Todas as ferramentas publicam `outputSchema` com campos e tipos de suas respostas estruturadas. O contrato contempla sucesso e `error: { code, message }`. O SDK confere os campos obrigatórios antes de entregar respostas de sucesso; clientes também podem validar o JSON recebido. Dados brutos do CLI continuam com tipo aberto porque seu formato pertence ao provedor. O contrato não transforma uma alegação do modelo em prova de execução.

| Ferramenta | Função |
| --- | --- |
| `antigravity_health` | Verifica executável, versão, autenticação aparente e capacidades |
| `antigravity_list_models` | Lista os IDs devolvidos por `agy models` |
| `antigravity_get_model` / `antigravity_set_model` | Consulta ou persiste o modelo padrão; `null` seleciona Auto |
| `antigravity_run` | Inicia uma tarefa e retorna o `taskId` |
| `antigravity_list_project_files` | Lista os arquivos elegíveis para a cópia |
| `antigravity_preview` | Mostra A/M/D, totais de linhas, estatísticas por arquivo, patch, hash e testes relatados |
| `antigravity_record_test` | Registra comando, saída e exit code relatados pelo cliente, vinculados ao hash |
| `antigravity_test` | Executa testes pelo terminal do agy com sandbox nativo e captura recibos reais |
| `antigravity_verify` | Confere critérios da tarefa e evidências de revisão contra arquivos reais |
| `antigravity_read_patch` | Lê o patch por arquivo ou em trechos vinculados ao hash completo |
| `antigravity_read_result` | Lê o JSON final do CLI em trechos com hash de conteúdo |
| `antigravity_usage` | Consolida tokens observados por tarefa, sessão e modelo |
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

### Consumo de tokens

`antigravity_status` e `antigravity_result` incluem `task.tokenUsage`. `antigravity_usage` consolida as tarefas retidas e aceita filtros por `taskId`, `sessionId` e `model`. A resposta contém `byTask`, `bySession`, `byModel` e os contadores `inputTokens`, `outputTokens`, `totalTokens`, `thinkingTokens` e `cacheReadTokens`.

O [resultado final do agy informa uso cumulativo da sessão](https://www.antigravity.google/docs/cli/headless/#read-the-results). O bridge salva os contadores anteriores ao retomar e usa a diferença para a tarefa seguinte, inclusive quando o modelo muda. Assim, duas respostas cumulativas de 120 e 170 tokens representam 170 tokens na sessão e 50 na segunda tarefa. `observedCumulative` preserva o último total de sessão informado pelo CLI, separado do consumo das tarefas retidas.

Contadores ausentes, inválidos, reiniciados ou sem baseline conhecido ficam `null`; `available`, `partial`, `source` e `warnings` indicam a qualidade dos dados. Não há estimativa de tokens nem substituição silenciosa por zero. O consumo de tarefas falhas também é incluído quando o CLI devolve os contadores finais. Antes desse resultado, o total da tarefa pode estar indisponível. Tarefas antigas removidas pela retenção deixam de compor o consolidado local. Modelo `null` significa que não foi informado um ID; não se presume um modelo padrão.

Esses números são relatos do CLI, sem cálculo de cobrança ou acesso à quota global da conta. Cache e raciocínio são dimensões separadas e não devem ser somados novamente a `totalTokens`. A skill orienta o Codex a informar o consumo disponível ao concluir ou relatar falhas.

### Papéis de trabalho

`antigravity_run` aceita `role: "implementer"` (padrão), `"planner"` ou `"reviewer"`. Planejamento e revisão usam obrigatoriamente `mode: "read-only"` e `agy --mode plan`; selecionar escrita nesses papéis é recusado. A retomada mantém o papel original.

Os papéis de consulta exigem suporte a `agy --json-schema`. O planejamento devolve `summary`, `steps` com arquivos e verificações observáveis, e `unverified`. A revisão devolve `summary`, `reviewedFiles`, `findings` e `unverified`; cada achado contém gravidade P0–P3, caminho, linha, citação literal, mensagem, impacto e sugestão.

O relatório validado aparece em `task.report` na resposta completa. Com resposta compacta, use `antigravity_read_result` para ler o `structured_output` original do CLI. Relatórios são identificados como `agy-reported`; na revisão, `citationsChecked: true` significa que arquivos e citações foram conferidos, sem atestar a interpretação ou provar ausência de defeitos. Formato inválido, arquivos inexistentes ou citações inventadas impedem a conclusão normal da tarefa. Uma resposta de planejamento não significa que suas etapas foram executadas.

### Ler respostas grandes em partes

Use `antigravity_preview` com `includePatch: false` para obter arquivos, estatísticas, hash e `patchLength` sem enviar o diff inteiro. Depois chame `antigravity_read_patch` com `expectedSha256` e, opcionalmente, um `path` devolvido na prévia. A seleção é feita pelo Git, incluindo arquivos binários e caminhos com espaços; não depende de interpretar cabeçalhos do patch. Qualquer alteração do patch completo invalida a leitura, mesmo quando você seleciona apenas um arquivo.

`antigravity_result` aceita `includeResult: false` para omitir o resultado bruto, o prompt e a lista completa de arquivos da cópia. Quando `ready: true`, consulte `antigravity_read_result` para ler o resultado serializado como JSON. Guarde `contentSha256` e envie-o como `expectedContentSha256` nas páginas seguintes para detectar mudanças.

Os leitores recebem `offset` (padrão 0) e `limit` (padrão 10.000, entre 2 e 50.000). Retornam `text`, `nextOffset`, `hasMore`, `totalLength` e `contentSha256`. Concatene `text` até `hasMore: false`; use sempre o `nextOffset` devolvido. Os offsets usam unidades UTF-16 e o leitor preserva caracteres representados por pares substitutos, como emojis. As opções antigas continuam devolvendo o conteúdo inteiro quando os campos de omissão não são usados.

Defina `acceptanceCriteria` antes de iniciar uma tarefa. Cada critério tem `id`, `description` e, opcionalmente, `check` com `kind`, `path` e `text`. As verificações disponíveis são `file-exists`, `file-absent`, `file-contains` e `file-not-contains`; as duas últimas exigem `text`. Critérios são preservados em retomadas e não podem ser substituídos depois da execução.

Após revisar o patch, chame `antigravity_verify` com o hash atual e `reviews`. Para cada critério, informe `criterionId`, `verdict` (`passed`, `failed` ou `unverified`), `path`, `line`, `quote` e `explanation`. O bridge lê os arquivos da cópia, executa as verificações e confere se a citação corresponde exatamente à linha indicada. Uma alegação do Gemini, um resultado `SUCCESS` ou um registro de teste do cliente não substitui essas evidências.

A integração exige todos os critérios aprovados e uma revisão atual. Critérios ausentes ou pendentes geram `VERIFICATION_REQUIRED`. Alterações no patch ou nos arquivos usados como evidência invalidam a verificação, inclusive alterações em arquivos ignorados que não aparecem no diff. O servidor verifica novamente após a confirmação humana. A prévia inclui `verification` e `stale`.

As verificações automáticas demonstram apenas as condições declaradas; a correção funcional mais ampla depende dos testes pertinentes e da revisão do Codex. O parecer permanece identificado como `client-reported`: conferir uma citação não demonstra que sua interpretação está correta. Esse fluxo aplica a distinção entre alegação e estado final e combina verificações determinísticas com revisão, conforme a [orientação sobre avaliações de agentes](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

## Eventos, sessões e cancelamento

O bridge usa os formatos `stream-json` anunciados pelo `agy` 1.2.11. Eventos estruturados chegam como NDJSON; diagnósticos de `stderr` permanecem separados. Linhas inválidas são expostas como `stream.unparsed`. O `EventStore` mantém um buffer limitado: `truncated: true` indica perda de eventos antigos. Registros de tarefas, sessões, eventos disponíveis, preferência de modelo e referências às cópias são persistidos por escrita atômica em `~/.antigravity-mcp-bridge` (ou `BRIDGE_STATE_DIRECTORY`). O estado contém prompts e resultados: mantenha esse diretório privado, fora dos projetos versionados e de pastas compartilhadas.

### Modelo padrão

Defina `BRIDGE_DEFAULT_MODEL` com um ID devolvido por `agy models` para o padrão inicial. `antigravity_set_model` grava a preferência no estado privado, compartilhada por servidores que usam o mesmo diretório. A prioridade é: `model` da tarefa, preferência salva, variável de ambiente e padrão do agy. A seleção é conferida contra a lista atual antes de executar; IDs indisponíveis causam `MODEL_NOT_AVAILABLE`.

Passe `model: null` para Auto: por tarefa, ignora os padrões do bridge; em `antigravity_set_model`, persiste o padrão do agy mesmo quando a variável está configurada. Omitir `model` preserva a preferência vigente. Para voltar ao padrão inicial do ambiente, pare o servidor e remova somente `model-selection.json` do diretório privado de estado.

`antigravity_resume` usa o `conversation_id` de uma tarefa concluída, inclusive após reinício, e reutiliza sua cópia isolada. Use `antigravity_tasks` para recuperar IDs e `antigravity_sessions` para consultar sessões persistidas. Execuções interrompidas não são repetidas automaticamente: recebem `SERVER_RESTARTED` quando o processo anterior já terminou. Se o PID registrado ainda estiver vivo, a cópia fica bloqueada com `ORPHAN_PROCESS_RUNNING`; o bridge não encerra processos recuperados apenas por PID. Tarefas de outro servidor ativo podem ser acompanhadas, mas devem ser canceladas no servidor que as iniciou. Locks locais impedem uso simultâneo da mesma cópia. O cancelamento encerra o subprocesso local; alterações parciais na cópia podem permanecer e devem ser revisadas.

## Cópia, revisão e integração

Antes de chamar `agy`, o bridge cria uma cópia temporária dos arquivos elegíveis e mantém um baseline Git separado da cópia. O CLI recebe a cópia como diretório de trabalho e a opção `--sandbox`. O projeto original só muda por `antigravity_integrate`, depois da revisão do patch. O bridge não faz commit, merge nem push.

Quando o CLI anuncia `--add-dir` e `--new-project`, o bridge declara a cópia como workspace e cria um projeto CLI separado na primeira execução. A retomada preserva o projeto da conversa. Essas opções não equivalem a uma comprovação de todas as fronteiras do sandbox; permissões negadas continuam sendo respeitadas.

O resultado informa `copyDirectory` e `includedFiles`. Cópias temporárias permanecem para revisão por 7 dias após a última tarefa finalizada. O servidor limpa cópias expiradas na inicialização e a cada minuto; `antigravity_cleanup` permite antecipar a verificação. Use `antigravity_discard` para remover imediatamente uma cópia pelo MCP. Tarefas retomadas compartilham a mesma cópia; todas perdem acesso após descarte. Cópias em uso são preservadas. A expulsão do último registro pelo limite de retenção também remove sua cópia. `isolateWorktree: true` é aceito apenas por compatibilidade e usa o mesmo fluxo de cópia; `false` é recusado.

`antigravity_preview` preserva `files`, `patch` e `sha256` e acrescenta `summary` (totais A/M/D, linhas e arquivos binários), `fileSummaries` (inserções/remoções por caminho) e `tests`. Binários usam `null` nas contagens de linhas. Registros de `antigravity_record_test` têm `source: "client-reported"`: são relatos cujo comando o bridge não executou. Registros capturados por `antigravity_test` têm `source: "agy-tool"` e incluem o recibo observado do terminal. Cada registro leva hash, data, exit code e até 4.000 caracteres de saída. Resultados antigos recebem `stale: true` quando a evidência já não corresponde aos arquivos atuais. Falhas são preservadas e devem ser apresentadas na revisão.

A cópia aceita até 10.000 arquivos e 256 MiB por padrão. A seleção é medida antes da criação e os bytes efetivamente copiados são conferidos novamente para detectar crescimento da origem. `includePaths` pode reduzir a seleção. Mais de 100 arquivos alterados gera `CHANGE_LIMIT_EXCEEDED` ao finalizar, revisar ou integrar. O original permanece intacto; reduza a tarefa ou ajuste os limites explicitamente no ambiente do servidor.

### Executar testes sem Docker

Chame `antigravity_test` com `taskId`, `expectedSha256` e `command: { executable, args }`. A ferramenta inicia uma continuação na mesma cópia e devolve outro `taskId`. Acompanhe esse ID pelos eventos e pelo resultado; revise e integre a tarefa mais recente. `retries` vale 0 por padrão e aceita até 3 tentativas de correção adicionais, solicitadas explicitamente. `timeoutSeconds` vale 600 por padrão.

O executor usa `agy --sandbox` e a ferramenta nativa `run_command`. Não exige Docker nem executa o comando diretamente no host como alternativa. Um runner temporário, conferido por SHA-256 antes da execução, captura saída, exit code e fingerprints dos arquivos elegíveis antes/depois do teste. O bridge aceita o recibo apenas no evento da chamada exata do terminal; uma mensagem do Gemini dizendo que o teste passou não conta. Os registros têm `source: "agy-tool"` e `sandbox: "agy-native-requested"`. A saída é limitada a 4.000 caracteres, com indicação de truncamento.

Se o CLI negar a ferramenta ou omitir o recibo, o resultado é `TEST_EXECUTION_UNVERIFIED`. Um comando não zero produz `TEST_FAILED`; mudanças nos arquivos durante/depois do comando produzem `TEST_CHANGED_PATCH`. Testes observados precisam continuar atuais para a integração; um relato manual não substitui um teste observado falho. Após `TEST_FAILED`, é possível retomar a conversa para corrigir ou executar os testes novamente. A orientação de correção mantém o comando original e proíbe enfraquecer os testes; tentativas observadas além do limite encerram a tarefa.

No Windows, use executáveis nativos como `node.exe` e `python.exe`; para npm, use `npm.cmd`. Arquivos `.cmd`/`.bat` aceitam argumentos comuns, mas metacaracteres de shell são recusados. A execução depende das permissões do sandbox nativo do CLI. Uma restrição de terminal não demonstra isolamento de todas as ferramentas do agente nem permite afirmar proteção completa do sistema de arquivos. Consulte a [configuração oficial do sandbox](https://www.antigravity.google/docs/sandbox/) e os [eventos de ferramentas no modo headless](https://www.antigravity.google/docs/cli/headless/#tool-calls-in-the-stream).

No teste real com `agy` 1.2.14 no Windows, o CLI negou o terminal com `escalate_admin`/`Bash`, inclusive com `enableTerminalSandbox: true` e `toolPermission: "proceed-in-sandbox"`. A captura de comandos nesse ambiente permanece sem validação real. O bridge preserva `TEST_EXECUTION_UNVERIFIED` e não considera a narrativa do modelo como teste aprovado. Os testes automatizados do repositório usam um CLI simulado e não substituem essa validação de compatibilidade.

Para testar com a conta real em um projeto descartável, execute `npm run build` e `node tests/native-integration.mjs`. Esse teste usa a conta do agy e verifica a captura de uma execução real; a suíte padrão usa o CLI simulado e não consome quota.

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
| `BRIDGE_DEFAULT_MODEL` | vazio | Modelo inicial, usado quando não há preferência salva |
| `MAX_COPY_FILES` | `10000` | Máximo de arquivos selecionados para a cópia |
| `MAX_COPY_BYTES` | `268435456` | Máximo de bytes copiados (256 MiB) |
| `MAX_CHANGED_FILES` | `100` | Máximo de arquivos alterados para revisão e integração |
| `COPY_RETENTION_HOURS` | `168` | Prazo de retenção das cópias finalizadas |
| `MAX_PROMPT_CHARS` | `50000` | Tamanho máximo do prompt enviado, incluindo critérios e instruções do bridge |
| `FORBIDDEN_DIRECTORIES` | vazio | Diretórios bloqueados, separados por `;` no Windows |

Entradas e diretórios são validados. O processo é iniciado com `spawn` sem shell e exige `--sandbox`; não passa `--dangerously-skip-permissions`. Não inclua credenciais ou documentos privados nos prompts. O sandbox do CLI restringe comandos de terminal, mas não constitui garantia de isolamento completo do sistema de arquivos no Windows. Mantenha arquivos sensíveis fora da cópia por regras de ignore e selecione apenas os caminhos necessários com `includePaths`. Consulte a [documentação do sandbox](https://antigravity.google/docs/sandbox/) e [do modo headless](https://www.antigravity.google/docs/cli/headless/).

Erros comuns incluem `AGY_NOT_FOUND`, `AGY_AUTH_REQUIRED`, `MODEL_NOT_AVAILABLE`, `INVALID_WORKING_DIRECTORY`, `QUEUE_FULL` e `AGY_PROCESS_FAILED`. Se houver `AGY_AUTH_REQUIRED`, faça login no `agy` interativo. Se as ferramentas não aparecerem no Codex, confirme a instalação com `codex plugin list --json` e abra uma conversa nova.

## Testes

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build:plugin
npm.cmd run test:package
```

`npm test` usa um mock do `agy` e não consome quota. A integração real é opcional: `npm run test:integration` cria um repositório descartável, executa uma tarefa pelo cliente MCP, confere que o original permanece intacto até a integração e remove o repositório. Esse teste simula a resposta de confirmação somente para seu projeto descartável; a confirmação humana da interface deve ser usada nos projetos reais. Execute-a apenas com `agy` autenticado e quando quiser usar a conta real.

## Licença e políticas

O projeto usa a [licença MIT](LICENSE). Consulte a [política de segurança](SECURITY.md), a [política de privacidade](PRIVACY.md), o [histórico de versões](CHANGELOG.md) e os [avisos das dependências distribuídas](THIRD_PARTY_NOTICES.md). `npm run build:plugin` atualiza o bundle e os avisos a partir das dependências efetivamente incluídas.
