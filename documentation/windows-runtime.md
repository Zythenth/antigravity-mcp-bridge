# Portable Node on Windows

## Portable Node runtime

The npm server defaults to system Node. The plugin descriptor selects `portable` so Windows LPAC tests can use the runtime prepared in the cache. Set `BRIDGE_WINDOWS_NODE_RUNTIME` to `system` or `portable` at trusted server startup. MCP inputs accept no runtime URL, hash or cache path.

The package includes a native Windows cache inspector compiled with the existing .NET Framework compiler, which is also required for status queries. It reads path attributes and reparse tags directly, without starting PowerShell. The inspector and permission path validation accept OneDrive's `IO_REPARSE_TAG_CLOUD` through `IO_REPARSE_TAG_CLOUD_F` and reject junctions, symlinks and unknown tags in any ancestor. Cloud-only files must be available for reading. The cache stays separate from the project. Inspector compilation has a 60-second deadline and inspection itself has a 15-second deadline. The helper removes its temporary files.

Check status without starting MCP, discovering `agy` or downloading anything:

```powershell
node plugin/server.mjs --windows-runtime-status
```

Prepare the runtime explicitly on Windows x64:

```powershell
node plugin/server.mjs --prepare-windows-runtime
```

For the published npm 0.9.0:

```powershell
npx --yes antigravity-mcp-bridge@0.9.0 --prepare-windows-runtime
```

Status returns JSON with `requestedMode`, `supported`, `ready`, `buildId`, `nodeVersion`, `libuvVersion`, `sha256` and, when needed, `error`. An unsupported host or an absent or invalid cache still produces a successful status query. Preparation failure exits with code 1. Preparation downloads only the declared GitHub Release assets, verifies size and SHA-256, and installs the private cache atomically.

For synchronized caches such as OneDrive, extra or transient hardlink counts (`nlink`) are tolerated only in these cases:

- Reading release assets with a trusted descriptor and pinned size and SHA-256.
- Staging the portable Node source with `expectedSha256`.
- Checking the preparation lock, provided `device`, `inode`, `size` and the exact nonce and payload stay the same. The owner unlinks only its own entry to preserve aliases.

Hash, size, file identity, reparse tags and directory layout are still mandatory. Changed content is refused and aliases remain intact. Runtime destinations, generic executables and ACL grants require a single link. `StateStore` has no general cloud-storage support.

Startup, health and tests perform no downloads. An absent cache in portable mode requires `--prepare-windows-runtime`, with no fallback to system Node. Preparation also refuses corrupt, changed or unsafe caches. Inspect the path and manually remove only the affected build cache before preparing it again.

Keep the cache outside projects. The bridge resolves real paths and rejects overlap in either direction between the project and `BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY` before model queries, queuing or copying. This also applies with `includePaths` and in `system` mode.

The default cache is `~/.black-gravity/windows-runtimes`. Only `BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY` changes it. With just `BRIDGE_STATE_DIRECTORY` set, preparation and portable mode still use the default cache and preparation creates `~/.black-gravity` with only the cache. Set both variables to keep everything outside the user profile in tests. Default-state migration copies the old cache from `~/.antigravity-mcp-bridge/windows-runtimes` and verifies its SHA-256 without downloading. If the new state directory already contains only a cache, migration keeps it and leaves the old cache where it is. The published 0.9.0 and earlier builds still use the old cache. Both caches are retained.

The immutable [Node 24.21.0 LPAC1 for Windows x64 release](https://github.com/Zythenth/black-gravity/releases/tag/runtime-node-v24.21.0-lpac1-win-x64) uses ABI 137, libuv 1.52.1 and only PR 5181 as a patch. Validation covers that build and architecture. The cache installs `node.exe`, the upstream `LICENSE` and `build.json` with the pinned source, patch, toolchain and build provenance. Portable selection replaces only the known `process.execPath` and its validated adjacent npm. Explicit custom Node and npm executables are preserved. This replacement requires Node 24 on the server host. Node 25 or 26 can start the server but eligible tests fail with `PORTABLE_NODE_HOST_UNSUPPORTED`. The cache persists across normal process and server restarts. Persistence across a physical restart remains unverified.

## Node subprocess compatibility on Windows LPAC

Node 24.14.1 with libuv 1.51 creates global `\\?\pipe\uv\...` endpoints when `child_process.spawnSync` captures stdin, stdout and stderr with its default pipes. LPAC rejects the global `CreateNamedPipe` call with error 5 and accepts equivalent `LOCAL\...` endpoints. Parent stdout and stderr capture is fixed, but the default-pipe case on system Node 24.14.1 still times out with exit code 124. Child tests with `stdio: "inherit"` and the real npm lifecycle passed. Those tests leave default captured pipes untested, so they cannot establish general subprocess compatibility. Keep default captured pipes in this regression to exercise the failing behavior.

[libuv PR 5181](https://github.com/libuv/libuv/pull/5181/files) fixes AppContainer pipe names and shipped in [libuv 1.53](https://github.com/libuv/libuv/releases/tag/v1.53.0). The pinned portable build above passed the LPAC `spawnSync` regression with default captured pipes (one test) and the isolation and lifecycle checks (22 tests, zero failures or skips).

`network: true` grants only the Windows `internetClient` and `privateNetworkClientServer` capabilities for internet and bidirectional private LAN traffic. Arbitrary capabilities, localhost exceptions and firewall changes are unavailable. Without the selection, the command has no network access. The approved policy also bounds `childProcesses` and `maxOutputChars`.

For a real account test on a disposable project, run `npm run build` and `node tests/native-integration.mjs`. This checks capture of a real `agy` execution with your account. The standard suite uses a mock CLI and consumes no quota.
