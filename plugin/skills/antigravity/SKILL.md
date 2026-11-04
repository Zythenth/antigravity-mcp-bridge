---
name: antigravity
description: Use quando o usuário pedir para delegar programação ao Google Antigravity ou agy, consultar seus modelos, acompanhar uma tarefa, retomá-la ou cancelá-la. Não acione para programação comum sem pedido de delegação.
---

# Antigravity

Use as ferramentas MCP `antigravity_*`; toda comunicação com o Google deve passar pelo CLI oficial `agy` executado pelo bridge. O agente chamador planeja, acompanha e revisa; o Antigravity implementa quando o usuário pede essa delegação.

Open a reference only when the table at the end matches the task; search `references/` for any error, field or tool not covered here.

## Perfil e modos de aprovação

Consulte `antigravity_health`:
- **Perfil de ferramentas**: `antigravity_health.toolProfile`. `query` e `review` executam somente em leitura; não peça ferramentas ausentes nem contorne o perfil. `full` e `implementation` oferecem o fluxo completo. Para alterar, configure `BRIDGE_TOOL_PROFILE` no ambiente privado do servidor e reinicie a conexão MCP.
- **Modo de aprovação**: a skill DEVE consultar `antigravity_health` e seguir o modo informado em `health.approvalMode` (e `health.integrationApproval.mode`).
  - **Modo `auto` (padrão se unset)**: dispensa formulários interativos de confirmação humana para `antigravity_integrate` e para atualizações validadas de `antigravity_set_sandbox_policy`. **Não imponha orientações que exijam extra autorização manual ao chamador em `auto`**. Delegados via `agy` (Gemini) NÃO escolhem, não autorizam nem proporcionam permissões.
  - **Modo `ask` (opt-in estrito)**: exige SEMPRE confirmação humana via formulário MCP.
  - **Fronteiras e limites**: nenhum modo permite fallback automático ao host nem altera permissões do chamador ou do `agy`. A integração é realizada exclusivamente via MCP; a autorização NUNCA substitui testes e revisão de código. Não afrouxe hashes SHA-256, critérios, revisão, testes observados atuais, source-lock, CAS e proteção de caminhos.

## Escolha da ação

- Para disponibilidade ou autenticação, chame `antigravity_health`. Se receber `AGY_AUTH_REQUIRED`, oriente o usuário a abrir `agy` interativamente; não tente ler credenciais nem fazer login pelo bridge.
- Para saber os modelos, chame `antigravity_list_models`. Use somente IDs devolvidos pelo CLI. Quando o usuário disser “Pro” ou “Flash”, escolha uma variante compatível da lista e diga qual ID escolheu. Se a escolha tiver impacto material e não houver preferência inferível, pergunte. Para “Auto”, passe `model: null`; não invente um ID `auto`. Omitir o campo utiliza a preferência existente.
- Quando o usuário pedir cancelamento, chame `antigravity_cancel` com o `taskId` e confirme o status. O cancelamento encerra o processo local; alterações parciais podem permanecer.
- To continue a conversation, call `antigravity_resume` with the `taskId` of the previous task (after a restart, recover it with `antigravity_tasks`), never with a `sessionId` or a provisional value.

## Delegação e acompanhamento

