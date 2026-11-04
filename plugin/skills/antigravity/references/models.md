# Model preference and comparison

Reference for the [core skill](../SKILL.md). Open it when checking or saving the default model, or asking several models for a second opinion.

## Model preference

- Prefira `model` em `antigravity_run` para seleção por tarefa. `antigravity_set_model` persiste o padrão no estado privado para tarefas futuras, inclusive após reinício. `model: null` persiste Auto. A ordem é escolha da tarefa, preferência salva, `BRIDGE_DEFAULT_MODEL` e padrão do agy. Consulte `antigravity_get_model` antes de informar a preferência atual.

## Comparação de modelos

- Quando o pedido incluir segunda opinião de vários modelos, escolha 2 a 4 IDs reais de `antigravity_list_models`. Não inicie uma comparação extra sem motivo no escopo: cada parecer consome quota. Obtenha `antigravity_context` e chame `antigravity_compare` com o hash atual, um escopo concreto e os modelos.
- Track all comparison tasks at once with the `waitCommand` returned by `antigravity_compare` (following `recommendedMode`: in the background for `"background"`, in the foreground for `"foreground"`), or use `antigravity_wait_many` / `antigravity_wait` when no terminal is available. When it ends, query `antigravity_comparison` and expose `startErrors`, missing models, failures, `unverified`, tokens and stale content. `ready` only means the retained tasks ended; `complete` requires every opinion available with its matching copy. If `contextStale` is set or `contextMatches` is not true, inspect again before recommending changes.
- Leia cada parecer e confira achados contra arquivos e requisitos. Sintetize o que coincide, o que diverge e qual evidência resolve a divergência; não decida por maioria nem transforme ausência de achados em aprovação. O agrupamento `identical` é literal, `different` reúne interpretações do mesmo trecho e `not-reported-by-all` inclui trechos não relatados por todos. Preserve as limitações e a autoria funcional de cada parecer pelo ID do modelo.
- Para integrar, volte à tarefa de implementação, confira o patch e os critérios e solicite a aprovação prevista. Comparação não modifica o original nem libera integração.
