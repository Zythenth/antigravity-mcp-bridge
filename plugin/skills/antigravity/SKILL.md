---
name: antigravity
description: Use quando o usuário pedir ao Codex para delegar programação ao Google Antigravity ou agy, consultar seus modelos, acompanhar uma tarefa, retomá-la ou cancelá-la. Não acione para programação comum sem pedido de delegação.
---

# Antigravity no Codex

Use as ferramentas MCP `antigravity_*`; toda comunicação com o Google deve passar pelo CLI oficial `agy` executado pelo bridge. O Codex planeja, acompanha e revisa; o Antigravity implementa quando o usuário pede essa delegação.

## Escolha da ação

- Para disponibilidade ou autenticação, chame `antigravity_health`. Se receber `AGY_AUTH_REQUIRED`, oriente o usuário a abrir `agy` interativamente; não tente ler credenciais nem fazer login pelo bridge.
- Para saber os modelos, chame `antigravity_list_models`. Use somente IDs devolvidos pelo CLI. Quando o usuário disser “Pro” ou “Flash”, escolha uma variante compatível da lista e diga qual ID escolheu. Se a escolha tiver impacto material e não houver preferência inferível, pergunte. Para “Auto”, passe `model: null`; não invente um ID `auto`. Omitir o campo utiliza a preferência existente.
- Prefira `model` em `antigravity_run` para seleção por tarefa. `antigravity_set_model` persiste o padrão no estado privado para tarefas futuras, inclusive após reinício. `model: null` persiste Auto. A ordem é escolha da tarefa, preferência salva, `BRIDGE_DEFAULT_MODEL` e padrão do agy. Consulte `antigravity_get_model` antes de informar a preferência atual.

## Delegação e acompanhamento

1. Identifique a raiz Git absoluta do projeto. Antes de formular a tarefa, leia as instruções e arquivos relevantes e observe mudanças Git existentes. Não inclua segredos nem documentos privados no prompt enviado ao Antigravity. Use `antigravity_list_project_files` para verificar o que pode entrar na cópia.
2. Para consulta, revisão, diagnóstico ou segunda opinião, use `mode: "read-only"`; esse modo usa `agy --mode plan`, verifica alterações ao final e não permite integração. Para implementação, use `mode: "write"` (padrão). Chame `antigravity_run` com uma instrução concreta e critério verificável. Por padrão, a cópia inclui arquivos rastreados e não rastreados que não estejam em `.gitignore` ou `.git/info/exclude`, mesmo quando um arquivo ignorado é rastreado. Selecione `includePaths` quando somente alguns arquivos ou pastas forem necessários; a seleção não pode incluir arquivos ignorados. Se receber `COPY_LIMIT_EXCEEDED`, reduza a seleção com `includePaths`. Para `CHANGE_LIMIT_EXCEEDED`, revise o tamanho da tarefa com o usuário; não tente contornar o limite. Os padrões são 10.000 arquivos/256 MiB copiados e 100 arquivos alterados. O bridge exige `agy --sandbox` e trabalha sempre na cópia.
3. Guarde o `taskId`. Chame `antigravity_events` com `after: 0` e continue com o `nextCursor` retornado; consulte `antigravity_result` até `ready: true`. Os eventos informam atividade observável, não raciocínio privado. Se `truncated` for verdadeiro, informe a perda de eventos antigos.
4. Após `completed`, chame `antigravity_preview`, apresente `summary` e `fileSummaries` (A/M/D, linhas adicionadas/removidas e binários), revise o patch inteiro e execute os testes pertinentes na cópia. Registre os comandos realmente executados com `antigravity_record_test`, usando o hash atual e a saída sem segredos. Esses registros são relatos do cliente, não verificação independente do bridge. Apresente falhas e registros `stale: true`; não os use como evidência válida do patch atual. Um resultado `SUCCESS` do CLI não substitui essa verificação. Chame `antigravity_integrate` com o `taskId` e o `sha256` da prévia para solicitar a confirmação final pela interface MCP. O servidor exige `form elicitation` e uma resposta do cliente com `accept` e `confirm: true`; hash ou argumentos como `approved` não autorizam a operação. Se `integrationApproval.available` for falso, informe que esse cliente não permite integração pelo bridge. Não contorne a confirmação aplicando o patch por outro caminho sem uma autorização específica do usuário para esse caminho. Relate falhas e limitações com precisão.

## Informar tokens usados

- Ao concluir, relatar falha ou encerrar uma delegação, informe os tokens do Gemini/agy usando `task.tokenUsage` ou `antigravity_usage`. Mostre `totalTokens` e, quando disponíveis, entrada, saída, raciocínio e cache. Identifique os dados como uso informado pelo CLI.
- Para uma sequência com retomadas, consulte o consolidado da sessão; não some `result.usage` cumulativo de cada resposta. O consumo por tarefa já usa a diferença dos contadores anteriores. Preserve a distinção entre tarefas retidas e o acumulado observado da sessão.
- Se houver `null`, `available: false`, `partial: true` ou avisos, explique a limitação. Não estime contadores ausentes, não atribua zero a uma execução sem dados e não confunda tokens com preço ou quota da conta.
- Informe também consumo de tarefas falhas quando disponível. Não afirme execução de testes somente porque houve consumo do modelo; o recibo do terminal continua necessário.

## Papéis de consulta

