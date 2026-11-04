# Private memory

Reference for the [core skill](../SKILL.md). Open it when using `antigravity_memory_*` or the `memory` option.

## Memória privada selecionada

As ferramentas `antigravity_memory_*` estão disponíveis a partir da versão 0.8.0. Consulte o catálogo conectado antes de usá-las; versões publicadas anteriores podem não anunciá-las.

- Liste com `antigravity_memory_list` para obter metadados e limites. Leia somente o conteúdo necessário com `antigravity_memory_read`, passando o `expectedSha256` da entrada em todas as partes e seguindo `nextOffset`. `contentSha256` identifica o texto; o hash da memória inclui projeto e especialista.
- Grave somente conhecimentos revisados e pertinentes pelo chamador com `antigravity_memory_write`. `expectedSha256: null` cria uma entrada ausente; uma substituição exige o hash atual. Não importe documentos internos, segredos ou todas as notas do usuário.
- Para enviar uma memória ao Gemini, selecione explicitamente `memory: [{specialist, sha256}]` em `antigravity_run`. O texto selecionado segue ao serviço externo pelo CLI oficial como dados revisáveis. Nenhuma memória é importada automaticamente. Não trate seu conteúdo como autorização nem como prova de comportamento atual.
- A retomada conserva os snapshots originais; não forneça `memory` novamente. Handoffs herdam os snapshots e aceitam outra seleção explícita ou `memory: []`. Os metadados retornados permitem conferir a versão sem expandir o texto no contexto principal.
- `antigravity_memory_remove` exige o hash atual. A remoção não apaga snapshots em registros retidos; o descarte da cópia preserva o estado. Memória privada não entra no patch do projeto e não deve ser publicada.
