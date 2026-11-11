// Maintainer tool: renders assets/brand/icon.svg into the static PNG icons that the plugin, the skill and the MCP server declare.
// Usage: node assets/brand/build_icons.mjs [--preview <directory>]
// The renderer is installed at a pinned version into a cache outside the repository, so the published package gains no dependency.
// Set BLACK_GRAVITY_ICON_TOOL_DIRECTORY to choose that cache; the default lives in the system temporary directory.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESVG = {
  name: '@resvg/resvg-js',
  version: '2.6.2',
  integrity: 'sha512-xBaJish5OeGmniDj9cW5PRa/PtmuVU3ziqrbr5xJj901ZDN4TosrVaNZpEiLZAxdfnhAe7uQ7QFWfjPe9d9K2Q==',
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = path.join(root, 'assets', 'brand', 'icon.svg');
const SERVER_MODULE = path.join(root, 'src', 'server-icons.ts');
// `light` is drawn for light backgrounds and `dark` for dark ones, the meaning used by MCP icons and by the Codex manifest.
const OUTPUTS = [
  { file: 'plugin/assets/icon.png', theme: 'light', size: 128 },
  { file: 'plugin/assets/icon-dark.png', theme: 'dark', size: 128 },
  { file: 'plugin/assets/logo.png', theme: 'light', size: 512 },
  { file: 'plugin/assets/logo-dark.png', theme: 'dark', size: 512 },
  { file: 'plugin/skills/black-gravity/assets/icon-small.png', theme: 'light', size: 64 },
  { file: 'plugin/skills/black-gravity/assets/icon-large.png', theme: 'light', size: 512 },
];
const SERVER_ICONS = [
  { theme: 'light', size: 48 }, { theme: 'light', size: 96 },
  { theme: 'dark', size: 48 }, { theme: 'dark', size: 96 },
];
const PREVIEW_SIZES = [16, 32];
const PREVIEW_BACKGROUNDS = { light: '#ffffff', dark: '#1f1f1f' };

function previewDirectory(argv) {
  if (argv.length === 0) return null;
  if (argv.length === 2 && argv[0] === '--preview' && argv[1]) return path.resolve(argv[1]);
  console.error('Usage: node assets/brand/build_icons.mjs [--preview <directory>]');
  process.exit(2);
}

function npmCli() {
  const candidate = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(candidate)) throw new Error(`npm CLI not found at ${candidate}`);
  return candidate;
}

async function loadRenderer() {
  const directory = path.resolve(process.env.BLACK_GRAVITY_ICON_TOOL_DIRECTORY || path.join(os.tmpdir(), `black-gravity-resvg-${RESVG.version}`));
  const manifest = JSON.stringify({ private: true, dependencies: { [RESVG.name]: RESVG.version } }, null, 2) + '\n';
  const lockPath = path.join(directory, 'package-lock.json');
  const current = existsSync(path.join(directory, 'package.json')) ? await readFile(path.join(directory, 'package.json'), 'utf8') : null;
  if (current !== manifest || !existsSync(lockPath)) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), manifest);
    execFileSync(process.execPath, [npmCli(), 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
      { cwd: directory, stdio: 'inherit' });
  }
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const entry = lock.packages?.[`node_modules/${RESVG.name}`];
  if (entry?.version !== RESVG.version || entry.integrity !== RESVG.integrity) {
    throw new Error(`${RESVG.name} in ${directory} does not match the pinned version and integrity`);
  }
  // The native renderer ships in per-platform packages; any of them that npm installed must carry the same version.
  for (const [key, value] of Object.entries(lock.packages)) {
    if (key.startsWith('node_modules/@resvg/resvg-js-') && value.version !== RESVG.version) throw new Error(`${key} is ${value.version}, expected ${RESVG.version}`);
  }
  return createRequire(path.join(directory, 'package.json'))(RESVG.name).Resvg;
}

// Point at a fraction of an orbit's arc length. Each orbit is two half ellipses drawn from (a, 0) through (0, b) and back.
function orbitPoint(a, b, fraction) {
  const steps = 4096;
  const lengths = [0];
  for (let index = 1; index <= steps; index += 1) {
    const previous = (2 * Math.PI * (index - 1)) / steps;
    const angle = (2 * Math.PI * index) / steps;
    lengths.push(lengths[index - 1] + Math.hypot(a * (Math.cos(angle) - Math.cos(previous)), b * (Math.sin(angle) - Math.sin(previous))));
  }
  const target = fraction * lengths[steps];
  let index = lengths.findIndex(length => length >= target);
  if (index <= 0) index = 1;
  const angle = (2 * Math.PI * (index - 1 + (target - lengths[index - 1]) / (lengths[index] - lengths[index - 1]))) / steps;
  return [a * Math.cos(angle), b * Math.sin(angle)];
}

