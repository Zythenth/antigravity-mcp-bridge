# Histórico de versões

## Não publicado

- Configurações e concessões inválidas em `BRIDGE_ALLOWED_ENV_VARS`, `BRIDGE_SECRET_EXCEPTIONS`, `BRIDGE_MCP_CATALOG`, `BRIDGE_CUSTOM_ROLES` e no arquivo de estado `integration-approvals.json` passam a ser ignoradas sem derrubar o servidor MCP nem o `antigravity_health`. Entradas ou arquivos inválidos são ignorados sem conceder nada, mantendo as entradas válidas; o servidor inicia normalmente, emite um aviso único no `stderr` e relata os problemas em `configurationIssues` no `antigravity_health`. A gravação de raízes lembradas em `integration-approvals.json` continua estrita e recusa sobrescrever arquivos inválidos.

- `BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS` passa a ignorar entradas inválidas sem conceder pré-autorização nem derrubar o processo do servidor MCP. Antes, se a variável contivesse JSON malformado ou uma pasta inexistente/renomeada, o servidor encerrava com erro antes do `initialize` e o cliente mostrava apenas "Connection closed". Agora, o servidor inicia normalmente, ignora a entrada inválida sem conceder nenhuma pré-autorização, emite um aviso único no `stderr` e expõe os problemas em `configurationIssues` no `antigravity_health` (com variável, posição opcional e motivo, sem expor caminhos ou valores).

- Comando de terminal somente leitura `wait [--state-directory <dir>] <taskId> [--after <n>] [--timeout <s>]` e metadado `waitCommand` (`{ argv, sh }`) em `antigravity_health`, `antigravity_run`, `antigravity_resume` e `antigravity_handoff`, permitindo aguardar em segundo plano até que a tarefa atinja estado terminal ou publique uma pergunta/bloqueio com `sequence > after`. O comando consulta apenas `<dir>/<taskId>.json` a cada 500 ms (prazo padrão de 1800 s e máximo de 86400 s), não cria diretórios, não grava arquivos nem adquire locks, e encerrá-lo não cancela a tarefa; ao sair, imprime uma única linha JSON (`{ taskId, outcome, exitCode, status, reason, after, cursor[, continuationTaskId] }`) sem expor prompts, corpos de mensagens ou textos de erro e retorna códigos de saída dedicados (`completed` 0, `error` 1, `failed` 2, `cancelled` 3, `timeout` 4, `question` 5, `blocker` 6, `unknown-task` 7, `wait-deadline` 8, `owner-stopped` 9).

- Ferramentas que terminam com erro no stream do agy passam a produzir `tool.failed` com um resumo do erro em `failure`, em vez de permanecerem como `tool.started`; os snapshots deixam de gravar cada frame do agy duas vezes, persistindo `rawIsData` ou `rawEnvelope` e reconstruindo `raw` na leitura (snapshots antigos carregam inalterados; uma versão anterior do bridge que leia um snapshot novo vê os eventos sem `raw`); uma busca de edição que falha sob a política de ferramentas registra em `editSearch` o hash, o tamanho em bytes e a contagem de linhas do trecho buscado e a classe da diferença (`line-endings`, `whitespace`, `unicode`, `unknown`), nunca o texto em si; sem política de ferramentas, a classe é `unknown`.

- Execuções de escrita do agy, inclusive o reparo de testes Windows, passam a ser recusadas antes de o CLI começar, com `UNSUPPORTED_TEXT_ENCODING` e a lista dos arquivos, quando a cópia tem um arquivo que não é UTF-8 e que o Git colocaria no patch como texto, conforme o atributo `diff` e os bytes NUL do arquivo. Antes, a execução inteira rodava e só a prévia falhava, com `UNSUPPORTED_PATCH_ENCODING`, assim que um desses arquivos fosse editado. A mensagem sugere marcar o arquivo como `binary` no `.gitattributes`, deixá-lo fora com `includePaths` ou convertê-lo para UTF-8; execuções somente leitura não são afetadas. Um arquivo novo em UTF-16 com BOM, como a saída redirecionada no Windows PowerShell 5.1, continua entrando no patch como binário, agora com um aviso em `encodingWarnings` na prévia e no resultado da integração. O repositório privado da cópia passa a ignorar também `working-tree-encoding` e `ident` do projeto; antes, um original UTF-16LE marcado com `working-tree-encoding=UTF-16` voltava do Git em UTF-16BE e um `$Id$` era expandido numa linha não editada. A integração passa a conferir os finais de linha também de originais que não são UTF-8 (UTF-16 com BOM e texto sem bytes NUL, como Windows-1252) e recusa a mudança com `LINE_ENDINGS_CHANGED`, sem escrever no original.

