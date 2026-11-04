# Groups and peer messages

Reference for the [core skill](../SKILL.md). Open it when using `antigravity_group_*`, `antigravity_wait_many` or messages between nodes.

## Grupos e espera conjunta

Confira se o catálogo conectado anuncia estas ferramentas antes de utilizá-las.

- Crie com `antigravity_group_create`, UUID estável e `definition` contendo raiz Git, título e até 32 `jobs`. Cada nó tem `key`, `owner` de `antigravity_roles`, `dependsOn` e opções em `task`. Grupos usam entrega compacta `messages`; não importam nem integram automaticamente as alterações de outro nó.
- Guarde `groupId` e `definitionSha256`. Inicie ou retome explicitamente com `antigravity_group_start` e o hash. O mesmo UUID só pode repetir a mesma definição. Não gere outro ID automaticamente após uma resposta de transporte ambígua.
- Track the group with the `waitCommand` (`--group <groupId>`) returned by `antigravity_group_start`, and standalone tasks with the `waitCommand` (`<taskId>:<nextCursor>`) returned by `antigravity_wait_many`, following `waitCommand.recommendedMode` (`"background"` in the background, `"foreground"` in the foreground). When restarting after `question` (`5`), `blocker` (`6`) or `wait-deadline` (`8`), pass the `<taskId>:<resumeAfter>` pairs returned in `targets`. On `group-paused` (`11`) or `group-ended` (`12`), query `antigravity_group_status` (and `antigravity_workflow_result` when applicable). When no terminal is available, use `antigravity_group_wait` or `antigravity_wait_many`, up to 60 seconds, carrying the returned per-task cursors; each response holds at most four public messages: check `hasMoreMessages`/`hasMore`, even after `ready: true`, plus any flagged losses, and read results/patches only when needed.
- `resumeRequired` pede retomada explícita. Falhas de admissão sem identidade, perda de tarefa retida ou mudança de perfil não autorizam repetição automática. Examine `GROUP_ADMISSION_UNVERIFIED`, `GROUP_TASK_MISSING` e `GROUP_PROFILE_CHANGED`. Em `GROUP_COORDINATION_FAILED`, `error.cause` traz somente `errorClass`, `code`, `syscall` e `frame`; use esses campos no diagnóstico e retome explicitamente só depois de examinar as tarefas existentes.
- `antigravity_group_cancel` impede novas etapas e cancela as tarefas no servidor responsável. Cancelar a espera mantém o trabalho. Um grupo concluído não comprova critérios nem autoriza integração; mantenha o fluxo de revisão, testes, verificação e hash.

## Mensagens entre nós do grupo

- Confira `antigravity_peer_receipts` no catálogo conectado. Selecione `definition.peerRoutes` com até 128 pares `{from,to}`; omissão ou `[]` nega envios, sem permissão reversa ou broadcast.
- O delegado emite envelopes públicos `<antigravity-peer-message>` com JSON estrito `{messageId,toNode,text}` e fechamento correspondente. Use UUID estável e até 2.000 caracteres. Identidade, responsável, projeto e raiz de conversa são verificados.
- Consulte recibos com `groupId`, `after` e `limit` até 20. Corpos não entram na página; `queued` aguarda um turno e `sent` confirma aceitação da continuação, sem provar leitura. Releia a página para conferir estados alterados.
- Dependências aguardam continuações; acompanhe seus novos IDs e cursores. Novos turnos consomem quota. Leia resultados públicos somente quando necessário.
- Não gere outro ID após confirmação perdida. `PEER_MESSAGE_CONFLICT`, `PEER_LIMIT_EXCEEDED` e `PEER_DISPATCH_UNVERIFIED` exigem inspeção antes da retomada. Falhas não autorizam outra sessão; mensagens não autorizam ferramentas, testes ou integração.
- Políticas nativas sem schema explícito usam o resumo JSON `{"summary":"..."}` para oferecer `finish`. Envelopes no campo público `summary` também são reconhecidos. Preserve formatos explícitos selecionados pelo chamador.
