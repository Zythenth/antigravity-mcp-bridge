import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

// 1. Bundle TypeScript frontend logic targeting browser/chrome120
const jsResult = await build({
  entryPoints: ['ui/panel.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  write: false,
  metafile: true,
  minify: false
});

// Check build output
const bundledJs = jsResult.outputFiles?.[0]?.text;
if (!bundledJs) {
  throw new Error('esbuild produced no output files for ui/panel.ts');
}

// 2. Read CSS and HTML template
const cssContent = await readFile('ui/panel.css', 'utf8');
const htmlTemplate = await readFile('ui/panel.html', 'utf8');

const cssPlaceholder = '/* __PANEL_CSS__ */';
const jsPlaceholder = '/* __PANEL_JS__ */';

// Verify placeholders are present exactly once
const cssCount = htmlTemplate.split(cssPlaceholder).length - 1;
if (cssCount !== 1) {
  throw new Error(`Expected exactly one CSS placeholder '${cssPlaceholder}', found ${cssCount}`);
}

const jsCount = htmlTemplate.split(jsPlaceholder).length - 1;
if (jsCount !== 1) {
  throw new Error(`Expected exactly one JS placeholder '${jsPlaceholder}', found ${jsCount}`);
}

// Escape closing script and style tags to be completely safe when inlined
const safeCss = cssContent.replace(/<\/style/gi, '<\\/style');
const safeJs = bundledJs.replace(/<\/script/gi, '<\\/script');

// Replace unique placeholders
const finalHtml = htmlTemplate
  .replace(cssPlaceholder, () => safeCss)
  .replace(jsPlaceholder, () => safeJs);

// Ensure output directories exist
await mkdir('dist/src', { recursive: true });
await mkdir('plugin', { recursive: true });

// Write self-contained HTML to dist/src/panel.html and plugin/panel.html
await writeFile('dist/src/panel.html', finalHtml, 'utf8');
await writeFile('plugin/panel.html', finalHtml, 'utf8');

// Export or write metafile privately under dist for later license notice collector
await writeFile('dist/panel.metafile.json', JSON.stringify(jsResult.metafile, null, 2), 'utf8');

console.log('Panel HTML generated successfully at dist/src/panel.html and plugin/panel.html');
