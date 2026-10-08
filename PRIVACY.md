# Privacidade e armazenamento

Esta política descreve os dados tratados pelo Antigravity MCP Bridge. O bridge é um programa local independente; não opera um serviço de coleta de dados.

## Dados usados

O cliente MCP fornece prompt, diretório de trabalho e opções da tarefa. O bridge seleciona arquivos conforme as regras de ignore do Git e `includePaths`, cria uma cópia temporária e entrega o prompt ao CLI oficial `agy`. O CLI pode ler a cópia e comunicar seu conteúdo aos serviços do Google conforme o modelo, a conta e as configurações escolhidas. Consulte a [política de privacidade do Google](https://policies.google.com/privacy) e os termos aplicáveis à sua conta Antigravity.

O bridge não lê diretamente cookies, tokens nem arquivos de autenticação. A autenticação e a comunicação com o Google pertencem ao CLI. O bridge não adiciona telemetria, analytics ou transmissão a um serviço próprio.

## Dados locais e retenção

- A cópia e o baseline Git ficam no diretório temporário do sistema. São removidos pelo descarte, pela expulsão do último registro retido ou após 7 dias da última tarefa finalizada, conforme `COPY_RETENTION_HOURS`. A limpeza ocorre na inicialização e a cada minuto enquanto o servidor está ativo. Cópias em uso são preservadas. O sistema operacional também pode apagar arquivos temporários.
- `~/.antigravity-mcp-bridge`, ou `BRIDGE_STATE_DIRECTORY`, armazena prompts, critérios, opções, IDs de tarefa/sessão, caminhos, hashes, status, resultados, eventos disponíveis, citações de revisão e testes relatados pelo cliente ou capturados do executor. Para testes Windows, inclui a política global normalizada, seu hash, a seleção efetiva e dados de recuperação de limpeza. O padrão retém até 100 tarefas. Esse estado não tem criptografia própria; proteja-o com as permissões do sistema operacional e mantenha-o fora de pastas compartilhadas e repositórios.
- O buffer de eventos é limitado. Eventos e saídas podem ser truncados. São mantidos até 20 registros de testes por tarefa, com saída limitada pela seleção de cada teste; o padrão é 4.000 caracteres.
- Logs operacionais em `stderr` incluem horário, ID de tarefa, status, PID e códigos de erro. O bridge não acrescenta o prompt nesses logs. O cliente MCP e o CLI podem manter seus próprios históricos e logs.
- Testes no caminho legado criam um runner temporário na cópia e um snapshot Git temporário sem histórico do original. No Windows, o bridge também cria temporariamente o controlador, runtime preparado e perfil AppContainer/LPAC. Esses recursos são removidos ao final ou reconciliados na recuperação após interrupção. A seleção de permissões e os caminhos concedidos não são enviados ao `agy`; uma correção opcional pelo `agy` recebe somente o contexto necessário da tarefa. Saídas e evidências aparecem nos registros locais.
- A preparação explícita do runtime portátil Windows consulta o GitHub Release para baixar seus arquivos declarados. Essa etapa não envia arquivos do projeto, prompts nem dados de tarefas ao GitHub. Ela não altera o fluxo normal do `agy`, que continua sujeito à conta, ao modelo e às políticas do Google descritos acima.
- O cache privado do runtime é mantido para reutilização depois de reinicializações normais. A persistência depois de reinicialização física ainda não foi verificada.

## Remoção

`antigravity_discard` remove a cópia e o baseline, incluindo tarefas retomadas que compartilham esses diretórios. Ele preserva os registros locais de tarefa, resultados e eventos. A remoção local não apaga históricos mantidos pelo Google, pelo CLI ou pelo cliente MCP.

Para apagar registros persistidos, encerre os servidores do bridge que usam o diretório de estado e remova os arquivos JSON das tarefas desejadas, ou todo o diretório de estado. Isso perde os IDs e a possibilidade de recuperar essas sessões pelo bridge. Descarte as cópias antes de remover os registros para evitar deixar diretórios temporários sem referência.

Antes de enviar uma tarefa, confira `antigravity_list_project_files`, selecione somente os caminhos necessários e exclua documentos confidenciais e credenciais pelas regras locais do Git. Não inclua segredos no prompt, em saídas de testes registradas ou em relatos públicos de problemas.
