# Tool profile and approval modes

Reference for the [core skill](../SKILL.md). Open it when changing `BRIDGE_APPROVAL_MODE` or `BRIDGE_TOOL_PROFILE`, on a server without `approvalMode`, or with preauthorized roots.

## Perfil e modos de aprovação disponíveis

Consulte `antigravity_health`:
- **Perfil de ferramentas**: `antigravity_health.toolProfile`. `query` e `review` executam somente em leitura; não peça ferramentas ausentes nem contorne o perfil. `full` e `implementation` oferecem o fluxo completo. Para alterar, configure `BRIDGE_TOOL_PROFILE` no ambiente privado do servidor e reinicie a conexão MCP.
- **Modo de aprovação**: a skill DEVE consultar `antigravity_health` e seguir o modo informado em `health.approvalMode` (e `health.integrationApproval.mode`).
  - **Identificação de versão do servidor**: se o campo `approvalMode` estiver **ausente** na resposta de `antigravity_health`, isso indica que o servidor MCP é uma **versão antiga (legada)** do bridge. **NUNCA confunda variável de ambiente unset com versão legada do servidor**: em servidores modernos, quando `BRIDGE_APPROVAL_MODE` não estiver definida (unset), o servidor opera no modo padrão `approvalMode: "auto"`.
  - **Modo `auto` (padrão se unset)**: dispensa formulários interativos de confirmação humana para `antigravity_integrate` e para atualizações validadas de `antigravity_set_sandbox_policy`. **Não imponha orientações que exijam extra autorização manual ao chamador em `auto`**; o chamador pode propor concessões estreitas e verificadas necessárias à tarefa autorizada nos testes. Delegados via `agy` (Gemini) NÃO escolhem, não autorizam nem proporcionam permissões.
  - **Modo `ask` (opt-in estrito)**: exige SEMPRE confirmação humana via formulário MCP (**MCP form elicitation**), mesmo para raízes anteriormente configuradas ou lembradas legadas; o checkbox de memorização foi removido do formulário.
  - **Persistência e reinício**: configurações de `BRIDGE_APPROVAL_MODE` devem ser registradas no ambiente privado de inicialização do servidor MCP (alertando que atribuições no PowerShell como `$env:BRIDGE_APPROVAL_MODE = ...` afetam somente o shell atual em execução); reinicie a conexão MCP após qualquer alteração.
  - **Fronteiras e limites**: nenhum modo permite fallback automático ao host nem altera permissões do Codex ou do `agy`. A integração é realizada exclusivamente via MCP; a autorização NUNCA substitui testes e revisão de código. Não afrouxe hashes SHA-256, critérios, revisão, testes observados atuais, source-lock, CAS e proteção de caminhos.

## Modos de aprovação e integração

O servidor MCP opera segundo `health.approvalMode` (controlado por `BRIDGE_APPROVAL_MODE`, padrão `auto` quando não configurado/unset; aceita estritamente `auto` ou `ask`):

- **Modo automático (`auto`, padrão)**: `antigravity_integrate` autoriza e aplica patches verificados automaticamente, dispensando formulários interativos MCP de confirmação humana. Não imponha confirmações manuais adicionais ao chamador em `auto`. O chamador pode propor concessões estreitas e verificadas necessárias à tarefa autorizada nos testes. Agentes delegados via `agy` (Gemini) NÃO escolhem, autorizam nem proporcionam permissões. Controles de segurança não são afrouxados: hashes SHA-256, critérios em `antigravity_verify`, revisão fundamentada nos arquivos reais, testes observados atuais sem falhas, source-lock, CAS e proteção estrita de caminhos (path-protection) continuam rigorosamente obrigatórios.
- **Modo de confirmação estrita (`ask`)**: opt-in estrito que exige SEMPRE confirmação humana interativa via formulário MCP (**MCP form elicitation**) para cada integração de patch (`antigravity_integrate`) e para atualizações de política de sandbox (`antigravity_set_sandbox_policy`). Não há bypass para raízes previamente configuradas no ambiente (`BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS`) ou raízes lembradas legadas (`integration-approvals.json`); a confirmação é sempre obrigatória. O checkbox de memorização ("Não pedir novamente neste projeto") foi removido do formulário.

Para configurar o modo de forma persistente, defina `BRIDGE_APPROVAL_MODE` no ambiente privado de inicialização do servidor MCP (lembrando que atribuições no PowerShell afetam apenas a sessão atual do shell) e reinicie a conexão MCP. Nenhum modo realiza fallback automático ao host nem altera permissões do Codex ou do `agy`. A integração é realizada exclusivamente via MCP; a autorização nunca substitui critérios, testes e revisão técnica.
