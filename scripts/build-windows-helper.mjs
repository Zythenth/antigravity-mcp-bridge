import { mkdir, readFile, writeFile } from 'node:fs/promises';
const source = await readFile('native/windows-test-runner.cs', 'utf8');
const reparseSource = await readFile('native/windows-reparse-inspector.cs', 'utf8');
await mkdir('dist/src', { recursive: true });
await writeFile('dist/src/windows-helper-source.js',
  'export const windowsHelperSource = ' + JSON.stringify(source) + ';\n' +
  'export const reparseInspectorSource = ' + JSON.stringify(reparseSource) + ';\n'
);