- A integração deixa de alterar finais de linha e BOM do projeto original. O baseline privado, o patch e a aplicação passam a tratar os arquivos como bytes (`* -text` nos atributos do repositório privado, que prevalece sobre `.gitattributes`); antes, com `* text=auto`, um arquivo LF do original virava CRLF no Windows e um arquivo misto era reescrito no formato majoritário. O patch agora é aplicado primeiro a cópias dos arquivos afetados num diretório privado e cada resultado é conferido contra o original: arquivos LF e CRLF continuam no mesmo formato, arquivos mistos mantêm o final de cada linha não editada e o BOM UTF-8 é preservado. Um BOM removido pelo patch é devolvido automaticamente enquanto o resto do arquivo for UTF-8 e listado em `restoredByteOrderMarks` no resultado de `antigravity_integrate` e no evento `copy.integrated`; qualquer outra mudança recusa a integração com `LINE_ENDINGS_CHANGED`, sem escrever nada no original. Só então cada arquivo é gravado de forma atômica, mantendo as permissões do original (só uma mudança de modo presente no patch altera o bit executável); um arquivo excluído é antes movido para um nome temporário na mesma pasta. Se uma gravação falhar no meio, os arquivos já gravados voltam aos bytes anteriores, os excluídos voltam ao lugar e a operação falha com `INTEGRATION_FAILED`. Com tudo gravado, os excluídos são apagados; um que não possa ser apagado é listado em `leftoverFiles`. Adições em diretórios que ainda não existem passam a ser gravadas no caminho completo. Uma queda do processo do servidor durante as gravações ainda não é recuperada. Na cópia, arquivos que já eram mistos deixam de ser normalizados para o formato majoritário depois da execução, e um BOM que o executor removeu volta, com o evento `patch.bom-restored`.

- Execuções de escrita do agy, inclusive o reparo de testes Windows, passam a receber os arquivos de texto CRLF puro em LF: a ferramenta de edição do CLI exige correspondência exata e falhava em CRLF com "target content not found", repetindo chamadas até o timeout. Arquivos LF, mistos, com CR isolado, binários ou acima de 16 MiB ficam intactos, assim como a cópia nas execuções de teste nativo pelo próprio agy, porque os testes precisam ver os bytes originais e as correções entre tentativas acontecem na mesma sessão. A lista de convertidos fica registrada junto da cópia antes da primeira conversão. Assim que os processos da execução terminam comprovadamente, e antes da prévia, dos testes, das cópias de revisão e da integração, todos os arquivos convertidos voltam a CRLF, não só os editados; os não editados ficam idênticos byte a byte ao original, inclusive com `* text=auto` ou `eol=crlf`, e o conteúdo convertido que o CLI apenas renomeou ou copiou para um caminho novo também volta aos bytes originais. A referência de fim de linha dos arquivos editados passa a ser o próprio arquivo antes da execução, e não o blob normalizado do índice, que com `* text=auto` estava em LF. Enquanto houver arquivos convertidos sem restauração, a cópia recusa ser lida com `LINE_ENDINGS_UNRESTORED`. Os eventos `copy.line-endings-converted` e `copy.line-endings-restored` registram as contagens.

## 0.9.0

- Estado salvo por versões anteriores passa a ser sanitizado uma única vez por versão do arquivo e guardado numa cópia sanitizada em `sanitized/`, dentro do diretório de estado; cargas e consultas seguintes reaproveitam essa cópia, e o arquivo original não é reescrito. Antes, cada inicialização e cada consulta de status refaziam a sanitização de todos os snapshots antigos, o que podia atrasar a inicialização do servidor por minutos. Uma cópia inválida é descartada e refeita, e uma alteração no arquivo original invalida a cópia anterior.

- Cancelar um teste Windows logo depois de enfileirá-lo passa a impedir sua execução. Antes, uma tarefa já despachada mas ainda marcada como enfileirada era dada como cancelada enquanto a execução seguia, iniciava o processo e terminava depois; agora o cancelamento usa o sinal de término e a execução para antes de iniciar.

- Regras anexadas a todo prompt contra buscas fora da cópia, repetição de ferramentas negadas, duplicação, linhas reescritas, fins de linha, assinaturas, timers, valores alterados além do pedido e arquivos temporários; antes da prévia, os arquivos editados voltam ao formato de fim de linha do original guardado na baseline da cópia, inclusive quando a edição converteu o arquivo inteiro, e arquivos novos ou já mistos seguem o formato majoritário, com o evento `patch.line-endings-normalized`.

