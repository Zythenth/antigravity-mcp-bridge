# Antigravity MCP Bridge

Servidor MCP local para delegar tarefas de programação ao Google Antigravity por meio do CLI oficial `agy`. O Codex pode iniciar tarefas, acompanhar eventos, consultar resultados e cancelar processos. O projeto é independente e não é afiliado ao Google ou à OpenAI.

```text
Codex -- MCP stdio --> bridge -- subprocesso --> agy oficial --> Antigravity
Codex <-- eventos e resultado estruturados <-- bridge <-- stdout/stderr
```

O bridge não acessa endpoints privados, cookies ou arquivos de autenticação. A comunicação com o serviço é feita pelo próprio `agy`.

## Requisitos

- Node.js 24 ou mais recente e npm. Esse requisito inicia o servidor; no Windows LPAC, ele não garante a compatibilidade de todos os subprocessos Node.
- Git instalado e disponível no `PATH`.
- [Antigravity CLI oficial](https://www.antigravity.google/docs/cli/overview/) instalado e disponível no `PATH`. Você também pode definir `AGY_PATH` com o caminho absoluto do executável.
- Autenticação concluída no `agy` interativo. Consulte a [documentação oficial do modo headless](https://www.antigravity.google/docs/cli/headless/).

O bridge foi testado com `agy` 1.2.16 e `@modelcontextprotocol/sdk` 1.30.1. As tarefas delegadas exigem que o CLI anuncie `--sandbox` e `stream-json`; versões futuras podem exigir adaptação. No Windows, `antigravity_test` usa por padrão o executor local do bridge em AppContainer/LPAC; nos demais sistemas, usa o sandbox oficial do `agy`.

## Versões disponíveis

Este código corresponde à **0.6.0**. Consulte a [página do pacote no npm](https://www.npmjs.com/package/antigravity-mcp-bridge) para conferir a versão distribuída. Os exemplos npx abaixo selecionam a 0.6.0.

A 0.6.0 inclui executor Windows do bridge, permissões de sandbox controladas por ferramentas MCP e um runtime Node portátil opcional para LPAC. O runtime está publicado em um Release imutável; prepare-o explicitamente antes de usar o modo portátil.

A 0.5.1 inclui perfis, espera com progresso, transferência entre papéis, comparação de modelos e papéis personalizados. Ela amplia a margem de observação dos testes para suportar a preparação de cópias em runners mais lentos, preservando as verificações dos timeouts de execução.

## Instalação

### Servidor MCP via npm/npx

Para iniciar o servidor pelo pacote npm 0.6.0, configure seu cliente MCP com:

```json
{
  "mcpServers": {
    "antigravity": {
      "command": "npx",
      "args": ["--yes", "antigravity-mcp-bridge@0.6.0"]
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

### Runtime Node portátil no Windows LPAC

O servidor iniciado diretamente por npm usa o Node do sistema por padrão. O descritor distribuído com o plugin pede o modo `portable`, para que os testes Windows LPAC usem o runtime preparado no cache. Os modos são escolhidos somente na inicialização confiável do servidor com `BRIDGE_WINDOWS_NODE_RUNTIME=system` ou `portable`; entradas de ferramentas MCP não aceitam URL, hash nem caminho de cache.

Consulte o estado sem iniciar MCP, descobrir `agy` ou baixar arquivos:

```powershell
node plugin/server.mjs --windows-runtime-status
```

No Windows x64, prepare explicitamente o runtime antes de usar o modo portátil:

```powershell
node plugin/server.mjs --prepare-windows-runtime
```

Para preparar o runtime pelo pacote npm 0.6.0:

```powershell
npx --yes antigravity-mcp-bridge@0.6.0 --prepare-windows-runtime
```

O status retorna JSON com `requestedMode`, `supported`, `ready`, `buildId`, `nodeVersion`, `libuvVersion`, `sha256` e, quando necessário, `error`. Uma consulta sem suporte, sem cache ou com cache inválido continua sendo uma consulta bem-sucedida; uma falha de preparação retorna exit code 1. Preparação baixa somente os arquivos declarados do GitHub Release, confere tamanho e SHA-256 e instala o cache privado de forma atômica. Inicialização, saúde e testes não baixam arquivos. Cache ausente no modo portátil exige `--prepare-windows-runtime`, sem voltar silenciosamente ao Node do sistema. Cache corrompido, alterado ou inseguro é recusado também pela preparação, que não o repara nem remove automaticamente. Antes de preparar novamente, uma pessoa deve inspecionar o caminho e remover manualmente somente o cache do build afetado; depois, executar `--prepare-windows-runtime`.

Mantenha o cache fora dos projetos. O bridge resolve os caminhos reais e recusa sobreposição em ambas as direções entre o projeto e `BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY`, antes de consultar modelos, enfileirar a tarefa ou copiar arquivos. Essa regra também vale com `includePaths` e no modo `system`.

O runtime [Node 24.21.0 LPAC1 para Windows x64](https://github.com/Zythenth/antigravity-mcp-bridge/releases/tag/runtime-node-v24.21.0-lpac1-win-x64) está publicado em um Release imutável, com ABI 137, libuv base 1.52.1 e apenas o PR 5181 aplicado. Ele não declara suporte geral a outras versões, arquiteturas ou plataformas. O cache instala somente `node.exe`, a `LICENSE` upstream e `build.json`; este último registra a fonte fixada, o patch, a ferramenta de compilação e a proveniência da execução. A seleção substitui somente o `process.execPath` conhecido desse runtime e o `npm` adjacente validado; executáveis Node ou npm personalizados permanecem selecionados como foram informados. A substituição portátil inicial de `process.execPath` e do `npm` adjacente exige Node 24 no host do servidor. O requisito geral Node >=24 permite iniciar o servidor, mas hosts Node 25/26 falham em testes elegíveis com `PORTABLE_NODE_HOST_UNSUPPORTED`. O cache persiste entre reinicializações normais do processo e do servidor, mas a persistência através de uma reinicialização física ainda não foi verificada.

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

## Perfis de ferramentas

Defina `BRIDGE_TOOL_PROFILE` no ambiente do servidor e reinicie a conexão MCP:

| Valor | Ferramentas no código-fonte 0.6.0 | Catálogo e execução |
| --- | --- | --- |
| `full` (padrão) | 31 | Todas as ferramentas; preserva a configuração existente |
| `query` | 21 | Consulta, modelos, sessões, handoff, comparação e consulta da política de sandbox; tarefas somente em leitura |
| `review` | 24 | Consulta mais prévia, leitura de patches e verificação; tarefas somente em leitura |
| `implementation` | 31 | Fluxo completo, incluindo testes, integração confirmada e descarte |

O perfil é informado em `antigravity_health.toolProfile`. Ferramentas fora do perfil não são registradas e chamadas diretas são recusadas. `query` e `review` também recusam `mode: "write"`; omitir o modo seleciona leitura. Perfis reduzem o catálogo e restringem essas tarefas; o sandbox e a confirmação de integração continuam necessários. Valores desconhecidos impedem a inicialização.

## Espera com progresso

Prefira `antigravity_wait` com `taskId`, `after` e `timeoutSeconds` (1–60, padrão 30). Clientes que enviam `_meta.progressToken` recebem notificações `notifications/progress` com a sequência e o tipo de eventos reais, incluindo ferramentas, recibos de testes e conclusão. O número é um cursor de eventos, sem total ou porcentagem. Nenhum texto de arquivo, prompt ou saída do terminal é enviado nessas notificações.

A resposta inclui `ready`, `timedOut`, estado, uso de tokens e até 1.000 eventos. Continue com `nextCursor`; `truncated` informa eventos antigos perdidos. Timeout da espera e cancelamento da chamada MCP preservam a execução. Para parar a tarefa, use `antigravity_cancel`. Sem suporte a progresso, a resposta final continua disponível. A espera consulta também o estado persistido para observar tarefas de outro processo do bridge.

## Transferência entre papéis

Use `antigravity_context` após uma tarefa concluída para inspecionar critérios, relatórios e `treeSha256`. Em seguida, chame `antigravity_handoff` com `sourceTaskId`, esse hash, `role`, `prompt` e, opcionalmente, `model` e `decisions`.

A nova tarefa recebe uma cópia independente dos arquivos atuais, incluindo alterações ainda não integradas. Mantém o baseline do projeto original, critérios, até oito relatórios de planejamento/revisão e a origem dos testes. Decisões são marcadas como relatos do cliente; relatórios e recibos mantêm sua origem e não autorizam integração. O pacote de contexto inteiro deve caber no limite do prompt; não há corte silencioso.

Planejamento → implementação → revisão pode mudar de papel e modelo sem reusar a conversa do papel anterior. O contexto é dado a conferir, não uma instrução de prioridade superior. Hashes são conferidos ao aceitar a tarefa e ao copiar, também quando ela aguardou na fila. A revisão verifica que sua cópia permaneceu intacta, incluindo arquivos ignorados. A cópia da implementação permanece disponível para testes, verificação e integração confirmada. Uma implementação iniciada a partir da revisão preserva o patch acumulado contra o original.

A cópia continua respeitando os ignores do projeto e limites de arquivos/bytes. Se a seleção mudar por novas regras de ignore, o handoff falha; inspecione o contexto novamente. Não inclua segredos em decisões. `antigravity_resume` conserva papel e cópia; `antigravity_handoff` cria outro papel em outra cópia e sessão.

## Comparação entre modelos

Após `antigravity_context`, chame `antigravity_compare` com `sourceTaskId`, `expectedContextSha256`, `prompt` e `models` contendo 2 a 4 IDs distintos devolvidos por `agy models`. Cada modelo recebe uma cópia independente da mesma versão e executa uma revisão em leitura. A comparação consome a quota de cada tarefa; respeita `MAX_CONCURRENT_TASKS`, fila, retenção e limites de cópia. As cópias são preparadas antes de iniciar o grupo, evitando que revisores disputem a cópia de origem.

Guarde `comparisonId` e acompanhe cada `taskId` com `antigravity_wait`. `antigravity_comparison` reúne pareceres, erros, uso de tokens, modelos ausentes e os achados por arquivo/linha/citação. `identical` significa achados literalmente iguais; `different`, interpretações diferentes no mesmo trecho; `not-reported-by-all`, um trecho não relatado por todos. Ausência de achados não prova concordância nem correção.

`complete` exige todos os pareceres concluídos e suas cópias ainda correspondentes ao conteúdo comparado. `contextStale` sinaliza que a origem ou alguma cópia mudou, ficou indisponível ou não pôde ser conferida; confira `contextMatches` por parecer. Erros de início ficam em `startErrors`; falhas ou tarefas removidas não são ocultadas. O Codex deve conferir as fontes e sintetizar recomendações, divergências e limites de cada parecer. O agrupamento não faz votação semântica e não autoriza integração. As tarefas de comparação podem ser canceladas e descartadas individualmente.

## Limites de interação e contagem prévia

`antigravity_health.bridgeLimitations` informa duas capacidades indisponíveis:

- `interactiveReplies.available: false`: o [protocolo headless verificado](https://www.antigravity.google/docs/cli/headless/#unsupported-messages) recusa `control_request` e `control_response`. Mensagens de texto em novos turnos não respondem a solicitações pendentes de permissão. O bridge encerra o stdin após seu prompt; para continuar a conversa concluída, use `antigravity_resume`. Examine pedidos negados nos eventos e erros, sem contornar o sandbox. A confirmação MCP da integração continua sendo uma operação separada do bridge.
- `preflightTokenCount.available: false`, `exactTokens: null`: não há comando do agy verificado para contar tokens antes do envio. O uso informado pelo CLI é observado após execução. Tamanho em caracteres não é uma contagem exata de tokens nem um orçamento de quota. O bridge permanece no CLI oficial, sem API adicional, novas credenciais ou estimador apresentado como contagem exata.

Essas limitações não são resolvidas por manter o processo aberto ou inventar mensagens do protocolo. Um suporte futuro exige verificar a versão e o contrato oferecido pelo CLI antes de adicionar a operação.

## Papéis personalizados

Defina `BRIDGE_CUSTOM_ROLES` como um array JSON no ambiente do servidor e reinicie a conexão. Exemplo PowerShell:

```powershell
$env:BRIDGE_CUSTOM_ROLES = '[{"name":"security-review","baseRole":"reviewer","description":"Revisão de controles de acesso","instruction":"Examine os controles de acesso do escopo solicitado e cite evidências reais."}]'
```

`antigravity_roles` lista os nomes disponíveis, descrições, base e tamanho das instruções. Selecione o nome em `role` de `antigravity_run` ou `antigravity_handoff`; os schemas MCP anunciam os nomes configurados. Cada papel tem nome de até 32 caracteres em letras minúsculas, números e hífens, `baseRole` e instruções de até 8.000 caracteres. A descrição é opcional, até 500 caracteres. Há até 20 papéis; nomes duplicados, substituição dos três nomes nativos, bases desconhecidas ou instruções vazias impedem a inicialização.

As bases `planner` e `reviewer` conservam modo de leitura, contratos JSON e conferência de citações. `implementer` conserva o fluxo de escrita na cópia e as mesmas exigências de verificação e confirmação para integração. Instruções personalizadas não dão permissões extras e entram no limite total do prompt. A definição usada é salva com a tarefa; a retomada mantém instruções e base originais, mesmo após mudar a configuração. Para trocar de papel, crie uma nova tarefa ou faça handoff.

## Ferramentas

Todas as ferramentas publicam `outputSchema` com campos e tipos de suas respostas estruturadas. O contrato contempla sucesso e `error: { code, message }`. O SDK confere os campos obrigatórios antes de entregar respostas de sucesso; clientes também podem validar o JSON recebido. Dados brutos do CLI continuam com tipo aberto porque seu formato pertence ao provedor. O contrato não transforma uma alegação do modelo em prova de execução.

| Ferramenta | Função |
| --- | --- |
| `antigravity_health` | Verifica executável, versão, autenticação aparente e capacidades |
| `antigravity_list_models` | Lista os IDs devolvidos por `agy models` |
| `antigravity_get_model` / `antigravity_set_model` | Consulta ou persiste o modelo padrão; `null` seleciona Auto |
| `antigravity_context` / `antigravity_handoff` | Inspeciona e transfere plano, decisões, critérios e evidências para outro papel em cópia independente |
| `antigravity_compare` / `antigravity_comparison` | Solicita pareceres de 2 a 4 modelos e reúne achados, divergências, falhas e uso observado |
| `antigravity_roles` | Lista os papéis nativos e personalizados configurados |
| `antigravity_get_sandbox_policy` | Lê a política global normalizada, seus limites e o hash atual |
| `antigravity_set_sandbox_policy` | Solicita ao cliente MCP a confirmação humana para substituir a política global com comparação do hash anterior |
| `antigravity_run` | Inicia uma tarefa e retorna o `taskId` |
| `antigravity_list_project_files` | Lista os arquivos elegíveis para a cópia |
| `antigravity_preview` | Mostra A/M/D, totais de linhas, estatísticas por arquivo, patch, hash e testes relatados |
| `antigravity_record_test` | Registra comando, saída e exit code relatados pelo cliente, vinculados ao hash |
| `antigravity_test` | Executa o comando exato com a seleção de sandbox do chamador e captura evidência do executor escolhido |
| `antigravity_verify` | Confere critérios da tarefa e evidências de revisão contra arquivos reais |
| `antigravity_read_patch` | Lê o patch por arquivo ou em trechos vinculados ao hash completo |
| `antigravity_read_result` | Lê o JSON final do CLI em trechos com hash de conteúdo |
| `antigravity_usage` | Consolida tokens observados por tarefa, sessão e modelo |
| `antigravity_integrate` | Solicita confirmação via MCP e aplica o patch revisado ao original |
| `antigravity_tasks` | Recupera IDs e metadados de tarefas persistidas localmente |
| `antigravity_status` | Consulta estado, processo, sessão, uso e snapshots Git |
| `antigravity_wait` | Espera até 60 segundos com notificações MCP dos eventos observados; timeout não cancela a tarefa |
| `antigravity_events` | Lê eventos após um cursor `after` |
| `antigravity_result` | Consulta o resultado ou informa `ready: false` |
| `antigravity_discard` | Remove a cópia e o baseline de uma tarefa finalizada |
| `antigravity_cleanup` | Remove cópias finalizadas cujo prazo de retenção expirou |
| `antigravity_cancel` | Cancela tarefa na fila ou encerra o processo local |
| `antigravity_sessions` | Lista sessões conhecidas no estado local |
| `antigravity_resume` | Retoma uma conversa conhecida pelo `sessionId` |

`antigravity_run` recebe `prompt`, `workingDirectory` absoluto na raiz de um repositório Git e, opcionalmente, `model`, `timeoutSeconds`, `mode` e `includePaths` (arquivos ou pastas relativos à raiz). Sem `includePaths`, copia todos os arquivos rastreados e não rastreados que **não** correspondam a `.gitignore`, `.git/info/exclude` ou às outras regras de ignore do Git. O filtro também exclui arquivos rastreados que passaram a ser ignorados. `includePaths` apenas reduz essa seleção; não permite incluir arquivos ignorados. Links simbólicos e caminhos fora da raiz são recusados. Consulte `antigravity_list_models` antes de selecionar um modelo.

### Política de sandbox dos testes

`antigravity_get_sandbox_policy` devolve a política global normalizada e seu `sha256` para os testes Windows LPAC. Ela é o limite máximo para `readRoots`, `writeRoots`, `network`, `childProcesses` e `maxOutputChars`. A configuração inicial não concede raízes externas, desativa rede, permite processos filhos e limita a saída a 4.000 caracteres.

O agente que chama o MCP, seja o Codex ou outro cliente, escolhe em cada `antigravity_test` Windows `sandbox: { readPaths, writePaths, network, childProcesses, maxOutputChars }` dentro desse limite. O bridge recusa caminhos que ultrapassem as raízes aprovadas ou que coincidam com a origem, credenciais, armazenamento do bridge, temporários controlados, links, aliases ou outros caminhos protegidos. A seleção fica vinculada à evidência do teste e ao hash da política usado. No caminho legado `agy`, uma seleção explícita não é aceita; sem seleção, ele conserva o comportamento anterior.

Para ampliar ou reduzir o limite global, leia antes a política e chame `antigravity_set_sandbox_policy` com seu hash atual e a proposta. O cliente deve apresentar o formulário que mostra os limites anteriores e propostos; só uma confirmação humana permite a mudança. A comparação e gravação evitam substituir uma política que mudou enquanto o formulário estava aberto. A pessoa usuária autoriza os limites globais; o agente que chama o MCP escolhe apenas concessões menores por teste dentro deles; o Gemini delegado via `agy` não pode escolher, autorizar nem alterar concessões. Alterações confirmadas afetam testes novos e os que ainda estiverem na fila; elas não revogam promessas de permissões de trabalhos ativos.

Por exemplo, um pedido de leitura e escrita deve usar raízes específicas que uma pessoa já tenha conferido, como `"<raiz-de-leitura-aprovada>"` e `"<raiz-de-escrita-aprovada>"`; não use um disco inteiro nem presuma caminhos do computador de outra pessoa. Primeiro confirme os limites no formulário e só então selecione subconjuntos deles para o teste.

Para revisão, diagnóstico ou segunda opinião, passe `mode: "read-only"`. O bridge exige suporte a `agy --mode plan`, confere ao final que nenhum arquivo foi criado, modificado ou removido (inclusive arquivos novos ignorados pelo Git) e recusa integração dessas tarefas. Esse modo é uma restrição do CLI com verificação posterior, sem garantia de bloqueio físico de escrita. O padrão `mode: "write"` preserva o fluxo de implementação na cópia. Uma sessão retomada mantém seu modo original.

Fluxo típico:

1. Consulte `antigravity_health` para conferir CLI, perfil e confirmação disponível. Use `antigravity_list_models` e `antigravity_roles` para selecionar IDs e papéis anunciados pelo servidor.
2. Liste os arquivos elegíveis com `antigravity_list_project_files`, selecione `includePaths` quando necessário e defina `acceptanceCriteria` cobrindo os requisitos antes de iniciar a implementação com `antigravity_run`. Guarde o `taskId`.
3. Acompanhe com `antigravity_wait`, preservando `nextCursor` e repetindo a espera quando `ready` for falso. `timedOut` encerra apenas a espera. Use `antigravity_events` para consultar os eventos detalhados.
4. Após o término, confira o status e os erros em `antigravity_result` com `includeResult: false`. Leia o resultado com `antigravity_read_result` e o patch com `antigravity_preview` (`includePatch: false`) e `antigravity_read_patch`. Se houver falha, confira a causa antes de retomar; `completed` não comprova os requisitos.
5. No Windows com o executor LPAC, consulte a política de sandbox e execute os testes pertinentes com `antigravity_test`, usando o hash da prévia e somente uma seleção já aprovada. Nos demais sistemas, ou com `BRIDGE_TEST_EXECUTOR=agy`, execute o teste sem seletor `sandbox`, pois a seleção explícita é recusada no caminho legado. A ferramenta devolve outro `taskId`: acompanhe e revise esse ID, confira a origem da evidência, exit codes e evidências desatualizadas e obtenha a prévia atual novamente. `antigravity_record_test` registra testes executados pelo cliente, como relatos; não substitui a evidência observada do executor.
6. Confira os arquivos reais contra cada critério e envie evidências de revisão a `antigravity_verify` com o hash atual. Com verificação aprovada e atual, confira também se os testes observados continuam válidos e chame `antigravity_integrate` na tarefa de implementação mais recente dessa cópia para solicitar a confirmação humana. Alterações no patch, nas evidências ou nos arquivos afetados do original exigem nova conferência.
7. Informe o uso observado com `antigravity_usage` e, quando o trabalho puder ser removido, descarte a cópia com `antigravity_discard`.

Esse fluxo de implementação requer `full` ou `implementation`. Para planejamento, revisão ou comparação, use os papéis de leitura e os fluxos específicos acima. Uma revisão por handoff recebe outra cópia; ela não altera qual é a tarefa mais recente da cópia de implementação.

A integração exige suporte do cliente a **MCP form elicitation**. `antigravity_health` informa `integrationApproval.available`. O formulário mostra origem, tarefa, hash, arquivos e contagens de linhas; só `accept` com `confirm: true` permite aplicar. Recusa, cancelamento, timeout ou falta de suporte preservam o original. O hash identifica o patch e a confirmação vem de uma resposta separada do cliente; nenhum argumento `approved` é aceito como autorização. Após a resposta, o bridge confere novamente hash e origem. A confirmação depende de um cliente confiável que apresente a decisão ao usuário.

## Verificação dos resultados

### Consumo de tokens

`antigravity_status` e `antigravity_result` incluem `task.tokenUsage`. `antigravity_usage` consolida as tarefas retidas e aceita filtros por `taskId`, `sessionId` e `model`. A resposta contém `byTask`, `bySession`, `byModel` e os contadores `inputTokens`, `outputTokens`, `totalTokens`, `thinkingTokens` e `cacheReadTokens`.

O [resultado final do agy informa uso cumulativo da sessão](https://www.antigravity.google/docs/cli/headless/#read-the-results). O bridge salva os contadores anteriores ao retomar e usa a diferença para a tarefa seguinte, inclusive quando o modelo muda. Assim, duas respostas cumulativas de 120 e 170 tokens representam 170 tokens na sessão e 50 na segunda tarefa. `observedCumulative` preserva o último total de sessão informado pelo CLI, separado do consumo das tarefas retidas.

Contadores ausentes, inválidos, reiniciados ou sem baseline conhecido ficam `null`; `available`, `partial`, `source` e `warnings` indicam a qualidade dos dados. Não há estimativa de tokens nem substituição silenciosa por zero. O consumo de tarefas falhas também é incluído quando o CLI devolve os contadores finais. Antes desse resultado, o total da tarefa pode estar indisponível. Tarefas antigas removidas pela retenção deixam de compor o consolidado local. Modelo `null` significa que não foi informado um ID; não se presume um modelo padrão.

Esses números são relatos do CLI, sem cálculo de cobrança ou acesso à quota global da conta. Cache e raciocínio são dimensões separadas e não devem ser somados novamente a `totalTokens`. A skill orienta o Codex a informar o consumo disponível ao concluir ou relatar falhas.

### Papéis de trabalho

`antigravity_run` aceita os papéis nativos `"implementer"` (padrão), `"planner"` e `"reviewer"`, além dos nomes personalizados anunciados por `antigravity_roles`. As bases de planejamento e revisão usam obrigatoriamente `mode: "read-only"` e `agy --mode plan`; selecionar escrita nesses papéis é recusado. A retomada mantém o papel e a definição originais.

Os papéis de consulta exigem suporte a `agy --json-schema`. O planejamento devolve `summary`, `steps` com arquivos e verificações observáveis, e `unverified`. A revisão devolve `summary`, `reviewedFiles`, `findings` e `unverified`; cada achado contém gravidade P0–P3, caminho, linha, citação literal, mensagem, impacto e sugestão.

O relatório validado aparece em `task.report` na resposta completa. Com resposta compacta, use `antigravity_read_result` para ler o `structured_output` original do CLI. Relatórios são identificados como `agy-reported`; na revisão, `citationsChecked: true` significa que arquivos e citações foram conferidos, sem atestar a interpretação ou provar ausência de defeitos. Formato inválido, arquivos inexistentes ou citações inventadas impedem a conclusão normal da tarefa. Uma resposta de planejamento não significa que suas etapas foram executadas.

### Ler respostas grandes em partes

Use `antigravity_preview` com `includePatch: false` para obter arquivos, estatísticas, hash e `patchLength` sem enviar o diff inteiro. Depois chame `antigravity_read_patch` com `expectedSha256` e, opcionalmente, um `path` devolvido na prévia. A seleção é feita pelo Git, incluindo arquivos binários e caminhos com espaços; não depende de interpretar cabeçalhos do patch. Qualquer alteração do patch completo invalida a leitura, mesmo quando você seleciona apenas um arquivo.

`antigravity_result` aceita `includeResult: false` para omitir o resultado bruto, o prompt, relatórios transferidos, instruções do papel e a lista completa de arquivos da cópia. Quando `ready: true`, consulte `antigravity_read_result` para ler o resultado serializado como JSON. Guarde `contentSha256` e envie-o como `expectedContentSha256` nas páginas seguintes para detectar mudanças.

Os leitores recebem `offset` (padrão 0) e `limit` (padrão 10.000, entre 2 e 50.000). Retornam `text`, `nextOffset`, `hasMore`, `totalLength` e `contentSha256`. Concatene `text` até `hasMore: false`; use sempre o `nextOffset` devolvido. Os offsets usam unidades UTF-16 e o leitor preserva caracteres representados por pares substitutos, como emojis. As opções antigas continuam devolvendo o conteúdo inteiro quando os campos de omissão não são usados.

Defina `acceptanceCriteria` antes de iniciar uma tarefa. Cada critério tem `id`, `description` e, opcionalmente, `check` com `kind`, `path` e `text`. As verificações disponíveis são `file-exists`, `file-absent`, `file-contains` e `file-not-contains`; as duas últimas exigem `text`. Critérios são preservados em retomadas e não podem ser substituídos depois da execução.

Após revisar o patch, chame `antigravity_verify` com o hash atual e `reviews`. Para cada critério, informe `criterionId`, `verdict` (`passed`, `failed` ou `unverified`), `path`, `line`, `quote` e `explanation`. O bridge lê os arquivos da cópia, executa as verificações e confere se a citação corresponde exatamente à linha indicada. Uma alegação do Gemini, um resultado `SUCCESS` ou um registro de teste do cliente não substitui essas evidências.

A integração exige todos os critérios aprovados e uma revisão atual. Critérios ausentes ou pendentes geram `VERIFICATION_REQUIRED`. Alterações no patch ou nos arquivos usados como evidência invalidam a verificação, inclusive alterações em arquivos ignorados que não aparecem no diff. O servidor verifica novamente após a confirmação humana. A prévia inclui `verification` e `stale`.

As verificações automáticas demonstram apenas as condições declaradas; a correção funcional mais ampla depende dos testes pertinentes e da revisão do Codex. O parecer permanece identificado como `client-reported`: conferir uma citação não demonstra que sua interpretação está correta. Esse fluxo aplica a distinção entre alegação e estado final e combina verificações determinísticas com revisão, conforme a [orientação sobre avaliações de agentes](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

## Eventos, sessões e cancelamento

O bridge exige suporte aos formatos `stream-json` e a `--sandbox`, conferidos na descoberta do CLI. A versão verificada neste projeto é `agy` 1.2.16. Eventos estruturados chegam como NDJSON; diagnósticos de `stderr` permanecem separados. Linhas inválidas são expostas como `stream.unparsed`. O `EventStore` mantém um buffer limitado: `truncated: true` indica perda de eventos antigos. Registros de tarefas, sessões, eventos disponíveis, preferência de modelo e referências às cópias são persistidos por escrita atômica em `~/.antigravity-mcp-bridge` (ou `BRIDGE_STATE_DIRECTORY`). O estado contém prompts e resultados: mantenha esse diretório privado, fora dos projetos versionados e de pastas compartilhadas.

### Modelo padrão

Defina `BRIDGE_DEFAULT_MODEL` com um ID devolvido por `agy models` para o padrão inicial. `antigravity_set_model` grava a preferência no estado privado, compartilhada por servidores que usam o mesmo diretório. A prioridade é: `model` da tarefa, preferência salva, variável de ambiente e padrão do agy. A seleção é conferida contra a lista atual antes de executar; IDs indisponíveis causam `MODEL_NOT_AVAILABLE`.

Passe `model: null` para Auto: por tarefa, ignora os padrões do bridge; em `antigravity_set_model`, persiste o padrão do agy mesmo quando a variável está configurada. Omitir `model` preserva a preferência vigente. Para voltar ao padrão inicial do ambiente, pare o servidor e remova somente `model-selection.json` do diretório privado de estado.

`antigravity_resume` usa o `conversation_id` de uma tarefa concluída, inclusive após reinício, e reutiliza sua cópia isolada. Use `antigravity_tasks` para recuperar IDs e `antigravity_sessions` para consultar sessões persistidas. Execuções interrompidas não são repetidas automaticamente: recebem `SERVER_RESTARTED` quando o processo anterior já terminou. Se o PID registrado ainda estiver vivo, a cópia fica bloqueada com `ORPHAN_PROCESS_RUNNING`; o bridge não encerra processos recuperados apenas por PID. Tarefas de outro servidor ativo podem ser acompanhadas, mas devem ser canceladas no servidor que as iniciou. Locks locais impedem uso simultâneo da mesma cópia. O cancelamento encerra o subprocesso local; alterações parciais na cópia podem permanecer e devem ser revisadas.

## Cópia, revisão e integração

Antes de chamar `agy`, o bridge cria uma cópia temporária dos arquivos elegíveis e mantém um baseline Git separado da cópia. O CLI recebe a cópia como diretório de trabalho e a opção `--sandbox`. O projeto original só muda por `antigravity_integrate`, depois da revisão do patch. O bridge não faz commit, merge nem push.

Quando o CLI anuncia `--add-dir` e `--new-project`, o bridge declara a cópia como workspace e cria um projeto CLI separado na primeira execução. A retomada preserva o projeto da conversa. Essas opções não equivalem a uma comprovação de todas as fronteiras do sandbox; permissões negadas continuam sendo respeitadas.

O resultado informa `copyDirectory` e `includedFiles`. Cópias temporárias permanecem para revisão por 7 dias após a última tarefa finalizada. O servidor limpa cópias expiradas na inicialização e a cada minuto; `antigravity_cleanup` permite antecipar a verificação. Use `antigravity_discard` para remover imediatamente uma cópia pelo MCP. Tarefas retomadas compartilham a mesma cópia; todas perdem acesso após descarte. Cópias em uso são preservadas. A expulsão do último registro pelo limite de retenção também remove sua cópia. `isolateWorktree: true` é aceito apenas por compatibilidade e usa o mesmo fluxo de cópia; `false` é recusado.

`antigravity_preview` preserva `files`, `patch` e `sha256` e acrescenta `summary` (totais A/M/D, linhas e arquivos binários), `fileSummaries` (inserções/remoções por caminho) e `tests`. Binários usam `null` nas contagens de linhas. Registros de `antigravity_record_test` têm `source: "client-reported"`: são relatos cujo comando o bridge não executou. Registros capturados por `antigravity_test` indicam o executor que os observou. Cada registro leva hash, data, exit code e saída limitada pela seleção do teste; o padrão é 4.000 caracteres. Resultados antigos recebem `stale: true` quando a evidência já não corresponde aos arquivos atuais. Falhas são preservadas e devem ser apresentadas na revisão.

A cópia aceita até 10.000 arquivos e 256 MiB por padrão. A seleção é medida antes da criação e os bytes efetivamente copiados são conferidos novamente para detectar crescimento da origem. `includePaths` pode reduzir a seleção. Mais de 100 arquivos alterados gera `CHANGE_LIMIT_EXCEEDED` ao finalizar, revisar ou integrar. O original permanece intacto; reduza a tarefa ou ajuste os limites explicitamente no ambiente do servidor.

### Executar testes sem Docker

Chame `antigravity_test` com `taskId`, `expectedSha256` e `command: { executable, args }`. A ferramenta inicia uma continuação na mesma cópia e devolve outro `taskId`. Acompanhe esse ID pelos eventos e pelo resultado; revise e integre a tarefa mais recente. `retries` vale 0 por padrão e aceita até 3 tentativas de correção adicionais, solicitadas explicitamente. `timeoutSeconds` vale 600 por padrão.

No Windows, o bridge cria um processo AppContainer/LPAC por execução e executa o comando diretamente nessa fronteira. O perfil, o SID e as ACLs de acesso são exclusivos da execução; as concessões exatas são removidas ao final. A limpeza e a recuperação de uma execução interrompida são verificadas em processos novos. Uma queda de energia não remove essas ACLs instantaneamente: a recuperação seguinte precisa concluí-la, e uma falha de limpeza impede que o teste seja considerado verificado e bloqueia novo uso daquela concessão.

O executor Windows não instala Docker nem pede elevação UAC. Ele exige o compilador .NET Framework já existente no Windows para criar o controlador. Cada execução é isolada em um perfil novo; a cobertura atual inclui recuperação de processo e nova execução, mas não afirma uma reinicialização física do computador.

Para expor os diretórios próprios da execução, o controlador cria aliases temporários em dois níveis para a cópia, o runtime preparado e o scratch: um nome DOS e uma letra entre `D:` e `Z:` para cada diretório. São necessárias três letras livres. O controlador confere a identidade e o destino de cada mapeamento antes, durante e depois do comando e os remove na limpeza, inclusive ao recuperar uma execução interrompida. Esses nomes DOS ficam visíveis apenas no contexto de logon atual; a reserva por letra é coordenada por logon e letra. Eles não concedem acesso à raiz do volume, não criam um mount persistente e não pedem UAC.

Fora do Windows, ou com `BRIDGE_TEST_EXECUTOR=agy`, o bridge mantém o caminho legado: `agy --sandbox` e `run_command`, com recibo vinculado à chamada exata. Não há fallback para executar diretamente no host. Em todos os casos, um comando não zero produz `TEST_FAILED`, mudanças nos arquivos durante/depois do comando produzem `TEST_CHANGED_PATCH`, e a evidência precisa continuar atual para integração.

No Windows, a evidência tem `source: "windows-executor"` e `sandbox: "windows-lpac"`; fora dele, tem `source: "agy-tool"` e `sandbox: "agy-native-requested"`. A evidência inclui seleção de sandbox, hash da política, saída limitada e fingerprints antes/depois. A execução local conhecida registra zero tokens de modelo. Se uma correção pelo `agy` for solicitada após uma falha, seus contadores continuam sendo somente os devolvidos pelo CLI; campos ausentes permanecem `null`.

Saída ou texto do modelo, inclusive uma afirmação de que o comando passou, não é recibo de teste. Use somente a evidência observada pelo executor escolhido, com seu exit code e os campos de sandbox correspondentes.

No Windows, o bridge preenche `PATHEXT` ausente no subprocesso com `.COM;.EXE;.BAT;.CMD`, para que o PowerShell encontre os executáveis instalados. Valores definidos pelo cliente, inclusive um valor vazio, são preservados. O SDK pode omitir essa variável no ambiente herdado, fazendo `node` parecer ausente mesmo quando o arquivo está instalado. A correção vale para as sondagens e para todas as tarefas, sem configuração por projeto.

No Windows, use um `.exe` nativo ou `npm`/`npm.cmd`. Para npm, o bridge valida o launcher instalado, seu pacote e `npm-cli.js`, e chama o `node.exe` preparado com os argumentos literais. Lotes `.cmd`/`.bat` arbitrários e outros interpretadores não são suportados pelo executor. O staging rejeita caminhos remotos, dispositivos, streams alternativos e NUL; só o runtime validado é copiado sob limites de tamanho. Arquivos preparados pelo usuário não podem usar links; o `cmd.exe` interno deriva de um caminho fixo do Windows.

#### Compatibilidade de subprocessos Node no Windows LPAC

No Node 24.14.1 com libuv 1.51, `child_process.spawnSync` com pipes padrão de stdin/stdout/stderr cria endpoints globais `\\?\pipe\uv\...`. O LPAC recusa o `CreateNamedPipe` global com erro 5, enquanto endpoints equivalentes `LOCAL\...` abrem. A captura de stdout/stderr do processo pai está corrigida; no Node 24.14.1 do sistema, esse caso com pipes padrão ainda expira com exit code 124.

Testes de filhos com `stdio: "inherit"` e do ciclo real do npm passaram, mas não demonstram compatibilidade geral de subprocessos porque não exercitam os pipes capturados por padrão. Não substitua os pipes por stdio herdado para apresentar essa falha como resolvida.

O [PR 5181 do libuv](https://github.com/libuv/libuv/pull/5181/files) corrige os nomes de pipe para AppContainer e a correção entrou no [libuv 1.53](https://github.com/libuv/libuv/releases/tag/v1.53.0). O runtime portátil Node 24.21.0 LPAC1 para Windows x64, com libuv base 1.52.1 e somente esse PR aplicado, já está publicado em Release imutável e disponível para preparação explícita. Esse build passou pela regressão LPAC de `spawnSync` com pipes padrão capturados (1 teste) e pelos testes de isolamento e ciclo de vida (22 testes, sem falhas nem skips). A validação se aplica a esse build fixado.

`network: true` concede somente as capacidades Windows `internetClient` e `privateNetworkClientServer`, que permitem tráfego de Internet e LAN privada bidirecional. Não há capacidades arbitrárias, exceção para localhost, alteração de firewall nem acesso de rede quando a seleção não o permite. `childProcesses` e `maxOutputChars` também ficam limitados pela política aprovada.

Para testar com a conta real em um projeto descartável, execute `npm run build` e `node tests/native-integration.mjs`. Esse teste usa a conta do agy e verifica a captura de uma execução real; a suíte padrão usa o CLI simulado e não consome quota.

## Configuração e segurança

| Variável | Padrão | Uso |
| --- | --- | --- |
| `BRIDGE_CUSTOM_ROLES` | `[]` | Até 20 papéis em JSON com nome, base e instruções |
| `BRIDGE_TOOL_PROFILE` | `full` | Catálogo: `full`, `query`, `review` ou `implementation` |
| `BRIDGE_TEST_EXECUTOR` | `windows-lpac` no Windows; `agy` nos demais sistemas | Executor de `antigravity_test`; `agy` força o caminho legado no Windows |
| `BRIDGE_WINDOWS_NODE_RUNTIME` | `system` | No Windows, usa `system` ou o runtime portátil previamente preparado; o plugin distribuído define `portable` |
| `BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY` | `~/.antigravity-mcp-bridge/windows-runtimes` | Diretório confiável opcional, fora dos projetos, para compartilhar o cache portátil entre diretórios de estado; não é entrada MCP |
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
| `MAX_PROMPT_CHARS` | `50000` | Tamanho máximo do prompt enviado, incluindo critérios, contexto transferido e instruções do bridge e do papel |
| `FORBIDDEN_DIRECTORIES` | vazio | Diretórios bloqueados, separados por `;` no Windows |

Entradas e diretórios são validados. Tarefas delegadas usam `spawn` sem shell e exigem `--sandbox`; não passam `--dangerously-skip-permissions`. Testes Windows usam o executor LPAC do bridge por padrão. Não inclua credenciais ou documentos privados nos prompts. Mantenha arquivos sensíveis fora da cópia por regras de ignore e selecione apenas os caminhos necessários com `includePaths`. Consulte a [documentação do sandbox](https://antigravity.google/docs/sandbox/) e [do modo headless](https://www.antigravity.google/docs/cli/headless/).

Erros comuns incluem `AGY_NOT_FOUND`, `AGY_AUTH_REQUIRED`, `MODEL_NOT_AVAILABLE`, `INVALID_WORKING_DIRECTORY`, `QUEUE_FULL` e `AGY_PROCESS_FAILED`. Se houver `AGY_AUTH_REQUIRED`, faça login no `agy` interativo. Se as ferramentas não aparecerem no Codex, confirme a instalação com `codex plugin list --json` e abra uma conversa nova.

## Testes

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build:plugin
npm.cmd run test:package
```

`npm test` usa um mock do `agy` e não consome quota. `npm run test:package` também consulta o status do runtime pelo pacote empacotado; em plataformas fora do Windows ele deve informar `supported: false` sem preparar nada. A integração real é opcional: `npm run test:integration` cria um repositório descartável, executa uma tarefa pelo cliente MCP, confere que o original permanece intacto até a integração e remove o repositório. Esse teste simula a resposta de confirmação somente para seu projeto descartável; a confirmação humana da interface deve ser usada nos projetos reais. Execute-a apenas com `agy` autenticado e quando quiser usar a conta real.

## Licença e políticas

O projeto usa a [licença MIT](LICENSE). Consulte a [política de segurança](SECURITY.md), a [política de privacidade](PRIVACY.md), o [histórico de versões](CHANGELOG.md) e os [avisos das dependências distribuídas](THIRD_PARTY_NOTICES.md). `npm run build:plugin` atualiza o bundle e os avisos a partir das dependências efetivamente incluídas.
