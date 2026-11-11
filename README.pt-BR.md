![Logo animada do Black Gravity](assets/brand/logo.svg)

🌍 [English](README.md) / Português

[![Licença MIT](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FZythenth%2Fblack-gravity%2Fmain%2Fpackage.json&query=%24.license&label=License)](LICENSE) [![Versão mínima do Node.js](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FZythenth%2Fblack-gravity%2Fmain%2Fpackage.json&query=%24.engines.node&label=Node.js)](package.json) [![CI](https://github.com/Zythenth/black-gravity/actions/workflows/ci.yml/badge.svg)](https://github.com/Zythenth/black-gravity/actions/workflows/ci.yml)

# Black Gravity

Black Gravity é um servidor MCP local que delega tarefas de programação ao Google Antigravity pelo CLI oficial `agy`. Ele oferece ao Codex ferramentas para iniciar tarefas em cópias isoladas do projeto, acompanhar o andamento e revisar os resultados antes de aplicar mudanças. Black Gravity é independente do Google e da OpenAI.

## Instalação

### Instalar o plugin do Codex

Execute os comandos com o CLI do Codex e abra uma nova conversa.

```powershell
codex plugin marketplace add Zythenth/black-gravity
codex plugin add black-gravity@black-gravity
```

### Compilar a partir do código-fonte

```powershell
git clone https://github.com/Zythenth/black-gravity.git
cd black-gravity
npm.cmd ci
npm.cmd run build:plugin
```

Os exemplos em PowerShell usam `npm.cmd`. Em outras plataformas, use `npm`. Consulte [instalação e migração](documentation/setup.md) para registrar apenas o servidor MCP, usar tarballs locais ou atualizar. O pacote anterior `antigravity-mcp-bridge`, publicado no npm, usa ferramentas `antigravity_*`. Consulte [as versões disponíveis](documentation/setup.md#available-versions) para ver os nomes do Black Gravity. Para Windows LPAC, consulte [a configuração do Node portátil](documentation/windows-runtime.md#portable-node-runtime).

## Primeiro uso

Em uma nova conversa no Codex, experimente:

> Use `$black-gravity` para inspecionar os arquivos selecionados e relatar os achados em modo somente leitura.

A skill orienta a escolha do modelo, o acompanhamento e a revisão. Para usar somente o servidor MCP, chame `black_gravity_health` para conferir o CLI, o perfil de ferramentas e o modo de aprovação. Depois, chame `black_gravity_list_models` antes de escolher um modelo. Consulte [gerenciamento de tarefas](documentation/task-management.md) e [revisão e integração](documentation/review-and-integration.md).

## Requisitos

- Node.js 24 ou mais recente, com npm. O Windows LPAC tem [requisitos adicionais de runtime](documentation/windows-runtime.md).
- Git 2.32 ou mais recente em uma entrada absoluta do `PATH`.
- [CLI oficial do Antigravity](https://www.antigravity.google/docs/cli/install/) no `PATH` ou configurado com `AGY_PATH` absoluto, com a autenticação concluída no próprio `agy`.

## Permissões do host

`black-gravity permissions` imprime regras para revisar e incorporar à configuração do host. Na cópia do código-fonte:

```powershell
node plugin/server.mjs permissions --host claude-code
node plugin/server.mjs permissions --host codex
```

A aprovação do host e o `BRIDGE_APPROVAL_MODE` do bridge se aplicam de forma independente. O modo padrão `auto` aplica patches verificados sem formulário de confirmação do bridge. Defina `BRIDGE_APPROVAL_MODE=ask` para exigir esse formulário. Consulte [permissões do host](documentation/configuration-and-security.md#host-permissions) para ver as predefinições, onde configurar as regras e o limite da verificação das aprovações por ferramenta no Codex.

## Links

- [Instalação e migração](documentation/setup.md)
- [Node portátil no Windows](documentation/windows-runtime.md)
- [Gerenciamento de tarefas](documentation/task-management.md)
- [Grupos de tarefas, workflows e controles por especialista](documentation/groups.md)
- [Perfis e catálogo de ferramentas](documentation/tools.md)
- [Revisão, integração e testes](documentation/review-and-integration.md)
- [Configuração, isolamento e segurança](documentation/configuration-and-security.md)
- [Histórico de versões](CHANGELOG.md) · [Licença MIT](LICENSE) · [Política de segurança](SECURITY.md) · [Política de privacidade](PRIVACY.md) · [Avisos de dependências](THIRD_PARTY_NOTICES.md)
