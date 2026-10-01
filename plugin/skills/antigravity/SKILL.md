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

1. Identifique o diretório absoluto do projeto. Antes de formular a tarefa, leia as instruções e arquivos relevantes do projeto e observe mudanças Git existentes. Não inclua segredos nem documentos privados no prompt enviado ao Antigravity sem autorização do usuário.
2. Chame `antigravity_run` com uma instrução concreta, escopo de arquivos e critério verificável. Use `isolateWorktree: true` quando Codex e Antigravity precisarem editar o mesmo repositório em paralelo e a árvore Git estiver limpa.
3. Guarde o `taskId`. Chame `antigravity_events` com `after: 0` e continue com o `nextCursor` retornado; consulte `antigravity_result` até `ready: true`. Os eventos informam atividade observável, não raciocínio privado. Se `truncated` for verdadeiro, informe a perda de eventos antigos.
4. Após `completed`, revise `gitBefore`/`gitAfter` e os arquivos alterados; execute os testes pertinentes do projeto. Um resultado `SUCCESS` do CLI não substitui essa verificação. Relate falhas e limitações com precisão.

## Continuação e controle

- Use o `sessionId` devolvido pela tarefa com `antigravity_resume` para continuar a conversa. `antigravity_sessions` lista apenas sessões vistas pela instância atual do bridge.
- Quando o usuário pedir cancelamento, chame `antigravity_cancel` com o `taskId` e confirme o status. O cancelamento encerra o processo local; alterações parciais podem permanecer.
- Depois de falha ou timeout, examine eventos e estado Git antes de repetir a tarefa. Não faça nova execução automaticamente se ela puder repetir efeitos ou consumir quota.