- Tarefas novas recebem automaticamente `anti-ai-code` e `anti-ai-security` como skills permanentes e um catálogo de até 8 KiB das demais skills do Anti-AI Craft, lidas sob demanda e somente leitura a partir de uma cópia privada e verificada por revisão, adicionada ao CLI com `--add-dir`. Retomadas e handoffs conservam o snapshot original; conflitos de nome falham com `SKILL_CONFLICT`; snapshot ausente ou adulterado falha com `CRAFT_SNAPSHOT_MISSING` ou `CRAFT_SNAPSHOT_INVALID`. `BRIDGE_ANTI_AI_CRAFT=off` desativa a política e `BRIDGE_ANTI_AI_CRAFT_DIRECTORY` define outro snapshot verificado. Sob política de ferramentas, os hooks permitem apenas leitura nessa raiz.

- A inspeção nativa de pontos de reparse do cache do runtime portátil no Windows passa a dar à compilação do inspetor um limite próprio de 60 s; a execução do inspetor mantém o limite de 15 s. Em máquinas lentas, o preparo do runtime deixa de falhar só porque o compilador .NET demorou a iniciar; um prazo esgotado continua recusando o cache com `UNSAFE_PORTABLE_NODE_CACHE`.

- O pacote passa a distribuir o snapshot do Anti-AI Craft 0.6.0 (revisão fixa `8f6d539`, seis skills, referências e biblioteca visual) em `plugin/anti-ai-craft/`, com manifesto de hashes verificado no build, nos testes e no tarball. O script `scripts/update-anti-ai-craft.mjs` obtém uma revisão completa informada pelo mantenedor, lê os blobs sem checkout nem execução de scripts, recusa links, submódulos e caminhos inseguros e aplica limites de 2.000 arquivos, 16 MiB por recurso e 64 MiB no total. Ferramentas de pesquisa do catálogo visual ficam fora do pacote.

- Após cada execução do CLI, os processos pertencentes à execução são observados novamente, encerrados e confirmados como ausentes, inclusive descendentes que sobrevivem ao processo pai. O resultado fica em `processCleanup`; se não for confirmado, a cópia não é reutilizada (`PROCESS_CLEANUP_UNVERIFIED`) até nova observação. No Windows, descendentes cujo intermediário já terminou continuam fora do alcance da verificação.

- Frames do CLI passam por cópia iterativa limitada em profundidade e nós, com redação de strings e chaves, antes de eventos, resultados, mensagens e respostas. Frames profundos deixam de interromper o processamento com estouro de pilha. Deltas de resposta são liberados somente por linha completa e redigidos com estado por etapa, evitando credenciais divididas entre deltas; uma linha incompleta acima de 8 KiB é suprimida até a próxima quebra, com marcador e evento `response.truncated`. Saídas e erros de testes nativos, evidências relatadas e estado restaurado de versões anteriores também são redigidos.
- Prompts, mensagens e memória privada com formatos de credencial de alta confiança são recusados com `INPUT_SECRET_DETECTED`. Memórias antigas com esses valores são lidas redigidas e não podem ser selecionadas.

- Respostas de erro MCP passam pela redação de diagnósticos antes de chegar ao cliente, inclusive erros gerados pelo SDK antes do wrapper do bridge, como ferramenta desconhecida e validação de argumentos. Respostas válidas, IDs e hashes não são alterados. A redação de credenciais em URLs agora inicia no delimitador `://`, mantendo tempo linear em diagnósticos longos.

- Descarta linhas acima do limite até a próxima quebra ou EOF, sem reinterpretar caudas como eventos. Stdout recupera os próximos frames válidos; após excesso em stderr, suprime explicitamente o restante desse stream para evitar perda de contexto da redação, sem inspecionar ou guardar o prefixo rejeitado.

- Compatibiliza `read_file`, `write_file` e `edit_file` com as capacidades de arquivo já selecionadas, preservando controles de caminho, modo somente leitura e nomes nos recibos. Rejeita argumentos modernos inválidos ou alvos ambíguos.

- Limpeza Windows reconhece temporários próprios já ausentes e verifica a identidade dos diretórios existentes antes da remoção, preservando substituições detectadas.
- Nova tentativa explícita de teste após falha da infraestrutura local reconcilia leases e aguarda a recuperação inicial, sem alterar o registro anterior nem liberar sessões do CLI expiradas ou canceladas.

