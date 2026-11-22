import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { testGroups } from './test-manifest.mjs';

const started = performance.now();
const testsDir = resolve('tests');
const files = readdirSync(testsDir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.test\.tsx?$/.test(entry.name))
  .map((entry) => relative(testsDir, resolve(entry.parentPath, entry.name)).split(sep).join('/'));
const classified = new Map();
for (const [group, entries] of Object.entries(testGroups)) {
  if (!['local', 'emulator', 'http'].includes(group)) throw new Error('Grupo desconhecido: ' + group);
  for (const file of entries) {
    if (classified.has(file)) throw new Error(`Classificação duplicada: ${file} (${classified.get(file)}, ${group})`);
    if (!files.includes(file)) throw new Error(`Teste classificado inexistente: ${file}`);
    classified.set(file, group);
  }
}
for (const file of files) {
  if (!classified.has(file)) throw new Error(`Teste sem classificação: ${file}`);
}
console.log(`Manifesto: ${files.length} arquivos, ${testGroups.local.length} locais, ${(performance.now() - started).toFixed(1)} ms`);

const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR)$/i;
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.test(name)));
function run(label, args) {
  const begin = performance.now();
  const result = spawnSync(process.execPath, args, { env, stdio: 'inherit' });
  console.log(`${label}: ${((performance.now() - begin) / 1000).toFixed(2)} s`);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('Testes locais', ['--import', './scripts/local-test-network.mjs', '--import', 'tsx',
  '--test', '--test-concurrency=1', '--test-reporter=spec', ...testGroups.local.map((file) => 'tests/' + file)]);
run('TypeScript', ['node_modules/typescript/bin/tsc', '--noEmit']);
