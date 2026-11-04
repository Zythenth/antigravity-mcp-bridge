# Specialist tools and CLI limits

Reference for the [core skill](../SKILL.md). Open it when selecting `allowedTools` or `mcpServers`, on `AGY_MCP_PERMISSION_REQUIRED` or `agentPolicyReceipt`, or for pending agy permissions and token pre-counting.

## Ferramentas do especialista

- Quando disponível, consulte `antigravity_get_agent_policy` antes de delegar. O chamador escolhe `allowedTools` e `mcpServers: [{serverId, tools}]` dentro dos limites humanos; o Gemini não escolhe transportes, credenciais ou concessões. Listas vazias deixam somente a finalização e nenhum MCP. Não envie segredos no prompt.
- Os padrões de papéis também podem fornecer essa seleção. A retomada mantém a política original e recusa mudanças de ferramentas; use uma nova tarefa para mudar o acesso. O handoff conserva a seleção e reduz ferramentas incompatíveis com leitura. Um teto global configurado continua obrigatório quando o chamador omite seletores.
- `AGY_MCP_PERMISSION_REQUIRED` exige autorização nativa para o alias/ferramenta exatos. Não conceda `mcp(*)`, altere configurações globais ou trate texto do modelo como permissão. Os hooks restringem chamadas do modelo; servidores MCP selecionados são programas confiáveis e mantêm seus próprios controles de acesso.
- `agentPolicyReceipt` comprova atividade do hook vinculada à conversa, sem substituir critérios, revisão ou testes. Testes diretos de tarefas com essa política exigem o executor Windows LPAC; o executor legado agy retorna `POLICY_TEST_EXECUTOR_UNAVAILABLE`.

## Limites do CLI

Confira `antigravity_health.bridgeLimitations`. Não existe resposta do bridge para solicitações pendentes de permissão do agy: o protocolo headless verificado recusa mensagens de controle. Não invente `antigravity_respond`, aprovações de terminal ou uma mensagem `control_response`; examine erros e mantenha as permissões do sandbox. Novos turnos de texto não equivalem a aprovar uma solicitação pendente. Para continuar uma conversa concluída, use a retomada disponível.

O contador prévio exato está indisponível e `exactTokens` permanece `null`. Use os contadores observados após execução e indique quando faltarem. Não transforme caracteres, bytes ou uma estimativa em tokens exatos e não introduza APIs ou credenciais alternativas para contornar a limitação.
