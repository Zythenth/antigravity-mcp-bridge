# Política de segurança

Correções de segurança são destinadas à versão mais recente publicada do plugin. Atualize o plugin e o CLI oficial antes de reproduzir um problema.

## Relatar uma vulnerabilidade

Use [Report a vulnerability](https://github.com/Zythenth/antigravity-mcp-bridge/security/advisories/new) para enviar um relato privado ao mantenedor. O canal privado de vulnerabilidades está habilitado no repositório. Inclua a versão do bridge e do `agy`, sistema operacional, passos mínimos, comportamento esperado e impacto observado. Remova tokens, dados pessoais e conteúdo sensível dos exemplos. Não publique detalhes de exploração em issues públicas enquanto o problema estiver em análise.

## Controles e limites

- Execução por stdio local, sem servidor HTTP ou porta de rede aberta pelo bridge.
- Subprocessos sem shell. Tarefas delegadas exigem `agy --sandbox`; testes usam AppContainer/LPAC próprio do bridge no Windows por padrão e o sandbox oficial do `agy` nos demais sistemas.
- Cópia filtrada pelas regras de ignore do Git, seleção por caminhos e recusa de links simbólicos.
- Limites configuráveis de tempo, fila, retenção, arquivos, bytes e alterações.
- Modo de consulta com `agy --mode plan` e verificação posterior da cópia.
- Revisão por patch/hash e recusa de integração quando os arquivos afetados na origem mudaram.
- Confirmação de integração por formulário MCP, com recusa em clientes sem suporte e nova verificação do patch após confirmação.
- Persistência local com escrita atômica e locks para proteger operações na mesma cópia.
- Critérios definidos antes da tarefa, revisão com citações conferidas e verificação obrigatória antes/depois da aprovação.
- Testes com comando exato, saída limitada, exit code e fingerprints antes/depois. No Windows, o executor usa um perfil LPAC novo e concessões ACL para o SID exclusivo da execução; fora dele, o caminho legado confere o recibo do `agy`. Não há execução direta no host como alternativa.

Nos testes Windows, a política global limita raízes de leitura/escrita, rede, processos filhos e saída. A pessoa usuária autoriza esses limites por formulário MCP com comparação do hash anterior; o agente que chama o MCP, seja o Codex ou outro cliente, escolhe subconjuntos por teste. O Gemini delegado não recebe, escolhe, autoriza nem altera essa configuração. Caminhos de origem, estado do bridge, credenciais, armazenamento, links, aliases e temporários controlados não podem receber concessões extras.

`network: true` habilita apenas Internet cliente e LAN privada bidirecional. Não habilita capacidades arbitrárias, exceção de localhost ou mudança de firewall. Atualizar a política alcança novos testes e testes em fila depois da confirmação; não revoga permissões de processos que já estejam ativos.

Uma ACL é concedida ao SID exclusivo do perfil e removida exatamente na limpeza; se essa limpeza falhar, o bridge bloqueia a execução e não considera o teste verificado. Interrupção abrupta ou perda de energia pode deixar recursos até a recuperação posterior, portanto não há alegação de limpeza instantânea nem de proteção completa do sistema operacional. O executor também usa aliases DOS temporários, em dois níveis, para seus diretórios de cópia, runtime e scratch: requer três letras livres de `D:` a `Z:`, confere identidade e remoção, e os nomes só ficam visíveis no logon atual. Eles não dão acesso à raiz do volume, não são mounts persistentes e não exigem UAC. `plan` continua sem ser uma barreira física de escrita. Para projetos não confiáveis ou documentos sensíveis, use uma conta ou ambiente separado e confira os limites antes de delegar.

Há uma limitação conhecida de compatibilidade do Node no LPAC: no Node 24.14.1/libuv 1.51, pipes padrão de `child_process.spawnSync` usam endpoints globais recusados pelo LPAC, e a execução expira com exit code 124. Filhos com stdio herdado e o ciclo real do npm terem passado não comprovam esse caso geral. O [PR 5181 do libuv](https://github.com/libuv/libuv/pull/5181/files), incluído no [libuv 1.53](https://github.com/libuv/libuv/releases/tag/v1.53.0), corrige essa classe de pipes. O runtime portátil Node 24.21.0 LPAC1 Windows x64, com libuv base 1.52.1 e somente esse PR aplicado, está publicado em Release imutável e passou pela regressão LPAC com pipes padrão capturados. Essa validação se aplica a esse build fixado. Portanto, Node 24 ou mais recente continua sendo requisito do servidor, sem garantir todos os testes Windows LPAC; timeout é falha, não evidência para integração.

O runtime portátil é preparado apenas por uma chamada explícita de inicialização confiável. Ela aceita somente o descritor embutido, baixa `node.exe`, a `LICENSE` upstream e `build.json` declarados no GitHub Release, confere tamanho e SHA-256 e instala o cache de modo atômico. O metadata registra a fonte, o patch e a proveniência da compilação para manutenção e auditoria. Status, saúde e testes não iniciam download. Cache ausente no modo portátil exige `--prepare-windows-runtime`, sem fallback para o Node do sistema. Cache corrompido, alterado ou inseguro é recusado também pela preparação, sem reparo nem remoção automática. Para preparar novamente, uma pessoa deve inspecionar o caminho e remover manualmente somente o cache do build afetado antes de executar `--prepare-windows-runtime`. O cache pode ser compartilhado somente pelo ambiente confiável `BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY`; URL, hash e caminho não são parâmetros MCP. A substituição vale exclusivamente para a identidade exata do `process.execPath` conhecido e para o `npm` adjacente validado, sem reclassificar executáveis personalizados. A substituição portátil inicial de `process.execPath` e do `npm` adjacente exige Node 24 no host do servidor. O requisito geral Node >=24 permite iniciar o servidor, mas hosts Node 25/26 falham em testes elegíveis com `PORTABLE_NODE_HOST_UNSUPPORTED`.

O cache deve ficar fora dos projetos. O bridge resolve os caminhos reais e recusa sobreposição em ambas as direções entre o projeto e `BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY` antes de consultar modelos, enfileirar a tarefa ou copiar arquivos, mesmo com `includePaths` ou no modo `system`.

A confirmação depende de um cliente MCP confiável que apresente o formulário ao usuário e envie sua resposta. O bridge exige essa troca no protocolo e não aceita aprovação como argumento da ferramenta; ele não autentica uma pessoa nominal nem protege contra um cliente malicioso ou programas com as mesmas permissões locais.

Mantenha o diretório de estado privado e fora de projetos versionados. Ele contém prompts, resultados, eventos, política e informações de recuperação sem criptografia própria. Regras de ignore não protegem segredos enviados diretamente no prompt. Testes registrados pelo cliente são relatos. Saída não confiável do modelo não é recibo. A evidência do executor comprova somente os limites e resultados observados; o bridge não atesta a correção semântica do parecer de revisão.