// Freeze the animated artwork at its first frame: every moving body is placed where the animation starts and the SMIL elements are removed.
function staticArtwork(svg) {
  const orbits = new Map();
  for (const match of svg.matchAll(/<path id="(orb\d)" d="M ([\d.]+),0 A \2,([\d.]+) /g)) orbits.set(match[1], [Number(match[2]), Number(match[3])]);
  let moved = 0;
  const frozen = svg.replace(
    /<(circle|g)([^>]*)><animateMotion dur="([\d.]+)s" begin="-([\d.]+)s" repeatCount="indefinite"><mpath href="#(orb\d)" xlink:href="#\5"\/><\/animateMotion>/g,
    (_, tag, attributes, duration, offset, orbit) => {
      const radii = orbits.get(orbit);
      if (!radii) throw new Error(`Unknown orbit ${orbit}`);
      const [x, y] = orbitPoint(radii[0], radii[1], (Number(offset) % Number(duration)) / Number(duration));
      moved += 1;
      return `<${tag}${attributes} transform="translate(${x.toFixed(2)} ${y.toFixed(2)})">`;
    });
  const result = frozen.replace(/<animate\b[^>]*\/>/g, '');
  if (orbits.size !== 3 || moved !== 12 || /<animate|<mpath/.test(result)) {
    throw new Error(`icon.svg no longer has the expected structure (${orbits.size} orbits, ${moved} moving bodies)`);
  }
  return result;
}

// The card is dark, so the variant for dark backgrounds adds a one-pixel light rim that keeps its edge visible.
function themedArtwork(svg, theme, size) {
  if (theme === 'light') return svg;
  const width = 512 / size;
  const inset = width / 2;
  const rim = `<rect x="${inset}" y="${inset}" width="${512 - width}" height="${512 - width}" rx="${112 - inset}" fill="none" stroke="#c4b5fd" stroke-opacity="0.55" stroke-width="${width}"/>`;
  const closing = svg.lastIndexOf('</svg>');
  return svg.slice(0, closing) + rim + '\n' + svg.slice(closing);
}

function render(Resvg, svg, size) {
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } }).render().asPng());
}

function serverModule(icons) {
  const lines = [
    '// Generated by assets/brand/build_icons.mjs from assets/brand/icon.svg. Do not edit by hand.',
    "import type { Icon } from '@modelcontextprotocol/sdk/types.js';",
    '',
    'export const SERVER_ICONS: Icon[] = [',
  ];
  for (const icon of icons) {
    lines.push('  {', `    src: 'data:image/png;base64,${icon.png.toString('base64')}',`, "    mimeType: 'image/png',",
      `    sizes: ['${icon.size}x${icon.size}'],`, `    theme: '${icon.theme}',`, '  },');
  }
  lines.push('];', '');
  return lines.join('\n');
}

// Each preview places the icons at their real size on light and dark backgrounds, then repeats them enlarged eight times without smoothing.
function previewBoard(pngs, size) {
  const scale = 8;
  const cell = size * scale + 32;
  const height = size * scale + size + 48;
  const parts = [];
  let x = 0;
  // Columns, left to right: light icon on light, dark icon on light, light icon on dark, dark icon on dark.
  for (const color of Object.values(PREVIEW_BACKGROUNDS)) {
    for (const png of Object.values(pngs)) {
      const href = `data:image/png;base64,${png.toString('base64')}`;
      parts.push(`<rect x="${x}" y="0" width="${cell}" height="${height}" fill="${color}"/>`,
        `<image x="${x + 16}" y="16" width="${size}" height="${size}" href="${href}"/>`,
        `<image x="${x + 16}" y="${size + 32}" width="${size * scale}" height="${size * scale}" image-rendering="optimizeSpeed" href="${href}"/>`);
      x += cell;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${x}" height="${height}">${parts.join('')}</svg>`;
}

const preview = previewDirectory(process.argv.slice(2));
const Resvg = await loadRenderer();
const artwork = staticArtwork(await readFile(SOURCE, 'utf8'));
for (const output of OUTPUTS) {
  const target = path.join(root, output.file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, render(Resvg, themedArtwork(artwork, output.theme, output.size), output.size));
}
const icons = SERVER_ICONS.map(icon => ({ ...icon, png: render(Resvg, themedArtwork(artwork, icon.theme, icon.size), icon.size) }));
await writeFile(SERVER_MODULE, serverModule(icons));
const embedded = icons.reduce((total, icon) => total + icon.png.length, 0);
const encoded = icons.reduce((total, icon) => total + `data:image/png;base64,${icon.png.toString('base64')}`.length, 0);
console.log(`Wrote ${OUTPUTS.length} PNG files and ${path.relative(root, SERVER_MODULE)}: ${icons.length} server icons, ${embedded} PNG bytes, ${encoded} data URI characters`);
if (preview) {
  await mkdir(preview, { recursive: true });
  for (const size of PREVIEW_SIZES) {
    const pngs = { light: render(Resvg, themedArtwork(artwork, 'light', size), size), dark: render(Resvg, themedArtwork(artwork, 'dark', size), size) };
    for (const [theme, png] of Object.entries(pngs)) await writeFile(path.join(preview, `icon-${theme}-${size}.png`), png);
    await writeFile(path.join(preview, `preview-${size}.png`), Buffer.from(new Resvg(previewBoard(pngs, size)).render().asPng()));
  }
  console.log(`Wrote previews to ${preview}`);
}