- Recuperação Windows separa a admissão de concessões da revogação: reconcilia hardlinks e reparse points finais criados após a concessão sem seguir seus destinos, preserva outras identidades e mantém a limpeza limitada. O SID do perfil é persistido antes das etapas falíveis de preparação; leases sem SID permanecem válidas em `creating` quando a limpeza falha.
- Resultados nativos Windows validam nonce, encerramento, aliases, raízes e limpeza antes de aceitar a execução. Falhas de preparação ou limpeza retornam `BridgeError` com diagnóstico redigido e limitado; erros secundários são acrescentados ao diagnóstico original.

- Descoberta do CLI oficial (`discover`) com validação estrita de exit code 0 para `--version` e `--help`, saída não vazia e verificação de capacidades `stream-json` e `--sandbox`.
- Diagnósticos estruturados e códigos de encerramento de subprocesso: `AGY_NOT_FOUND`, `AGY_PERMISSION_DENIED`, `AGY_PROBE_FAILED`, `AGY_INCOMPATIBLE`, `CLI_INPUT_FAILED` (stdin fechado, EPIPE ou EOF prematuro), `AGY_IO_FAILED`, `AGY_PROCESS_FAILED`, `TASK_CANCELLED` e `TASK_TIMEOUT`.
- Prevalência da primeira intenção registrada em cancelamentos e timeouts, acionando o encerramento do processo e descendentes (sem garantir encerramento de processos que escapem do grupo de processos ou de permissões do sistema operacional); redaction preventiva de `stderr` e mensagens de erro conhecidas, sem adicionar credenciais aos logs e sem prometer ausência absoluta de segredos externos desconhecidos.
- Preflight preventivo de segredos executado após exclusões do Git e `includePaths` e antes da cópia, bloqueando `.env`, `.env.local` e outras variantes `.env.*` (exceto `.env.example`, `.env.sample`, `.env.template` e `.env.dist`, que passam por inspeção de conteúdo), `.envrc`, chaves privadas, keystores, credenciais conhecidas e padrões de alta confiança no conteúdo; certificados, chaves públicas e fixtures de teste sintéticas permanecem permitidos.
- Prévias e leitura de patches inspecionam arquivos antes do staging e usam uma cópia dos bytes verificados. A leitura de patches por arquivo (`readProjectPatch`) extrai a fatia diretamente do diff prévio revisado e verificado (`preview.patch`), vinculando-se estritamente ao mesmo hash SHA-256 sem executar novas leituras inseguras do índice compartilhado ou da árvore de trabalho; restaura o índice privado com `read-tree HEAD` após a preparação da prévia (com cerca defensiva de quarentena em caso de falha de restauração). Arquivos gerados ou modificados bloqueados falham com `BLOCKED_FILE_DETECTED`, sem alterar a origem.
- Snapshots, fingerprints e bifurcações respeitam os ignores da origem e da cópia, omitem arquivos gerados bloqueados e rejeitam baselines contaminados com `CONTEXT_CHANGED`.
- Coleta e leitura de artefatos reaplicam a política de segredos e verificam identidade, tamanho e SHA-256, preservando a paginação limitada. Violações de segredo falham com `BLOCKED_ARTIFACT_PATH`.
- Configuração de exclusões (`BRIDGE_SECRET_EXCLUSIONS`) em array JSON e exceções de segredos (`BRIDGE_SECRET_EXCEPTIONS` e runtime `ProjectLimits.secretExceptions`) em objeto versionado estrito (`{"version": 2, "namePatterns": ["fixtures/.env.local"]}`) com suporte a globs (`*`, `?`, `**`), correspondência de basename sem barra e case-insensitive; arrays legados não vazios falham com diagnóstico orientando a migração sem expor valores de segredos, enquanto omissões ou arrays vazios normalizam para política vazia; na versão 2, a exceção pula apenas a checagem de nome de arquivo de credencial (`SECRET_FILE`), mantendo integralmente a varredura e bloqueio por conteúdo (`SECRET_CONTENT`), sob precedência estrita onde Git ignores e caminhos inseguros sempre vencem e deny explícito vence exceções.
- Limitações declaradas do preflight, sem garantia de detecção de segredos arbitrários em código-fonte, formatos desconhecidos ou dados criptografados.
- Relato de `blockedFiles` no evento `copy.ready`, contendo apenas caminho e motivo (`SECRET_FILE`, `SECRET_CONTENT`, `SECRET_EXCLUSION`, `UNSAFE_PATH`) sem expor conteúdo do arquivo.
- Verificação rigorosa de limites de arquivos e bytes durante scan e cópia, falha com `SOURCE_CHANGED` ou `CONTEXT_CHANGED` em caso de mutação de identidade, tamanho ou hash, e prevenção de omissão silenciosa de baseline que se torne credencial.
- Ambiente de execução do CLI isolado via `cliEnvironment`, com variáveis padrão permitidas agrupadas, opt-in explícito via `BRIDGE_ALLOWED_ENV_VARS` (ex.: `["MY_TOOL_SETTING"]`, injeção não sendo default) com bloqueio estrito de variáveis de injeção de runtime (`NODE_OPTIONS`, `NODE_PATH`) e namespaces dinâmicos (`LD_*`, `DYLD_*`) no `loadConfig` e em chamadas diretas a `cliEnvironment` (independentemente de plataforma, casing misto ou espaços em branco), com diagnósticos que nomeiam a variável sem expor seu valor; preservação de `NODE_EXTRA_CA_CERTS`, opt-ins legítimos e contexto oficial de autenticação e certificados; omissão por padrão de credenciais de terceiros (AWS, GitHub, OpenAI, Stripe) e agentes locais (`SSH_AUTH_SOCK`, `GPG_AGENT_INFO`).
- Modo de aprovação configurável via `BRIDGE_APPROVAL_MODE`: padrão `auto` quando não configurado (unset), com validação estrita aceitando apenas `auto` ou `ask` (qualquer outro valor resulta em erro na inicialização).
- No modo `auto` (padrão), dispensa formulários interativos MCP de confirmação humana para aplicação de patches verificados (`antigravity_integrate`) e atualizações validadas da política de sandbox (`antigravity_set_sandbox_policy`), sem impor confirmações manuais extras ao chamador, permitindo propor concessões estreitas e verificadas necessárias aos testes; agentes delegados via `agy` (Gemini) não escolhem, autorizam nem proporcionam permissões; mantém estritamente hashes SHA-256, critérios de aceitação, revisão apoiada nos arquivos reais, testes observados atuais sem falhas, source-lock, CAS e proteção de caminhos.
- No modo `ask` (opt-in estrito), exige sempre confirmação humana via formulário MCP para cada integração e para atualização da política de sandbox, sem bypass para raízes previamente configuradas ou lembradas legadas; remoção do checkbox de memorização do formulário de integração.
- `antigravity_health` expõe `approvalMode` e `integrationApproval.mode` (`auto` ou `ask`), além de `integrationApproval.method` (`automatic` em `auto` e `mcp-form-elicitation` em `ask`).
- Documentação da persistência de configuração no ambiente privado de inicialização do servidor MCP (alertando que comandos em PowerShell afetam apenas a sessão atual do shell), exigindo reiniciar a conexão após alterações.
- Compatibilidade delimitada de contagem de links em ambientes de cache no OneDrive: tolerância a nlink extra ou transitório exclusivamente na leitura de assets com descritor confiável, tamanho e SHA-256 fixados, no staging da fonte do Node portátil com `expectedSha256`, e no lock de preparação do Node portátil (preservando device, inode, tamanho e nonce/payload exato conferido, com unlink apenas da entrada do próprio processo para preservar aliases); validação rigorosa onde hash, tamanho, identidade, marcas de reparse e layout de diretório permanecem obrigatórios, conteúdo alterado é recusado e aliases não são modificados. Destinos de runtime, executáveis genéricos e concessões de ACL continuam exigindo link único. O `StateStore` não possui suporte genérico a armazenamento em nuvem.
- Integração mantida exclusivamente via MCP sem fallback automático ao host e sem alteração nas permissões do Codex ou do `agy`.
- Autenticação oficial do `agy` preservada via gerenciadores nativos de credenciais do sistema operacional (Windows Credential Manager, macOS Keychain, Linux Secret Service), variáveis e endpoints Gemini, e variáveis ADC/Enterprise por compatibilidade (fluxo Enterprise não validado ponta a ponta).
- Staging do Git para testes Windows LPAC: preparação automática de Git for Windows descoberto no `PATH` para testes Node/npm e comando git direto, com resolução de launchers de cmd e bin para o binário nativo em ucrt64/bin ou mingw64/bin, preservação de executáveis nativos e instalações standalone e recusa de layouts conhecidos inválidos ou inseguros; cópia exclusiva de binários PE, DLLs e helpers públicos para runtime somente leitura de links únicos sem concessões ACL na instalação original; isolamento de ambiente preservando no `PATH` apenas o runtime e `System32` exato, `GIT_EXEC_PATH` no diretório no alias do runtime, configuração global ausente em scratch, `GIT_CONFIG_NOSYSTEM=1` e `GIT_TERMINAL_PROMPT=0`, remoção de entradas injetadas de `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*`, `GIT_CONFIG_VALUE_*` e `GIT_CONFIG_PARAMETERS` e configuração protegida de comando de `safe.directory` restrita unicamente à lista exata dos depósitos verificados presentes na cópia no início da execução: reset vazio (`VALUE_0=''`), raiz do alias da cópia verificada (`VALUE_1`) e raízes dos depósitos descendentes com diretório `.git` verificado dentro da cópia (`VALUE_2..N`), sem wildcard `*` e sem confiar fora da cópia, mantendo checagens normais do Git para novos depósitos criados após a admissão, sem herança de `.gitconfig`, credenciais ou chaves e sem download; novos repositórios temporários criados no sandbox usam `GIT_DEFAULT_REF_FORMAT=reftable` isolado (exigindo suporte a reftable no Git instalado, sem converter repositórios existentes nem alterar o host, e registrando a limitação do backend files no LPAC sem concessões extras ou UAC); ausência opcional de Git mantendo comandos Node/npm sem Git funcionais, respeitando limites de cópia e sem autorizações extras, fallback ao host ou ampliação de rede.
- Corrige o acesso do Git ao dispositivo Null em Windows LPAC com concessão temporária restrita ao SID da execução quando necessária e permitida pelo token atual. Preserva a consulta sem escrita onde o acesso padrão existe e falha com diagnóstico onde a concessão é negada. Leases v3 protegem a concessão pendente e a recuperação de aliases; Jobs privados permitem verificar o término dos processos antes da limpeza.
- Protege operações locais do Git contra executáveis no projeto, fsmonitor, hooks e filtros globais. Unifica o helper de isolamento e artefatos, restringe ambiente e `PATH`, preserva ignores e limita tempo, saída e diagnósticos. Git 2.32 passa a ser requisito, com validação antes das operações de projeto. Adiciona prazo delimitado de tolerância pós-terminação contra pipes retidos com falha explícita em `GIT_CLEANUP_UNVERIFIED`, cerca o reuso de cópias com limpeza incerta por marcador no baseline privado, unifica detecção de comandos com opções que aceitam valor (`-c`, `--config-env`, `-C`, `--git-dir`, `--work-tree`, `--namespace`), restringe escopo a opções globais e assegura exclusão de ambas as raízes em operações gerenciadas.
- Corrige bifurcações no Windows LPAC que falhavam ao iniciar um transporte Git por shell. O baseline é reconstruído por comandos nativos e aceito somente quando sua árvore corresponde à origem, preservando HEAD e índice do antecessor.
- Recusa patches textuais cujos bytes não preservem o round-trip UTF-8, com `UNSUPPORTED_PATCH_ENCODING`, evitando corrupção silenciosa. Patches binários do Git continuam preservando os bytes originais; `.gitattributes binary` é documentado para conteúdo não-UTF-8.
- Aplica patches com a configuração do baseline privado e whitespace fixo, evitando execução de filtros locais da origem e mudanças nos bytes aprovados.
- Recusa bifurcações quando regras de ignore passam a restringir arquivos do baseline, evitando expor seu conteúdo antigo em patches de exclusão.
- Amplia regressões de fsmonitor, overrides de configuração, ambiente, bifurcação, integridade de patches, caminhos literais de escopo e recusa de cópia por limpeza incerta.

