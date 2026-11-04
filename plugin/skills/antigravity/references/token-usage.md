# Token usage

Reference for the [core skill](../SKILL.md). Open it when reporting usage across resumed or failed tasks.

## Informar tokens usados

- Ao concluir, relatar falha ou encerrar uma delegação, informe os tokens do Gemini/agy usando `task.tokenUsage` ou `antigravity_usage`. Mostre `totalTokens` e, quando disponíveis, entrada, saída, raciocínio e cache. Identifique os dados como uso informado pelo CLI.
- Para uma sequência com retomadas, consulte o consolidado da sessão; não some `result.usage` cumulativo de cada resposta. O consumo por tarefa já usa a diferença dos contadores anteriores. Preserve a distinção entre tarefas retidas e o acumulado observado da sessão.
- Se houver `null`, `available: false`, `partial: true` ou avisos, explique a limitação. Não estime contadores ausentes, não atribua zero a uma execução sem dados e não confunda tokens com preço ou quota da conta.
- Informe também consumo de tarefas falhas quando disponível. Não afirme execução de testes somente porque houve consumo do modelo; o recibo do terminal continua necessário.
