# Histórico de versões

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
