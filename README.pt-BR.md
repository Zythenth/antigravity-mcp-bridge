![Logo animada do Black Gravity](assets/brand/logo.svg)

🌍 [English](README.md) / Português

[![Licença MIT](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FZythenth%2Fblack-gravity%2Fmain%2Fpackage.json&query=%24.license&label=License)](LICENSE) [![Versão mínima do Node.js](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FZythenth%2Fblack-gravity%2Fmain%2Fpackage.json&query=%24.engines.node&label=Node.js)](package.json) [![CI](https://github.com/Zythenth/black-gravity/actions/workflows/ci.yml/badge.svg)](https://github.com/Zythenth/black-gravity/actions/workflows/ci.yml)

# Black Gravity

Black Gravity é um servidor MCP local que delega tarefas de programação ao Google Antigravity pelo CLI oficial `agy`. Ele oferece ao Codex ferramentas para iniciar tarefas em cópias isoladas do projeto, acompanhar o andamento e revisar os resultados antes de aplicar mudanças. Black Gravity é independente do Google e da OpenAI.

## Instalação

Use um só método de registro por harness para não duplicar ferramentas. Os comandos rodam na raiz do repositório. Um harness é **Suportado** quando o próprio comando dele registrou o build deste repositório e o listou, sem chamar modelo. O que não foi executado assim fica como **Não verificado**.

| Harness | Estado | O que foi conferido |
|---|---|---|
| Plugin do Codex | Suportado | Listado por `codex plugin list` e `codex mcp list` (Codex CLI 0.163.0, Windows) |
| Codex, somente MCP | Suportado | Listado por `codex mcp list` (mesma versão) |
| Claude Code, somente MCP | Suportado | Exibido como Connected por `claude mcp list` (Claude Code 2.1.319, Windows) |
| Plugin do Claude Code com skill | Planejado | Ainda não disponível |
| Claude Desktop | Não verificado | A configuração abaixo não foi executada; não há comando de listagem nem configuração isolada |
| agy | Não verificado | `agy mcp list` existe, mas o agy não documenta como isolar a configuração |
| Outros clientes MCP (stdio) | Parcial | O servidor respondeu `initialize` e `tools/list` com 50 ferramentas; nenhum outro cliente foi testado |
| Comandos para Linux e macOS | Não verificado | Sem máquina de teste |

### Plugin do Codex

**Suportado.** Execute os comandos com o CLI do Codex e abra uma nova conversa.

```powershell
codex plugin marketplace add Zythenth/black-gravity
codex plugin add black-gravity@black-gravity
```

### Codex, somente MCP

**Suportado.**

```powershell
$server = (Resolve-Path .\plugin\server.mjs).Path
codex mcp add black-gravity -- node $server
codex mcp list
```

### Claude Code, somente MCP

**Suportado.**

```powershell
$server = (Resolve-Path .\plugin\server.mjs).Path
claude mcp add --scope user black-gravity -- node $server
claude mcp list
```

### Plugin do Claude Code com skill

**Planejado.** Ainda não há plugin para o Claude Code. Use o registro somente MCP acima.

### Claude Desktop

**Não verificado.** Adicione o servidor a `claude_desktop_config.json` com o caminho absoluto de `plugin/server.mjs` e reinicie o aplicativo.

```json
{
  "mcpServers": {
    "black-gravity": {
      "command": "node",
      "args": ["<absolute path to plugin/server.mjs>"]
    }
  }
}
```

### agy

**Não verificado.**

```powershell
$server = (Resolve-Path .\plugin\server.mjs).Path
agy mcp add black-gravity -- node $server
agy mcp list
```

### Outros clientes MCP

**Parcial.** Só o lado do servidor foi conferido. Inicie `node <absolute path to plugin/server.mjs>` como servidor stdio. O processo reserva o stdout para o JSON-RPC.

### Linux e macOS

**Não verificado.** Estes comandos são os mesmos registros, sem a sintaxe do PowerShell.

```bash
server="$PWD/plugin/server.mjs"
codex mcp add black-gravity -- node "$server"
claude mcp add --scope user black-gravity -- node "$server"
agy mcp add black-gravity -- node "$server"
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
