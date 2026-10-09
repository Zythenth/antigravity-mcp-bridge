import { build } from 'esbuild';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const result = await build({ entryPoints: ['dist/src/index.js'], bundle: true, platform: 'node', format: 'esm',
  target: 'node24', outfile: 'plugin/server.mjs', metafile: true, legalComments: 'none' });
const roots = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const parts = input.replaceAll('\\', '/').split('/');
  const index = parts.lastIndexOf('node_modules');
  if (index < 0) continue;
  roots.add(parts.slice(0, index + (parts[index + 1].startsWith('@') ? 3 : 2)).join('/'));
}
const notices = [];
for (const root of [...roots].sort()) {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const names = (await readdir(root)).filter(name => /^licen[cs]e(?:[.-]|$)/i.test(name)).sort();
  if (!names.length) throw new Error(`Missing license text for bundled dependency: ${manifest.name}`);
  const texts = await Promise.all(names.map(name => readFile(path.join(root, name), 'utf8')));
  notices.push(`## ${manifest.name} ${manifest.version}\n\nLicença declarada: ${manifest.license}.\n\n\`\`\`text\n${texts.join('\n').replace(/[ \t]+$/gm, '').trim()}\n\`\`\`\n`);
}
await writeFile('THIRD_PARTY_NOTICES.md', '# Avisos de dependências\n\nEstas dependências estão incluídas em `plugin/server.mjs`. Seus avisos e licenças permanecem aplicáveis.\n\n' + notices.join('\n'), 'utf8');
console.log(`Plugin compilado; avisos de ${notices.length} dependências atualizados.`);
