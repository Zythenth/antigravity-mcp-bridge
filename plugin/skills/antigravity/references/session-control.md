# Session messages and task control

Reference for the [core skill](../SKILL.md). Open it when using `antigravity_send_message`, discard or cleanup, or on `SERVER_RESTARTED` or `ORPHAN_PROCESS_RUNNING`.

## Conversar com a sessão

Use `antigravity_send_message` com taskId, messageId UUID estável e text de até 2.000 caracteres. Guarde ID e texto: repetir os mesmos valores consulta o recibo existente. Com erro de transporte ambíguo, não gere automaticamente outro ID. `queued` aguarda o turno atual; `sent` informa aceitação de uma continuação, sem comprovar leitura pelo modelo. Falha ou cancelamento não autorizam repetição automática e consumo adicional de quota.

Siga `continuationTaskId` com cursor zero. Se `continuationPending` estiver ativo sem ID, continue esperando no turno atual; `ready` encerra aquele turno, não a sequência pendente. A retomada conserva sessão, cópia, seleção, skills, papel, modo, critérios e limites. Texto não aprova integração ou permissões.

## Continuação e controle

- Use o `taskId` de uma tarefa concluída com `antigravity_resume` para continuar na mesma cópia; informe exatamente um entre `taskId` e `sessionId`, este obtido por `antigravity_status`. `antigravity_sessions` lista sessões persistidas e `antigravity_tasks` recupera IDs de tarefas após reinício. Execuções interrompidas não são repetidas: examine `SERVER_RESTARTED` e a cópia antes de iniciar outro trabalho. Se houver `ORPHAN_PROCESS_RUNNING`, aguarde o processo registrado terminar; não tente aplicar ou descartar sua cópia.
- Quando o usuário pedir cancelamento, chame `antigravity_cancel` com o `taskId` e confirme o status. O cancelamento encerra o processo local; alterações parciais podem permanecer.
- Quando o usuário quiser descartar o trabalho, chame `antigravity_discard` depois que a tarefa terminar. A remoção alcança todas as tarefas retomadas na mesma cópia. Use `antigravity_cleanup` para remover cópias expiradas; a retenção padrão é de 7 dias. `antigravity_health.maintenanceIssues` com `copy-cleanup` indica falha da limpeza automática (o servidor continua e tenta de novo a cada minuto); examine o `code` antes de chamar `antigravity_cleanup`.
- Depois de falha ou timeout, examine eventos e a cópia antes de repetir a tarefa. Não faça nova execução automaticamente se ela puder repetir efeitos ou consumir quota.