## 0.8.0

- Workflows com intermediários JSON privados, síntese final, herança explícita de arquivos, checkpoints verificáveis e retomada sem repetir trabalho concluído.
- Hooks por etapa para critérios reais, revisão fundamentada e testes observados, com bloqueio de evidências pendentes ou inválidas.
- Orçamento por grupo com contadores observados, diferenças de sessão e bloqueio de novas chamadas quando faltam dados ou o teto é atingido.

- Recuperação serializada de locks do estado, com identidade de arquivo, token de posse e liberação idempotente.
- Mensagens direcionadas entre nós, recibos compactos e continuação idempotente pelo CLI; dependências aguardam turnos adicionais e cancelamento inclui continuações.
- Formato de resumo JSON para disponibilizar a conclusão guardada em tarefas com política nativa sem schema explícito.

- Grupos com responsáveis e dependências, admissão persistida, retomada explícita e espera conjunta com cursores e mensagens limitadas.

- Memória privada por projeto e especialista, com seleção explícita, snapshots por tarefa, comparação de hashes e leitores paginados.

- Resultados JSON validados, artefatos com SHA-256 e leitura paginada.
- Padrões persistentes por especialista para modelo, esforço, skills, arquivos, resultado e ferramentas.
- Catálogo MCP confiável e ferramentas selecionadas por tarefa, com hooks nativos, recibos vinculados à conversa e controles preservados em retomadas e handoffs.
- Diagnóstico explícito da falta de permissão MCP no modo headless e proteção da configuração auxiliar nos testes Windows LPAC.

