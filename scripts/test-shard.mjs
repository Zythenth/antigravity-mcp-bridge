import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Approximate Windows runner seconds; weights only balance the shards, never select which tests run.
const TEST_WEIGHTS = {
  bridge: 546,
  'file-protection': 234,
  'workflow-runtime': 234,
  features: 216,
  inbox: 186,
  'windows-recovery': 156,
  'windows-mcp': 138,
  'portable-node': 126,
  'integration-policy': 126,
  'windows-executor': 108,
  mcp: 102,
  'agent-policy-runtime': 90,
  'persistence-redaction': 60,
  'project-memory-runtime': 60,
  'peer-input': 60,
  'host-git': 48,
  'skills-api': 48,
  'windows-permissions': 42,
  artifacts: 42,
  'subprocess-robustness': 36,
  'task-results': 30,
  'group-runtime': 30,
  'specialist-runtime': 30,
  'windows-aliases': 24,
};

const [indexArg, totalArg] = process.argv.slice(2);
const index = Number(indexArg);
const total = Number(totalArg);
if (process.argv.length !== 4 || !/^[1-9]\d*$/.test(indexArg ?? '') || !/^[1-9]\d*$/.test(totalArg ?? '') || index > total) {
  console.error('Uso: node scripts/test-shard.mjs <indice> <total>');
  process.exit(2);
}

let files;
try {
  files = readdirSync('dist/tests').filter(name => name.endsWith('.test.js')).sort();
} catch {
  files = [];
}
if (!files.length) {
  console.error('Nenhum arquivo de teste encontrado em dist/tests (build ausente).');
  process.exit(1);
}

const fileKeys = new Set(files.map(name => name.slice(0, -8)));
const obsolete = Object.keys(TEST_WEIGHTS).filter(key => !fileKeys.has(key));
if (obsolete.length) {
  console.error(`Chaves obsoletas na tabela de pesos: ${obsolete.join(', ')}`);
  process.exit(1);
}

const items = files
  .map(name => ({ name, weight: TEST_WEIGHTS[name.slice(0, -8)] ?? 5 }))
  .sort((a, b) => b.weight - a.weight || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const jobs = Array.from({ length: total }, () => ({ load: 0, files: [] }));
for (const item of items) {
  let target = jobs[0];
  for (let i = 1; i < jobs.length; i++) {
    if (jobs[i].load < target.load) target = jobs[i];
  }
  target.files.push(`dist/tests/${item.name}`);
  target.load += item.weight;
}

const job = jobs[index - 1];
if (!job.files.length) {
  console.log(`Job ${index}/${total}: nenhum arquivo de teste atribuído.`);
  process.exit(0);
}

const minutes = (job.load / 60).toFixed(1);
console.log(`Job ${index}/${total}: ${job.files.length} arquivos, carga estimada ${minutes} min`);

const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...job.files], { stdio: 'inherit' });
process.exit(result.signal || result.status === null ? 1 : result.status);