1. Identifique a raiz Git absoluta do projeto. Antes de formular a tarefa, leia as instruções e arquivos relevantes e observe mudanças Git existentes. Não inclua segredos nem documentos privados no prompt enviado ao Antigravity. Use `antigravity_list_project_files` para verificar o que pode entrar na cópia.
2. Para consulta, revisão, diagnóstico ou segunda opinião, use `mode: "read-only"`; esse modo usa `agy --mode plan`, verifica alterações ao final e não permite integração. Para implementação, use `mode: "write"` (padrão). Chame `antigravity_run` com uma instrução concreta e critério verificável. Prefira `deliveryMode: "messages"` para delegações comuns. Defina `acceptanceCriteria` em `antigravity_run` antes da implementação, cobrindo cada requisito explícito.
   - O bridge exige `agy --sandbox` e trabalha sempre na cópia. Selecione `includePaths` quando somente alguns arquivos ou pastas forem necessários; a seleção não pode incluir arquivos ignorados.
   - Ao especificar `includePaths`, o prompt formulado para o delegado DEVE enumerar os caminhos exatos desses arquivos e solicitar alterações ou consultas exclusivamente sobre eles, instruir o delegado a declarar dependências ausentes como não verificáveis e a finalizar a tarefa sem ampliar o escopo nem tentar buscas recusadas no disco. Se receber `COPY_LIMIT_EXCEEDED`, reduza a seleção com `includePaths`. Para `CHANGE_LIMIT_EXCEEDED`, revise o tamanho da tarefa com o usuário; não tente contornar o limite.
   - Quando disponível, consulte `antigravity_get_agent_policy` antes de delegar. Quando a tarefa não precisa de terminal, restrinja `allowedTools` às ferramentas de arquivo e `finish`; diga no prompt o que o coordenador vai compilar e testar no host.
3. Keep the `taskId` and the `waitCommand` (`{ argv, sh, recommendedMode, reason }`) returned by `antigravity_run`, `antigravity_resume`, `antigravity_handoff`, `antigravity_compare`, `antigravity_group_start` or `antigravity_wait_many`. Follow `waitCommand.recommendedMode` strictly:
   - `"background"` (ONLY Claude Code >= 2.1.310 is verified): start `waitCommand.argv` (or `waitCommand.sh` in a POSIX shell) in the background right after delegating, and do not call `antigravity_wait`, `antigravity_status`, `antigravity_events` or their group and multi-task variants while it runs. Pass an explicit `timeout` in the Bash call (in milliseconds) and pass `--timeout` to the CLI `wait` command (in seconds) strictly below the host's real background deadline with a safety margin, so the command can emit its single JSON line before the host kills it. Check that deadline in the host tool schema or configuration; if the host imposes none, the product default of 1800s is preserved.
   - `"foreground"` (any other host; do not promise notifications): prefer running the same command in a blocking terminal instead of 60-second MCP polling, with `--timeout` strictly below the terminal's real deadline. Use `antigravity_wait` (`timeoutSeconds: 60`, continuing with `nextCursor` while `ready` is false) ONLY when the host cannot run terminal commands; a wait timeout or cancellation does not end the task.
   - Run the command as returned, adding only `--timeout`, `--after` or more targets. Never use a pipe or a redirection that replaces its exit code: `2>&1 | tail -3` reports the exit code of `tail`.
   - When it ends, read the JSON line and make ONE single query according to `outcome`: `completed`, `failed`, `cancelled` or `timeout` -> one `antigravity_result` with `includeResult: false`; `question` or `blocker` -> one `antigravity_wait` with `after: cursor - 1`, answer it and restart with `--after <cursor>`; `wait-deadline` -> restart with `--after <after>`, keeping the input cursor, without MCP polling; `owner-stopped` -> one `antigravity_status`; `unknown-task` or `error` -> check the IDs and directory and fall back to `antigravity_wait`. Stopping the command cancels no task.
4. Após `completed`, chame `antigravity_preview`, apresente `summary` e `fileSummaries`, revise o patch inteiro e execute os testes pertinentes na cópia.
   - Peça `antigravity_preview` com `includePatch: false`. Leia o diff de cada arquivo alterado por `antigravity_read_patch`, com o hash completo e o caminho informado na prévia. Siga `nextOffset` até `hasMore: false`; não declare revisão completa se restarem trechos.
   - Na revisão do patch, rejeite ou corrija blocos duplicados, linhas reescritas sem mudança, parâmetros descartados ao envolver funções, mudanças não pedidas em timers, erros ou ciclo de vida, valores alterados além dos pedidos e arquivos novos não pedidos, como temporários ou de rascunho.
   - Registre os comandos realmente executados com `antigravity_record_test`, usando o hash atual e a saída sem segredos. Esses registros são relatos do cliente, não verificação independente do bridge. Apresente falhas e registros `stale: true`; não os use como evidência válida do patch atual.