## 0.7.1

- Remove o painel MCP Apps e seus recursos de aparência, mantendo entrega compacta, mensagens por sessão, skills selecionadas, concorrência e autorização prévia de integração.
- Normaliza raízes autorizadas com o resolvedor nativo do Windows, incluindo aliases 8.3.

## 0.7.0

- Painel MCP Apps com lista e conversa no estilo do Codex, recursos nativos descobertos localmente, controles de saída técnica e cards de alterações reais.
- Leitura de diffs e Desfazer por arquivo somente na cópia, vinculados ao hash atual e aos limites de perfil e execução.

- Autorização prévia configurável por raiz exata de projeto para dispensar formulários repetidos, preservando critérios, hash, revisão e testes atuais.

- Caixa de mensagens do chamador com recibos idempotentes, despacho sequencial por sessão, recuperação sem repetição de envios incertos e ponteiros de continuação.

- Entrega opcional de mensagens públicas compactas ao chamador, com cursores próprios, atribuição, referências a resultados, perda de histórico explícita e conservação do modo de eventos.

- Pacotes de skills selecionadas fornecidos pelo cliente, preparados na cópia com recursos UTF-8, limites combinados, hashes imutáveis e preservação nas retomadas e transferências.
- Tentativas limitadas para bloqueios transitórios do Windows em gravações atômicas de estado, sem remover o último estado válido como alternativa.

