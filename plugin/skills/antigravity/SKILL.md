---
name: antigravity
description: Use quando o usuário pedir ao Codex para delegar programação ao Google Antigravity ou agy, consultar seus modelos, acompanhar uma tarefa, retomá-la ou cancelá-la. Não acione para programação comum sem pedido de delegação.
---

# Antigravity no Codex

Use as ferramentas MCP `antigravity_*`; toda comunicação com o Google deve passar pelo CLI oficial `agy` executado pelo bridge. O Codex planeja, acompanha e revisa; o Antigravity implementa quando o usuário pede essa delegação.

## Escolha da ação

- Para disponibilidade ou autenticação, chame `antigravity_health`. Se receber `AGY_AUTH_REQUIRED`, oriente o usuário a abrir `agy` interativamente; não tente ler credenciais nem fazer login pelo bridge.
- Para saber os modelos, chame `antigravity_list_models`. Use somente IDs devolvidos pelo CLI. Quando o usuário disser “Pro” ou “Flash”, escolha uma variante compatível da lista e diga qual ID escolheu. Se a escolha tiver impacto material e não houver preferência inferível, pergunte. Para “Auto”, omita `model` e deixe o `agy` escolher o padrão; não invente um ID `auto`.
- Prefira `model` em `antigravity_run` para seleção por tarefa. `antigravity_set_model` define apenas o padrão em memória para tarefas futuras deste processo MCP.

## Delegação e acompanhamento

1. Identifique a raiz Git absoluta do projeto. Antes de formular a tarefa, leia as instruções e arquivos relevantes e observe mudanças Git existentes. Não inclua segredos nem documentos privados no prompt enviado ao Antigravity. Use `antigravity_list_project_files` para verificar o que pode entrar na cópia.
2. Para consulta, revisão, diagnóstico ou segunda opinião, use `mode: "read-only"`; esse modo usa `agy --mode plan`, verifica alterações ao final e não permite integração. Para implementação, use `mode: "write"` (padrão). Chame `antigravity_run` com uma instrução concreta e critério verificável. Por padrão, a cópia inclui arquivos rastreados e não rastreados que não estejam em `.gitignore` ou `.git/info/exclude`, mesmo quando um arquivo ignorado é rastreado. Selecione `includePaths` quando somente alguns arquivos ou pastas forem necessários; a seleção não pode incluir arquivos ignorados. Se receber `COPY_LIMIT_EXCEEDED`, reduza a seleção com `includePaths`. Para `CHANGE_LIMIT_EXCEEDED`, revise o tamanho da tarefa com o usuário; não tente contornar o limite. Os padrões são 10.000 arquivos/256 MiB copiados e 100 arquivos alterados. O bridge exige `agy --sandbox` e trabalha sempre na cópia.
3. Guarde o `taskId`. Chame `antigravity_events` com `after: 0` e continue com o `nextCursor` retornado; consulte `antigravity_result` até `ready: true`. Os eventos informam atividade observável, não raciocínio privado. Se `truncated` for verdadeiro, informe a perda de eventos antigos.
4. Após `completed`, chame `antigravity_preview`, apresente `summary` e `fileSummaries` (A/M/D, linhas adicionadas/removidas e binários), revise o patch inteiro e execute os testes pertinentes na cópia. Registre os comandos realmente executados com `antigravity_record_test`, usando o hash atual e a saída sem segredos. Esses registros são relatos do cliente, não verificação independente do bridge. Apresente falhas e registros `stale: true`; não os use como evidência válida do patch atual. Um resultado `SUCCESS` do CLI não substitui essa verificação. Chame `antigravity_integrate` com o `taskId` e o `sha256` da prévia para solicitar a confirmação final pela interface MCP. O servidor exige `form elicitation` e uma resposta do cliente com `accept` e `confirm: true`; hash ou argumentos como `approved` não autorizam a operação. Se `integrationApproval.available` for falso, informe que esse cliente não permite integração pelo bridge. Não contorne a confirmação aplicando o patch por outro caminho sem uma autorização específica do usuário para esse caminho. Relate falhas e limitações com precisão.

## Evidência antes da integração

- Defina `acceptanceCriteria` em `antigravity_run` antes da implementação, cobrindo cada requisito explícito. Use verificações de arquivo quando aplicáveis e critérios de revisão para comportamentos que exigem interpretação. A retomada mantém os critérios originais.
- Leia os artefatos reais e compare cada requisito com o resultado. Para cada critério, envie a `antigravity_verify` uma revisão com arquivo, linha, citação literal e explicação. Não invente citações, saídas ou execução de comandos. Classifique falta de prova como `unverified` e defeitos como `failed`.
- `completed` e `SUCCESS` indicam o término da execução. Só relate um requisito como atendido com evidência pertinente. Confira também testes, efeitos observáveis, requisitos não cobertos e limitações; uma busca textual ou citação correta não comprova todo o comportamento.
- Sem critérios, revisão completa ou verificação atual, o servidor bloqueia a integração. Se o patch ou a evidência mudar, revise e verifique novamente. A aprovação humana continua necessária.

## Continuação e controle

- Use o `sessionId` de uma tarefa concluída com `antigravity_resume` para continuar na mesma cópia. `antigravity_sessions` lista sessões persistidas e `antigravity_tasks` recupera IDs de tarefas após reinício. Execuções interrompidas não são repetidas: examine `SERVER_RESTARTED` e a cópia antes de iniciar outro trabalho. Se houver `ORPHAN_PROCESS_RUNNING`, aguarde o processo registrado terminar; não tente aplicar ou descartar sua cópia.
- Quando o usuário pedir cancelamento, chame `antigravity_cancel` com o `taskId` e confirme o status. O cancelamento encerra o processo local; alterações parciais podem permanecer.
- Quando o usuário quiser descartar o trabalho, chame `antigravity_discard` depois que a tarefa terminar. A remoção alcança todas as tarefas retomadas na mesma cópia. Use `antigravity_cleanup` para remover cópias expiradas; a retenção padrão é de 7 dias.
- Depois de falha ou timeout, examine eventos e a cópia antes de repetir a tarefa. Não faça nova execução automaticamente se ela puder repetir efeitos ou consumir quota.

O `--sandbox` restringe comandos de terminal do CLI, mas não garante isolamento completo do sistema de arquivos no Windows. Não delegue acesso a arquivos sensíveis apenas com base nessa opção; use a lista de arquivos e revise o conteúdo efetivamente copiado.
