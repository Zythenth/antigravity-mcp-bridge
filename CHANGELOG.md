# Histórico de versões

## Em desenvolvimento

- Resultados JSON validados, artefatos com SHA-256 e leitura paginada.
- Padrões persistentes por especialista para modelo, esforço, skills, arquivos, resultado e ferramentas.
- Catálogo MCP confiável e ferramentas selecionadas por tarefa, com hooks nativos, recibos vinculados à conversa e controles preservados em retomadas e handoffs.
- Diagnóstico explícito da falta de permissão MCP no modo headless e proteção da configuração auxiliar nos testes Windows LPAC.

## 0.7.1

- Remove o painel MCP Apps e seus recursos de aparência, mantendo entrega compacta, mensagens por sessão, skills selecionadas, concorrência e autorização prévia de integração.
- Normaliza raízes autorizadas com o resolvedor nativo do Windows, incluindo aliases 8.3.

## 0.7.0

- Painel MCP Apps com lista e conversa no estilo do Codex, recursos nativos descobertos localmente, controles de saída técnica e cards de alterações reais.
- Leitura de diffs e Desfazer por arquivo somente na cópia, vinculados ao hash atual e aos limites de perfil e execução.

- Autorização prévia configurável por raiz exata de projeto para dispensar formulários repetidos, preservando critérios, hash, revisão e testes atuais.

- Caixa de mensagens do chamador com recibos idempotentes, despacho sequencial por sessão, recuperação sem repetição de envios incertos e ponteiros de continuação.

- Entrega opcional de mensagens públicas compactas ao chamador, com cursores próprios, atribuição, referências a resultados, perda de histórico explícita e conservação do modo de eventos.

- Pacotes de skills selecionadas fornecidos pelo cliente, preparados na cópia com recursos UTF-8, limites combinados, hashes imutáveis e preservação nas retomadas e transferências.
- Tentativas limitadas para bloqueios transitórios do Windows em gravações atômicas de estado, sem remover o último estado válido como alternativa.

## 0.6.1

- Preservação exata da DACL existente ao conceder e remover permissões temporárias do executor Windows LPAC.
- Recusa de links simbólicos e junctions no componente final do caminho de executáveis Windows.
- Diagnósticos sanitizados de inspeção do cache portátil, com detalhes limitados da execução e sem saída bruta.
- Inspeção do cache portátil sem carregamento automático de módulos do PowerShell, com prazo máximo de 15 segundos.
- Fixture de testes ajustada para instalações do npm sem `npmrc` distribuído.
- Versão do pacote, plugin e servidor MCP atualizada para permitir a instalação em um novo diretório de cache do Codex.

## 0.6.0

