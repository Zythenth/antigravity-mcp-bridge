// Maintainer tool: reports Portuguese text in the files given as arguments.
// Usage: node scripts/check-language.mjs [--allowlist <file>] <file> [<file> ...]
// Exit codes: 0 no findings, 1 findings, 2 invalid usage or allowlist.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Any single word with one of these letters is reported, in any letter case.
const ACCENTED_LETTERS = /[ãõçáàâéêíóôú]/iu;
// Words with no English homograph that mark a line as Portuguese on their own, including unaccented spellings.
const DECISIVE_WORDS = new Set([
  'arquivo', 'arquivos', 'comando', 'comandos', 'dados', 'exemplo', 'exemplos', 'executar', 'instalar', 'nao',
  'requisitos', 'sao', 'tarefa', 'tarefas', 'tambem', 'usados', 'uso', 'voce',
]);
// Function words: two different ones on the same line report it.
const FUNCTION_WORDS = new Set([
  'ainda', 'antes', 'ao', 'aos', 'apenas', 'cada', 'com', 'como', 'da', 'das', 'de', 'depois', 'deve', 'devem', 'dos',
  'em', 'entre', 'essa', 'esse', 'esta', 'estas', 'este', 'estes', 'foi', 'isso', 'mais', 'nas', 'nos', 'onde', 'ou',
  'para', 'pela', 'pelas', 'pelo', 'pelos', 'pode', 'podem', 'por', 'quando', 'que', 'quem', 'sem', 'ser', 'seu', 'seus',
  'sobre', 'sua', 'suas', 'tem', 'uma', 'umas', 'uns',
]);
const ALLOWLIST_CATEGORIES = new Set(['third-party-license', 'proper-name', 'identifier', 'language-fixture', 'portuguese-edition']);

function fail(message) {
  console.error(message);
  process.exit(2);
}

function validEntry(entry, key) {
  return entry && typeof entry[key] === 'string' && entry[key].length > 0 && typeof entry.reason === 'string' && entry.reason.length > 0
    && ALLOWLIST_CATEGORIES.has(entry.category);
}

function loadAllowlist(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`Cannot read the allowlist ${file}: ${error.message}`);
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.paths) || !Array.isArray(parsed.terms)) fail(`Invalid allowlist format: ${file}`);
  for (const entry of parsed.paths) if (!validEntry(entry, 'pattern')) fail(`Invalid path entry: ${JSON.stringify(entry)}`);
  for (const entry of parsed.terms) if (!validEntry(entry, 'term')) fail(`Invalid term entry: ${JSON.stringify(entry)}`);
  return {
    paths: parsed.paths.map(entry => globToRegExp(entry.pattern)),
    terms: new Set(parsed.terms.map(entry => entry.term)),
  };
}

function globToRegExp(pattern) {
  const source = pattern.split('**').map(part => part.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${source}$`);
}

// Fenced blocks and inline code hold identifiers and commands, which stay as written in every language.
function markdownLines(lines) {
  let fence = null;
  return lines.map(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return '';
    }
    if (marker) {
      fence = marker;
      return '';
    }
    return line.replace(/(`+)[^`]*?\1/g, ' ');
  });
}

function findWords(line, terms) {
  const found = new Set();
  const functionWords = new Set();
  for (const [match] of line.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ').matchAll(/[\p{L}\p{N}_./\\-]+/gu)) {
    const token = match.replace(/^[_./\\-]+|[_./\\-]+$/g, '');
    for (const [word] of token.matchAll(/\p{L}+/gu)) {
      if (ACCENTED_LETTERS.test(word) && !terms.has(word)) found.add(word);
    }
    // A token joined by separators is an identifier or path, unless it spells a Portuguese word with an accent.
    if (!/^\p{L}+$/u.test(token) || terms.has(token)) continue;
    const lower = token.toLowerCase();
    if (DECISIVE_WORDS.has(lower)) found.add(token);
    if (FUNCTION_WORDS.has(lower)) functionWords.add(token);
  }
  if (new Set([...functionWords].map(word => word.toLowerCase())).size >= 2) for (const word of functionWords) found.add(word);
  return [...found];
}

const args = process.argv.slice(2);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let allowlistFile = path.join(root, 'scripts', 'language-allowlist.json');
if (args[0] === '--allowlist') {
  if (!args[1]) fail('Missing value for --allowlist.');
  allowlistFile = path.resolve(args[1]);
  args.splice(0, 2);
}
if (!args.length) fail('Usage: node scripts/check-language.mjs [--allowlist <file>] <file> [<file> ...]');

const allowlist = loadAllowlist(allowlistFile);
let findings = 0;
let checked = 0;
let skipped = 0;
const affected = new Set();
for (const file of args) {
  const relative = path.relative(root, path.resolve(file)).replaceAll('\\', '/');
  if (allowlist.paths.some(pattern => pattern.test(relative))) {
    skipped++;
    continue;
  }
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (error) {
    fail(`Cannot read ${file}: ${error.message}`);
  }
  checked++;
  const lines = content.split(/\r?\n/);
  const scanned = /\.(md|mdx|markdown)$/i.test(file) ? markdownLines(lines) : lines;
  scanned.forEach((line, index) => {
    const words = findWords(line, allowlist.terms);
    if (!words.length) return;
    findings++;
    affected.add(file);
    console.log(`${file}:${index + 1}: ${words.join(', ')}`);
  });
}
console.log(`Checked ${checked} file(s), skipped ${skipped} allowlisted file(s): ${findings} line(s) with Portuguese text in ${affected.size} file(s).`);
process.exitCode = findings ? 1 : 0;
