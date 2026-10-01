# Política de segurança

Correções de segurança são destinadas à versão mais recente publicada do plugin. Atualize o plugin e o CLI oficial antes de reproduzir um problema.

## Relatar uma vulnerabilidade

Use [Report a vulnerability](https://github.com/Zythenth/antigravity-mcp-bridge/security/advisories/new) para enviar um relato privado ao mantenedor. O canal privado de vulnerabilidades está habilitado no repositório. Inclua a versão do bridge e do `agy`, sistema operacional, passos mínimos, comportamento esperado e impacto observado. Remova tokens, dados pessoais e conteúdo sensível dos exemplos. Não publique detalhes de exploração em issues públicas enquanto o problema estiver em análise.

## Controles e limites

- Execução por stdio local, sem servidor HTTP ou porta de rede aberta pelo bridge.
- Subprocessos sem shell e exigência de `agy --sandbox`.
- Cópia filtrada pelas regras de ignore do Git, seleção por caminhos e recusa de links simbólicos.
- Limites configuráveis de tempo, fila, retenção, arquivos, bytes e alterações.
- Modo de consulta com `agy --mode plan` e verificação posterior da cópia.
- Revisão por patch/hash e recusa de integração quando os arquivos afetados na origem mudaram.
- Confirmação de integração por formulário MCP, com recusa em clientes sem suporte e nova verificação do patch após confirmação.
- Persistência local com escrita atômica e locks para proteger operações na mesma cópia.

O sandbox do CLI restringe comandos de terminal; ele não oferece garantia de isolamento completo do sistema de arquivos no Windows. `plan` também não é uma barreira física de escrita. O bridge e o CLI executam com as permissões do usuário local. Para projetos não confiáveis ou documentos sensíveis, use uma conta ou ambiente separado e confira a seleção antes de delegar.

A confirmação depende de um cliente MCP confiável que apresente o formulário ao usuário e envie sua resposta. O bridge exige essa troca no protocolo e não aceita aprovação como argumento da ferramenta; ele não autentica uma pessoa nominal nem protege contra um cliente malicioso ou programas com as mesmas permissões locais.

Mantenha o diretório de estado privado e fora de projetos versionados. Ele contém prompts, resultados e eventos sem criptografia própria. Regras de ignore não protegem segredos enviados diretamente no prompt. Testes registrados pelo cliente são relatos, não execução verificada pelo bridge.
