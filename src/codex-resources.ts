import { execFile } from 'node:child_process';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import ts from 'typescript';

interface ArchiveEntry { files?: Record<string, ArchiveEntry>; size?: number; offset?: string; unpacked?: boolean; link?: string }
export interface NativeAvatarResources {
  source: 'installed-codex' | 'unavailable';
  pairs: Array<{ dark: string; light: string }>;
  reason?: string;
  icons?: Record<string,string>;
}
const execute = promisify(execFile);

export async function discoverCodexArchive(override = process.env.CODEX_APP_DIRECTORY): Promise<string | undefined> {
  const directories: string[] = [];
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('CODEX_APP_DIRECTORY must be absolute');
    directories.push(override);
  } else if (process.platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation'], { windowsHide: true, timeout: 10000, maxBuffer: 32768 });
    directories.push(...result.stdout.split(/\r?\n/).map(value => value.trim()).filter(value => path.isAbsolute(value)));
  } else if (process.platform === 'darwin') {
    directories.push('/Applications/Codex.app', path.join(os.homedir(), 'Applications', 'Codex.app'));
  }
  for (const directory of directories) {
    for (const relative of ['app/resources/app.asar', 'Contents/Resources/app.asar', 'resources/app.asar', 'app.asar']) {
      const file = path.join(directory, relative);
      try { if ((await stat(file)).isFile()) return await realpath(file); } catch { /* try the next normal installation layout */ }
    }
  }
  return undefined;
}