## 0.6.1

- Preservação exata da DACL existente ao conceder e remover permissões temporárias do executor Windows LPAC.
- Recusa de links simbólicos e junctions no componente final do caminho de executáveis Windows.
- Diagnósticos sanitizados de inspeção do cache portátil, com detalhes limitados da execução e sem saída bruta.
- Inspeção do cache portátil sem carregamento automático de módulos do PowerShell, com prazo máximo de 15 segundos.
- Fixture de testes ajustada para instalações do npm sem `npmrc` distribuído.
- Versão do pacote, plugin e servidor MCP atualizada para permitir a instalação em um novo diretório de cache do Codex.

## 0.6.0

- Executor de testes próprio do bridge no Windows, isolado em AppContainer/LPAC e selecionado por padrão; `BRIDGE_TEST_EXECUTOR=agy` mantém o caminho legado explícito e não há alternativa de execução no host.
- Política global de permissões de sandbox com consulta, alteração confirmada por formulário MCP e comparação pelo hash anterior. O agente que chama o MCP seleciona, em cada teste, apenas permissões dentro dos limites autorizados pela pessoa usuária. A configuração não é encaminhada ao `agy`; o Gemini delegado não pode escolhê-la, autorizá-la nem alterá-la.
- Evidências de teste agora distinguem o executor Windows, a seleção de sandbox e o hash da política. Execução local conhecida registra zero tokens de modelo; reparos opcionais pelo `agy` continuam com os contadores observados, inclusive `null` quando ausentes.
- Staging limitado de executáveis Windows e de `npm`/`npm.cmd`, que executa o `node.exe` e `npm-cli.js` verificados. Lotes arbitrários continuam sem suporte.
- Aliases DOS temporários em dois níveis para cópia, runtime e scratch, com três letras livres de `D:` a `Z:`, verificação de identidade e remoção, e recuperação de execução interrompida. Eles são locais ao contexto de logon, sem ACL na raiz do volume, UAC ou mount persistente.
- Limitação conhecida: no Node 24.14.1/libuv 1.51, `child_process.spawnSync` com pipes padrão falha no LPAC e expira com exit code 124; stdio herdado e o ciclo real do npm não demonstram compatibilidade geral. O [PR 5181 do libuv](https://github.com/libuv/libuv/pull/5181/files), presente no [libuv 1.53](https://github.com/libuv/libuv/releases/tag/v1.53.0), foi aplicado ao runtime portátil Node 24.21.0 LPAC1; o Node 24.14.1 do sistema mantém a limitação.
- Runtime Node 24.21.0 LPAC1 para Windows x64 publicado em Release imutável, com libuv base 1.52.1 e somente o PR 5181 aplicado. O descritor fixa URL, tamanho e SHA-256 dos três arquivos instalados: `node.exe`, `LICENSE` e `build.json`. Esse build passou pela regressão LPAC com pipes padrão capturados (1 teste) e pelos testes de isolamento e ciclo de vida (22 testes, sem falhas nem skips). A preparação é explícita.

## 0.5.2

- Restauração de `PATHEXT` ausente no subprocesso Windows para clientes MCP com ambiente reduzido, preservando valores explícitos e as permissões do sandbox.
- Diagnósticos separados para falha de acesso do sandbox, setup administrativo não concluído e bypass negado, com a causa relatada pelo runtime e vínculo ao comando do teste.
- Recusa de recibos que declaram bypass do sandbox, mesmo com exit code zero.
- Regressão com PowerShell real e integração nativa usando o ambiente padrão do SDK, incluindo resolução do executável e acesso externo negado.

## 0.5.1

- Margem de observação das tarefas nos testes ampliada de 5 para 30 segundos para a preparação de cópias em runners Windows, preservando as asserções de concorrência, retenção, aprovação e timeouts de execução.

## 0.5.0

- Perfis de ferramentas por ambiente, com consulta e revisão limitadas a tarefas em leitura.
- Espera limitada com notificações MCP por evento real, cursores e cancelamento separado da execução.
- Transferência estruturada entre papéis com cópias independentes, histórico de relatórios, decisões e critérios, vinculados ao hash dos arquivos.
- Comparação de 2 a 4 modelos em leitura sobre cópias do mesmo contexto, com divergências, falhas, uso e verificação de conteúdo atual.
- Diagnóstico explícito das limitações de respostas de permissão e contagem prévia exata no protocolo headless verificado.
- Papéis personalizados por configuração, com contratos herdados, descoberta MCP e instruções preservadas nas retomadas.

## 0.4.1

- Snapshot Git temporário dentro da cópia do projeto para compatibilidade com o AppContainer Windows, com exclusão do fingerprint e limpeza validada.
- Regressão para diretório temporário ambiente indisponível e validação real de execução, origem intacta e acesso externo negado.
- Orientação da configuração inicial UAC do sandbox Windows e contadores de tokens também nos diagnósticos de falha do teste real.

## 0.4.0

- Critérios de aceitação definidos antes da tarefa, conferência de artefatos e revisão com citações verificadas por arquivo e linha.
- Integração condicionada a verificação atual, com detecção de evidências alteradas e resultados pendentes.
- Execução assíncrona de testes no sandbox nativo do agy, com recibos do terminal, exit code, fingerprints e correções opcionais limitadas.
- Leitura paginada de patches por arquivo e do JSON final, com hashes, cursores Unicode e opções de resposta compacta.
- Normalização nativa dos aliases 8.3 nos testes Windows e declaração explícita da cópia no workspace do CLI.
- Papéis de planejamento e revisão em consulta, contratos JSON e conferência de citações dos achados.
- Consumo de tokens por tarefa, sessão e modelo, com deltas de retomada, baseline persistido e identificação de dados indisponíveis.
- Schemas de saída publicados nas 23 ferramentas, com contratos de sucesso/erro e validação pelo SDK.
- Modelo padrão por ambiente, preferência persistente e Auto explícito por tarefa ou para tarefas futuras.
- Pacote npm com executável para npx, servidor incluído sem dependências de runtime e teste do tarball em Windows/Linux.
- Contrato de health preserva diagnósticos textuais de disponibilidade junto do formato estruturado de erros.

## 0.3.0

- Descarte pelo MCP e limpeza automática de cópias finalizadas, com retenção padrão de 7 dias.
- Modo de consulta com `agy --mode plan`, verificação de alterações e bloqueio de integração.
- Recuperação local de tarefas, sessões, eventos e cópias após reinício, sem repetição automática de execuções interrompidas.
- Limites padrão de 10.000 arquivos/256 MiB copiados e 100 arquivos alterados.
- Estatísticas de linhas e arquivos na prévia, identificação de binários e testes relatados vinculados ao hash.
- Licença MIT, políticas de segurança e privacidade e avisos das dependências distribuídas.
- Integração condicionada a confirmação via formulário MCP, vinculada ao hash revisado e conferida novamente antes da aplicação.

## 0.2.1

- Normalização da raiz Git antes da comparação de caminhos no Windows.

## 0.2.0

- Cópias temporárias filtradas pelas regras de ignore do Git e seleção por `includePaths`.
- Sandbox obrigatório, prévia do patch e integração com validação do hash e da origem.

## 0.1.0

- Servidor MCP stdio e plugin com skill para executar tarefas pelo CLI oficial.
- Descoberta de modelos, eventos, resultados, retomada e cancelamento de tarefas.