- Executor de testes próprio do bridge no Windows, isolado em AppContainer/LPAC e selecionado por padrão; `BRIDGE_TEST_EXECUTOR=agy` mantém o caminho legado explícito e não há alternativa de execução no host.
- Política global de permissões de sandbox com consulta, alteração confirmada por formulário MCP e comparação pelo hash anterior. O agente que chama o MCP seleciona, em cada teste, apenas permissões dentro dos limites autorizados pela pessoa usuária. A configuração não é encaminhada ao `agy`; o Gemini delegado não pode escolhê-la, autorizá-la nem alterá-la.
- Evidências de teste agora distinguem o executor Windows, a seleção de sandbox e o hash da política. Execução local conhecida registra zero tokens de modelo; reparos opcionais pelo `agy` continuam com os contadores observados, inclusive `null` quando ausentes.
- Staging limitado de executáveis Windows e de `npm`/`npm.cmd`, que executa o `node.exe` e `npm-cli.js` verificados. Lotes arbitrários continuam sem suporte.
- Aliases DOS temporários em dois níveis para cópia, runtime e scratch, com três letras livres de `D:` a `Z:`, verificação de identidade e remoção, e recuperação de execução interrompida. Eles são locais ao contexto de logon, sem ACL na raiz do volume, UAC ou mount persistente.
- Limitação conhecida: no Node 24.14.1/libuv 1.51, `child_process.spawnSync` com pipes padrão falha no LPAC e expira com exit code 124; stdio herdado e o ciclo real do npm não demonstram compatibilidade geral. O [PR 5181 do libuv](https://github.com/libuv/libuv/pull/5181/files), presente no [libuv 1.53](https://github.com/libuv/libuv/releases/tag/v1.53.0), foi aplicado ao runtime portátil Node 24.21.0 LPAC1; o Node 24.14.1 do sistema mantém a limitação.
- Runtime Node 24.21.0 LPAC1 para Windows x64 publicado em Release imutável, com libuv base 1.52.1 e somente o PR 5181 aplicado. O descritor fixa URL, tamanho e SHA-256 dos três arquivos instalados: `node.exe`, `LICENSE` e `build.json`. Esse build passou pela regressão LPAC com pipes padrão capturados (1 teste) e pelos testes de isolamento e ciclo de vida (22 testes, sem falhas nem skips). A preparação é explícita.

## 0.5.2

- Restauração de `PATHEXT` ausente no subprocesso Windows para clientes MCP com ambiente reduzido, preservando valores explícitos e as permissões do sandbox.
- Diagnósticos separados para falha de acesso do sandbox, setup administrativo não concluído e bypass negado, com a causa relatada pelo runtime e vínculo ao comando do teste.
- Recusa de recibos que declaram bypass do sandbox, mesmo com exit code zero.
- Regressão com PowerShell real e integração nativa usando o ambiente padrão do SDK, incluindo resolução do executável e acesso externo negado.

## 0.5.1

- Margem de observação das tarefas nos testes ampliada de 5 para 30 segundos para a preparação de cópias em runners Windows, preservando as asserções de concorrência, retenção, aprovação e timeouts de execução.

## 0.5.0

- Perfis de ferramentas por ambiente, com consulta e revisão limitadas a tarefas em leitura.
- Espera limitada com notificações MCP por evento real, cursores e cancelamento separado da execução.
- Transferência estruturada entre papéis com cópias independentes, histórico de relatórios, decisões e critérios, vinculados ao hash dos arquivos.
- Comparação de 2 a 4 modelos em leitura sobre cópias do mesmo contexto, com divergências, falhas, uso e verificação de conteúdo atual.
- Diagnóstico explícito das limitações de respostas de permissão e contagem prévia exata no protocolo headless verificado.
- Papéis personalizados por configuração, com contratos herdados, descoberta MCP e instruções preservadas nas retomadas.

## 0.4.1

- Snapshot Git temporário dentro da cópia do projeto para compatibilidade com o AppContainer Windows, com exclusão do fingerprint e limpeza validada.
- Regressão para diretório temporário ambiente indisponível e validação real de execução, origem intacta e acesso externo negado.
- Orientação da configuração inicial UAC do sandbox Windows e contadores de tokens também nos diagnósticos de falha do teste real.

## 0.4.0

- Critérios de aceitação definidos antes da tarefa, conferência de artefatos e revisão com citações verificadas por arquivo e linha.
- Integração condicionada a verificação atual, com detecção de evidências alteradas e resultados pendentes.
- Execução assíncrona de testes no sandbox nativo do agy, com recibos do terminal, exit code, fingerprints e correções opcionais limitadas.
- Leitura paginada de patches por arquivo e do JSON final, com hashes, cursores Unicode e opções de resposta compacta.
- Normalização nativa dos aliases 8.3 nos testes Windows e declaração explícita da cópia no workspace do CLI.
- Papéis de planejamento e revisão em consulta, contratos JSON e conferência de citações dos achados.
- Consumo de tokens por tarefa, sessão e modelo, com deltas de retomada, baseline persistido e identificação de dados indisponíveis.
- Schemas de saída publicados nas 23 ferramentas, com contratos de sucesso/erro e validação pelo SDK.
- Modelo padrão por ambiente, preferência persistente e Auto explícito por tarefa ou para tarefas futuras.
- Pacote npm com executável para npx, servidor incluído sem dependências de runtime e teste do tarball em Windows/Linux.
- Contrato de health preserva diagnósticos textuais de disponibilidade junto do formato estruturado de erros.

## 0.3.0

- Descarte pelo MCP e limpeza automática de cópias finalizadas, com retenção padrão de 7 dias.
- Modo de consulta com `agy --mode plan`, verificação de alterações e bloqueio de integração.
- Recuperação local de tarefas, sessões, eventos e cópias após reinício, sem repetição automática de execuções interrompidas.
- Limites padrão de 10.000 arquivos/256 MiB copiados e 100 arquivos alterados.
- Estatísticas de linhas e arquivos na prévia, identificação de binários e testes relatados vinculados ao hash.
- Licença MIT, políticas de segurança e privacidade e avisos das dependências distribuídas.
- Integração condicionada a confirmação via formulário MCP, vinculada ao hash revisado e conferida novamente antes da aplicação.

## 0.2.1

- Normalização da raiz Git antes da comparação de caminhos no Windows.

## 0.2.0

- Cópias temporárias filtradas pelas regras de ignore do Git e seleção por `includePaths`.
- Sandbox obrigatório, prévia do patch e integração com validação do hash e da origem.

## 0.1.0

- Servidor MCP stdio e plugin com skill para executar tarefas pelo CLI oficial.
- Descoberta de modelos, eventos, resultados, retomada e cancelamento de tarefas.