5. Leia os artefatos reais e compare cada requisito com o resultado. Para cada critério, envie a `antigravity_verify` uma revisão com arquivo, linha, citação literal e explicação. Não invente citações, saídas ou execução de comandos. Classifique falta de prova como `unverified` e defeitos como `failed`. `completed` e `SUCCESS` indicam o término da execução. Só relate um requisito como atendido com evidência pertinente.
6. Chame `antigravity_integrate` com o `taskId` e o `sha256` da prévia. Sem critérios, revisão completa ou verificação atual, o servidor bloqueia a integração. Se o patch ou a evidência mudar, revise e verifique novamente. Não contorne a confirmação aplicando o patch por outro caminho sem autorização do usuário. Relate falhas e limitações com precisão.

## Regras de toda delegação

- **Anti-AI Craft**: em tarefas novas, o bridge prepara automaticamente `anti-ai-code` e `anti-ai-security`; não as envie de novo em `skills` nem peça ao usuário para repetir os nomes. The implementer and the reviewer must each load, read and apply both skills in their own session, also in fixes, resumes and handoffs.
- O `--sandbox` restringe comandos de terminal do CLI, mas não garante isolamento completo do sistema de arquivos no Windows. Não delegue acesso a arquivos sensíveis apenas com base nessa opção; use a lista de arquivos e revise o conteúdo efetivamente copiado.
- Depois de falha ou timeout, examine eventos e a cópia antes de repetir a tarefa. Não faça nova execução automaticamente se ela puder repetir efeitos ou consumir quota.
- Ao concluir, relatar falha ou encerrar uma delegação, informe os tokens do Gemini/agy usando `task.tokenUsage` ou `antigravity_usage`. Mostre `totalTokens` e, quando disponíveis, entrada, saída, raciocínio e cache. Identifique os dados como uso informado pelo CLI.
- Se houver `null`, `available: false`, `partial: true` ou avisos, explique a limitação. Não estime contadores ausentes.

## When to open a reference

| Open | When the task involves |
|---|---|
| [approval-modes.md](references/approval-modes.md) | Changing approval mode or tool profile, `approvalMode` missing, preauthorized roots |
| [specialist-tools.md](references/specialist-tools.md) | `mcpServers`, tools beyond the file tools above, `AGY_MCP_PERMISSION_REQUIRED`, pending agy permissions, token pre-counting |
| [models.md](references/models.md) | Current or default model, `antigravity_compare` |
| [copy-and-execution.md](references/copy-and-execution.md) | Copy contents and limits, line-ending errors, `leftoverFiles`, `TASK_OWNED_BY_OTHER_SERVER` |
| [waiting.md](references/waiting.md) | MCP waits, `truncated`, exit codes, multi-task or group waits, `continuationTaskId`, `deliveryMode: "events"` |
| [review-and-integration.md](references/review-and-integration.md) | Integration refusals, encoding issues, chunked result reads, `integrationApproval.available` false |
| [session-control.md](references/session-control.md) | `antigravity_send_message`, discard, cleanup, `SERVER_RESTARTED`, `ORPHAN_PROCESS_RUNNING` |
| [provided-skills.md](references/provided-skills.md) | `skills` option, `CRAFT_SNAPSHOT_*` errors |
| [token-usage.md](references/token-usage.md) | Usage across resumed or failed tasks |
| [roles.md](references/roles.md) | `role`, custom roles, `antigravity_handoff` |
| [windows-sandbox.md](references/windows-sandbox.md) | `antigravity_test`, sandbox policy, portable Node, LPAC failures |
| [private-memory.md](references/private-memory.md) | `antigravity_memory_*`, `memory` option |
| [groups.md](references/groups.md) | `antigravity_group_*`, `antigravity_wait_many`, peer messages |
| [workflows.md](references/workflows.md) | `definition.workflow`, `definition.budget` |