- Use `role: "planner"` para preparar um plano com arquivos e verificações, ou `role: "reviewer"` para uma revisão com achados estruturados. Ambos usam consulta sem alterações. `role: "implementer"` mantém o fluxo de implementação.
- Examine `task.report` ou o `structured_output` lido em partes. Apresente gravidade, arquivo, linha, evidência, impacto e correção dos achados. Exponha `unverified` e não transforme um plano em relato de trabalho concluído.
- `citationsChecked` comprova somente a correspondência literal das citações. Confirme os achados contra o requisito e o comportamento real; uma lista vazia não demonstra correção. A retomada conserva o papel; use uma nova tarefa quando precisar mudar de planejamento/revisão para implementação.

## Leitura por partes

- Acompanhe `antigravity_result` com `includeResult: false`. Depois de `ready: true`, leia somente os trechos necessários por `antigravity_read_result`, mantendo `contentSha256` nas páginas seguintes.
- Peça `antigravity_preview` com `includePatch: false`. Leia o diff de cada arquivo alterado por `antigravity_read_patch`, com o hash completo e o caminho informado na prévia. Siga `nextOffset` até `hasMore: false`; não declare revisão completa se restarem trechos.
- Se houver `REVIEW_CHANGED` ou `CONTENT_CHANGED`, obtenha uma nova prévia/primeira página e reinicie a revisão afetada. Nunca concatene páginas de versões diferentes. Não calcule offsets manualmente nem assuma que o trecho recebido é todo o conteúdo.

## Evidência antes da integração

- Defina `acceptanceCriteria` em `antigravity_run` antes da implementação, cobrindo cada requisito explícito. Use verificações de arquivo quando aplicáveis e critérios de revisão para comportamentos que exigem interpretação. A retomada mantém os critérios originais.
- Leia os artefatos reais e compare cada requisito com o resultado. Para cada critério, envie a `antigravity_verify` uma revisão com arquivo, linha, citação literal e explicação. Não invente citações, saídas ou execução de comandos. Classifique falta de prova como `unverified` e defeitos como `failed`.
- `completed` e `SUCCESS` indicam o término da execução. Só relate um requisito como atendido com evidência pertinente. Confira também testes, efeitos observáveis, requisitos não cobertos e limitações; uma busca textual ou citação correta não comprova todo o comportamento.
- Sem critérios, revisão completa ou verificação atual, o servidor bloqueia a integração. Se o patch ou a evidência mudar, revise e verifique novamente. A aprovação humana continua necessária.

## Testes no sandbox nativo

- Use `antigravity_test` com comando separado em `executable` e `args`, hash atual e prazo adequado. No Windows, selecione `npm.cmd` para scripts npm. O servidor usa o sandbox do agy; Docker não é necessário. Não contorne permissões negadas com execução no host.
- A ferramenta devolve uma continuação com outro `taskId`. Acompanhe esse ID e faça a revisão/integração da tarefa mais recente. Examine os registros `source: "agy-tool"`, exit code, saída, erros e `stale`. Não atribua execução real a `client-reported` ou à narrativa do Gemini.
- `retries: 0` preserva o padrão sem correção automática. Só peça até 3 correções adicionais quando autorizadas pela tarefa e informe o consumo. O comando permanece o mesmo; confira o diff para detectar testes enfraquecidos ou mudanças fora do escopo.
- `TEST_EXECUTION_UNVERIFIED` indica que faltou um recibo do terminal. Não diga que o teste passou. `TEST_FAILED` preserva a falha observada e permite retomada para correção. Rode novamente os comandos depois de mudar os arquivos; registros antigos não validam o patch atual.
- No Windows, `escalate_admin`/`Bash` pode indicar a configuração inicial do sandbox. O CLI interativo mostra um cartão UAC que identifica essa finalidade. Oriente a configuração em pasta descartável com `agy --sandbox` e `node --version`; a elevação depende de autorização do usuário e da confirmação do Windows. Não aprove privilégios automaticamente nem acrescente permissões genéricas. Depois da configuração, tente novamente o executor e confira seu recibo.

## Continuação e controle

- Use o `sessionId` de uma tarefa concluída com `antigravity_resume` para continuar na mesma cópia. `antigravity_sessions` lista sessões persistidas e `antigravity_tasks` recupera IDs de tarefas após reinício. Execuções interrompidas não são repetidas: examine `SERVER_RESTARTED` e a cópia antes de iniciar outro trabalho. Se houver `ORPHAN_PROCESS_RUNNING`, aguarde o processo registrado terminar; não tente aplicar ou descartar sua cópia.
- Quando o usuário pedir cancelamento, chame `antigravity_cancel` com o `taskId` e confirme o status. O cancelamento encerra o processo local; alterações parciais podem permanecer.
- Quando o usuário quiser descartar o trabalho, chame `antigravity_discard` depois que a tarefa terminar. A remoção alcança todas as tarefas retomadas na mesma cópia. Use `antigravity_cleanup` para remover cópias expiradas; a retenção padrão é de 7 dias.
- Depois de falha ou timeout, examine eventos e a cópia antes de repetir a tarefa. Não faça nova execução automaticamente se ela puder repetir efeitos ou consumir quota.

O `--sandbox` restringe comandos de terminal do CLI, mas não garante isolamento completo do sistema de arquivos no Windows. Não delegue acesso a arquivos sensíveis apenas com base nessa opção; use a lista de arquivos e revise o conteúdo efetivamente copiado.
