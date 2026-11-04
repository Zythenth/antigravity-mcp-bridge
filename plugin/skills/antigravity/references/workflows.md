# Server-run workflows

Reference for the [core skill](../SKILL.md). Open it when using `definition.workflow`, `antigravity_workflow_result` or `definition.budget`.

## Workflows executados pelo servidor

- Confira o catálogo conectado. Configure `definition.workflow` com `finalNode`, `hooks` opcionais por nó e `fileSources` para herdar arquivos de uma dependência direta. O nó final deve alcançar todos os predecessores. Não mescle cópias implicitamente.
- Defina critérios por etapa e formatos JSON com o conteúdo necessário. O servidor guarda intermediários e valida hashes antes de enviá-los como dados às próximas etapas. Limite de contexto: 64 KiB UTF-8; reduza a saída declarada se houver excesso.
- `requireReview` exige revisão atual com citações reais via `antigravity_verify`. `requireTests` exige execução observada em executor compatível; `antigravity_record_test` é relato do cliente e não satisfaz esse hook. Testes diretos exigem etapa de escrita baseada em implementer.
- Examine `WORKFLOW_REVIEW_REQUIRED`/`WORKFLOW_TEST_REQUIRED`; complete a verificação e retome o mesmo grupo com seu hash. Não repita a tarefa concluída nem gere outro ID para contornar checkpoint ou erro de admissão.
- A herança de arquivos conserva seleção e skills; omita esses campos no destino. Se necessário, use `memory: []` para não herdar memória. O servidor confere árvore e patch antes da transferência.
- A espera do workflow omite mensagens intermediárias comuns. Use `antigravity_workflow_result` para a síntese e sua referência; leia detalhes apenas quando necessários. Mudanças ou execuções posteriores com falha invalidam a entrega validada. Conclusão não autoriza integração.
- `definition.budget.maxTotalTokens` limita novas chamadas pelo consumo observado, incluindo continuações. Com teto, aguarde o turno ativo; ausência de medição ou esgotamento pausa admissões. Um turno aceito pode ultrapassar o teto; não prometa preço ou tokens prévios exatos.
