# Installation and migration

## Requirements and CLI discovery

Install Node.js 24 or newer with npm and Git 2.32 or newer on an absolute `PATH` entry. Earlier Git versions fail admission because they lack the required isolation from global Git configuration. On Windows LPAC, see the [portable runtime requirements](windows-runtime.md).

Install the [official Antigravity CLI](https://www.antigravity.google/docs/cli/install/) and complete authentication in `agy`. Put the executable on `PATH` or set `AGY_PATH` to its absolute path. The CLI manages credentials through Windows Credential Manager, macOS Keychain or Linux Secret Service via D-Bus. The bridge preserves profile and configuration directories, security-session and D-Bus settings, proxies, certificates, `GEMINI_API_KEY` and `GOOGLE_GEMINI_BASE_URL`. It also preserves `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT` and `GOOGLE_CLOUD_UNIVERSE_DOMAIN` for ADC and enterprise compatibility. The enterprise flow has yet to be verified end to end. See the [official headless guide](https://www.antigravity.google/docs/cli/headless/).

Discovery runs `--version` and `--help`. Both must exit with code 0 and produce output. The CLI must advertise `stream-json` and `--sandbox`. Discovery reports `AGY_NOT_FOUND`, `AGY_PERMISSION_DENIED`, `AGY_PROBE_FAILED` or `AGY_INCOMPATIBLE` for a missing executable, denied access, a failed probe or an incompatible CLI. The project was validated with `agy` 1.3.2 and `@modelcontextprotocol/sdk` 1.30.1. Future CLI releases may require changes. By default, `black_gravity_test` uses the local AppContainer/LPAC executor on Windows and the official `agy` sandbox elsewhere.

## Available versions

The examples select 0.9.0. Check the [published npm package](https://www.npmjs.com/package/antigravity-mcp-bridge) for the distributed version. The published 0.9.0 uses `antigravity-mcp-bridge` and registers `antigravity_*` tools.

In the current source, the package, executable, plugin, marketplace, skill and server use the Black Gravity name, and the tools use `black_gravity_*`. The default state is `~/.black-gravity`, with a one-time migration from `~/.antigravity-mcp-bridge`. The previous repository address, `Zythenth/antigravity-mcp-bridge`, redirects to `Zythenth/black-gravity`. See the [changelog](../CHANGELOG.md) for version history, migration and recovery details.

## npm package and local tarball

For the published 0.9.0, configure your MCP client:

```json
{
  "mcpServers": {
    "black-gravity": {
      "command": "npx",
      "args": ["--yes", "antigravity-mcp-bridge@0.9.0"]
    }
  }
}
```

Use `npx.cmd` if the Windows client requires the full command name. The executable starts a stdio MCP server and the package contains the built server and its dependency notices. The [requirements](#requirements-and-cli-discovery) still apply.

To test the unpublished build, run `npm run build:plugin` and `npm pack`. Then start the server from the local tarball:

```powershell
npx --yes --package "<tarball-path>" black-gravity
```

When the `black-gravity` npm package is published, `antigravity-mcp-bridge` will be deprecated with this message:

> antigravity-mcp-bridge was renamed to black-gravity. Install black-gravity instead; migration notes: https://github.com/Zythenth/black-gravity/blob/main/CHANGELOG.md

The previous package, installed versions and `~/.antigravity-mcp-bridge` are retained. See [the changelog](../CHANGELOG.md#unreleased) for the planned deprecation command.

## Build from source

PowerShell examples use `npm.cmd`, which also works when the execution policy blocks `npm.ps1`. Use `npm` in other shells.

```powershell
git clone https://github.com/Zythenth/black-gravity.git
cd black-gravity
npm.cmd ci
npm.cmd run build:plugin
npm.cmd test
```

`npm run build:plugin` compiles the server and builds `plugin/server.mjs`. The repository also contains this bundle for plugin installation. `npm start` runs the stdio MCP server and reserves stdout for JSON-RPC.

## Codex plugin

The repository contains the marketplace at `.agents/plugins/marketplace.json` and the plugin under `plugin/`.

```powershell
codex plugin marketplace add Zythenth/black-gravity
codex plugin add black-gravity@black-gravity
```

To update, run `codex plugin marketplace upgrade black-gravity` and `codex plugin add black-gravity@black-gravity`. Open a new conversation after installation or update, because existing conversations retain their tool set. For example, ask: “Use `$black-gravity` to implement this change and review the result.” The skill guides model selection, waiting and review. If the app cannot find `agy`, set `AGY_PATH` in the environment that starts Codex.

Installations with the old name registered the marketplace as `antigravity-mcp-bridge` and the plugin as `antigravity`. An upgrade keeps those names. To migrate:

```powershell
codex plugin remove antigravity@antigravity-mcp-bridge
codex plugin marketplace remove antigravity-mcp-bridge
codex plugin marketplace add Zythenth/black-gravity
codex plugin add black-gravity@black-gravity
```

See the [official plugin guide](https://developers.openai.com/plugins/build/plugins) for the marketplace format and other installation options.

## Standalone MCP server

To use the bridge without the plugin skill, build the project and register the server:

```powershell
$server = (Resolve-Path .\dist\src\index.js).Path
codex mcp add black-gravity -- node $server
```

See the [TOML configuration example](../codex-mcp-example.toml). Choose one registration method to avoid duplicate tools.

## Regenerating the brand assets

The checked-in assets were generated on Windows with Python 3.14.3, `fonttools` 4.68.0 and `uharfbuzz` 0.57.0. Match those versions and leave `LOGO_NAME`, `LOGO_SUB` and `LOGO_TAG` unset to reproduce the assets byte for byte. The generator uses native line endings, so other platforms produce LF. In a temporary directory outside the repository, use `npm pack @fontsource/sora@5.3.0 @fontsource/instrument-serif@5.3.0`. Extract each tarball into a directory named after the tarball without `.tgz`, keeping its internal `package/files/` layout.

Run the generator in UTF-8 mode. The fonts directory is the parent of the two extracted directories.

```powershell
python -X utf8 assets/brand/build_logo.py "<fonts-directory>" assets/brand
```

The generator writes `logo.svg` and `icon.svg`. Font files stay outside the repository.