export async function readNativeAvatars(archive: string): Promise<NativeAvatarResources> {
  const file = await open(archive, 'r');
  try {
    const archiveSize = (await file.stat()).size;
    async function bytes(offset: number, size: number): Promise<Buffer> {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > archiveSize) throw new Error('Invalid ASAR range');
      const data = Buffer.alloc(size); let read = 0;
      while (read < size) { const result = await file.read(data, read, size - read, offset + read); if (!result.bytesRead) throw new Error('Incomplete ASAR data'); read += result.bytesRead; }
      return data;
    }
    const size = (await bytes(0, 8)).readUInt32LE(4);
    if (size < 8 || size > 16 * 1024 * 1024) throw new Error('Unsupported ASAR header size');
    const header = await bytes(8, size), textSize = header.readUInt32LE(4);
    if (textSize > size - 8) throw new Error('Invalid ASAR header');
    const tree = JSON.parse(header.subarray(8, 8 + textSize).toString()) as ArchiveEntry;
    const entries = new Map<string, ArchiveEntry>();
    function walk(entry: ArchiveEntry, prefix = '', depth = 0): void {
      if (depth > 30 || entries.size > 100000) throw new Error('ASAR index limit exceeded');
      for (const [name, child] of Object.entries(entry.files ?? {})) {
        if (!name || /[\\/]/.test(name) || name === '.' || name === '..') throw new Error('Invalid ASAR entry');
        const key = prefix + name;
        if (child.files) walk(child, key + '/', depth + 1); else entries.set(key, child);
      }
    }
    walk(tree);
    async function readEntry(name: string, maxBytes: number): Promise<string> {
      const entry = entries.get(name);
      if (!entry || entry.link || entry.unpacked || !Number.isSafeInteger(entry.size) || entry.size! > maxBytes || !/^\d+$/.test(entry.offset ?? '')) throw new Error('Unsupported native resource');
      return (await bytes(8 + size + Number(entry.offset), entry.size!)).toString();
    }
    const panel = [...entries.keys()].find(name => /^webview\/assets\/subagent-panel-[^/]+\.js$/.test(name));
    if (!panel) throw new Error('Native subagent component is unavailable');
    const panelAst = ts.createSourceFile(panel, await readEntry(panel, 512 * 1024), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let avatarAlias: string | undefined;
    function findAvatar(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.arguments.length >= 2 && ts.isIdentifier(node.arguments[0]!) && ts.isObjectLiteralExpression(node.arguments[1]!)) {
        const properties = node.arguments[1]!.properties.map(property => property.name?.getText(panelAst));
        if (properties.includes('palette') && properties.includes('seed')) avatarAlias ??= node.arguments[0]!.text;
      }
      ts.forEachChild(node, findAvatar);
    }
    findAvatar(panelAst);
    let modulePath: string | undefined, exportName: string | undefined;
    for (const node of panelAst.statements) if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const specifier of node.importClause.namedBindings.elements) if (specifier.name.text === avatarAlias) {
        modulePath = path.posix.normalize(path.posix.join(path.posix.dirname(panel), node.moduleSpecifier.text));
        exportName = specifier.propertyName?.text ?? specifier.name.text;
      }
    }
    if (!modulePath?.startsWith('webview/assets/') || !exportName) throw new Error('Native avatar import is unavailable');
    const ast = ts.createSourceFile(modulePath, await readEntry(modulePath, 32 * 1024 * 1024), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let localName: string | undefined;
    for (const node of ast.statements) if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const specifier of node.exportClause.elements) if (specifier.name.text === exportName) localName = specifier.propertyName?.text ?? specifier.name.text;
    }
    const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === localName);
    if (!component) throw new Error('Native avatar renderer is unavailable');
    let paletteName: string | undefined;
    function findPalette(node: ts.Node): void {
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && ts.isCallExpression(node.argumentExpression)) paletteName ??= node.expression.text;
      ts.forEachChild(node, findPalette);
    }
    findPalette(component);
    const values = new Map<string, string>(); let references: Array<{ dark: string; light: string }> = [];
    function collect(node: ts.Node): void {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        const name = node.left.text;
        if (name === paletteName && ts.isArrayLiteralExpression(node.right)) {
          references = node.right.elements.map(element => {
            if (!ts.isObjectLiteralExpression(element)) throw new Error('Unsupported native palette');
            const pair: Record<string, string> = {};
            for (const property of element.properties) if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) pair[property.name.getText(ast)] = property.initializer.text;
            if (!pair.dark || !pair.light) throw new Error('Incomplete native palette');
            return { dark: pair.dark, light: pair.light };
          });
        }
        if (ts.isStringLiteral(node.right) || ts.isNoSubstitutionTemplateLiteral(node.right)) values.set(name, node.right.text);
        function findUrl(child: ts.Node): void {
          if (ts.isNewExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'URL' && child.arguments?.[0] &&
            (ts.isStringLiteral(child.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(child.arguments[0]))) values.set(name, child.arguments[0].text);
          ts.forEachChild(child, findUrl);
        }
        findUrl(node.right);
      }
      ts.forEachChild(node, collect);
    }
    collect(ast);
    if (!references.length || references.length > 64) throw new Error('Native palette limit exceeded');
    async function asset(name: string): Promise<string> {
      const value = values.get(name); if (!value) throw new Error('Native avatar asset is unavailable');
      const svg = value.startsWith('data:image/svg+xml,') ? decodeURIComponent(value.slice(value.indexOf(',') + 1))
        : await readEntry(path.posix.normalize(path.posix.join(path.posix.dirname(modulePath!), value)), 65536);
      if (Buffer.byteLength(svg) > 65536 || !svg.includes('<svg') || /<script|foreignObject|\son\w+=|(?:href|xlink:href)=["'](?!#)/i.test(svg)) throw new Error('Unexpected native SVG content');
      return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    }
    const pairs = await Promise.all(references.map(async reference => ({ dark: await asset(reference.dark), light: await asset(reference.light) })));
    const icons: Record<string,string> = {};
    for (const [key, prefix] of Object.entries({back:'arrow_left',copy:'copy',code:'code',expand:'expand',undo:'undo',file:'file_plus'})) {
      const resource = [...entries.keys()].find(name => name.startsWith('webview/assets/' + prefix + '-') && name.endsWith('.svg'));
      if (!resource) continue;
      const svg = await readEntry(resource,65536);
      if (svg.includes('<svg') && !/<script|foreignObject|\son\w+=|(?:href|xlink:href)=["'](?!#)/i.test(svg)) icons[key] = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    }
    return { source: 'installed-codex', pairs, icons };
  } finally { await file.close(); }
}

let cached: Promise<NativeAvatarResources> | undefined;
export function nativeAvatarResources(): Promise<NativeAvatarResources> {
  cached ??= (async () => {
    try { const archive = await discoverCodexArchive(); return archive ? await readNativeAvatars(archive) : { source: 'unavailable' as const, pairs: [], reason: 'Codex installation not found' }; }
    catch { return { source: 'unavailable' as const, pairs: [], reason: 'Native avatar resources are not compatible or accessible' }; }
  })();
  return cached;
}
