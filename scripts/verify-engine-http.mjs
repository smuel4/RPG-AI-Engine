import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freixoEmulatorPorts } from '../server/freixoEmulatorPorts.mjs';
import { testGroups } from './test-manifest.mjs';
import { isolatedFirestore, namedDatabase, project } from './isolated-firestore.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const testArgs = ['--import', 'tsx', '--test', '--test-reporter=spec', ...testGroups.http.map((file) => 'tests/' + file)];

function run(args, cwd, env) {
  const result = spawnSync(process.execPath, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function checkPort(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error) => {
      reject(new Error(`Porta ${port}: esperada livre, obtido ${error.code}. Integração HTTP pendente.`, { cause: error }));
    });
    probe.listen(port, '127.0.0.1', () => {
      const selected = probe.address().port;
      probe.close(() => resolve(selected));
    });
  });
}

const full = process.argv[2] === '--full';
const playtest = process.argv[2] === '--playtest';
const continuity = process.argv[2] === '--continuity' || process.argv[2] === '--continuity-smoke';
const disposable = full || playtest || continuity;
const started = performance.now();
let ownedDirectory;
try {
  if (process.argv[2] === '--serve-visual') {
    const ports = freixoEmulatorPorts(true);
    const env = { ...process.env, FIREBASE_PROJECT_ID: 'demo-rpg-ai-engine', NODE_ENV: 'development',
      FIRESTORE_DATABASE_ID: 'ai-studio-31936b9f-7516-468c-9cf4-6dd4da7fb704',
      VITE_FREIXO_LOCAL: 'true', TURN_PLAN_SERVER_COMMIT: 'true', NARRATOR_MODE: 'fixed', DISABLE_HMR: 'true',
      VITE_FIRESTORE_EMULATOR_PORT: String(ports.firestore), VITE_AUTH_EMULATOR_PORT: String(ports.auth), PORT: String(ports.http) };
    if (run(['--import', 'tsx', 'scripts/validacao-mundo-vivo.ts', '--preparar-site'], root, env)) {
      throw new Error('Falha ao preparar o piloto descartável.');
    }
    process.exitCode = run(['--import', 'tsx', 'server.ts'], root, env);
  } else if (process.argv[2] === '--run-playtest' || process.argv[2] === '--run-continuity') {
    await isolatedFirestore();
    const mode = process.argv[2] === '--run-playtest' ? '--playtest'
      : process.env.ECHO_CONTINUITY_LIMIT === '4' ? '--continuity-smoke' : '--continuity';
    process.exitCode = run(['--import', 'tsx', 'scripts/validacao-mundo-vivo.ts', mode], root,
      { ...process.env, FIREBASE_PROJECT_ID: project });
  } else if (process.argv[2] === '--run-full') {
    const failures = [];
    const suites = [...testGroups.emulator, ...testGroups.http];
    for (const file of suites) {
      const port = await isolatedFirestore();
      for (const db of ['(default)', namedDatabase]) {
        const response = await fetch(`http://127.0.0.1:${port}/emulator/v1/projects/${project}/databases/${db}/documents`,
          { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('Falha na limpeza do banco descartável: ' + response.status);
      }
      const begin = performance.now();
      const result = run(['--import', 'tsx', '--test', '--test-reporter=spec', 'tests/' + file], root, process.env);
      console.log(`[integração] ${file} | saída ${result} | ${((performance.now() - begin) / 1000).toFixed(2)} s`);
      if (result) failures.push(file);
    }
    console.log(`Integração: ${suites.length - failures.length}/${suites.length} suítes aprovadas em ${((performance.now() - started) / 1000).toFixed(2)} s.`);
    if (failures.length) throw new Error('Suítes reprovadas: ' + failures.join(', '));
  } else if (process.argv[2] === '--run-test') {
    process.exitCode = run(testArgs, root, process.env);
  } else {
    const visual = process.argv.includes('--visual');
    const alternate = disposable || visual || process.argv.includes('--alternate');
    const input = playtest && resolve(process.argv[3] ?? '');
    if (playtest && (process.argv.length !== 4 || dirname(input) !== resolve(tmpdir()) ||
        !/[/\\]echo-arc-playtest-[\w-]+\.tsv$/i.test(input))) {
      throw new Error('Use --playtest com um arquivo echo-arc-playtest-NOME.tsv diretamente na pasta temporária.');
    }
    if (playtest) {
      const temp = await realpath(tmpdir());
      const toTemp = relative(await realpath(root), temp);
      if ((!toTemp.startsWith('..' + sep) && !isAbsolute(toTemp)) || dirname(await realpath(input)) !== temp) {
        throw new Error('O roteiro e o relatório devem ficar na pasta temporária fora do repositório.');
      }
    }
    if (full && run(['scripts/check.mjs'], root, process.env)) throw new Error('Gate local reprovado.');
    if (continuity || full) {
      // Check loopback before launching Firebase, whose hub would otherwise time out.
      const probe = createServer();
      await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', resolve);
      });
      try {
        await new Promise((resolve, reject) => {
          const connection = createConnection(probe.address().port, '127.0.0.1');
          connection.setTimeout(5000, () => connection.destroy(new Error('Timeout no teste TCP local.')));
          connection.once('error', reject);
          connection.once('connect', () => {
            connection.destroy();
            resolve();
          });
        });
      } finally {
        await new Promise(resolve => probe.close(resolve));
      }
    }
    const ports = freixoEmulatorPorts(alternate);
    for (const [name, port] of Object.entries(ports)) {
      try {
        await checkPort(port);
      } catch (error) {
        if (!disposable || error.cause?.code !== 'EADDRINUSE') throw error;
        let free;
        do { free = await checkPort(0); } while (Object.values(ports).includes(free) || [3219, 8080, 9099].includes(free));
        ports[name] = free;
      }
    }
    const directory = await mkdtemp(join(tmpdir(), disposable ? 'echo-arc-full-' : 'echo-arc-engine-http-'));
    if (disposable) ownedDirectory = directory;
    console.log(`Logs dos emuladores: ${directory}`);
    const config = JSON.parse(await readFile(join(root, 'firebase.json'), 'utf8'));
    config.emulators.firestore.port = ports.firestore;
    config.emulators.auth.port = ports.auth;
    if (alternate) {
      config.emulators.hub = { host: '127.0.0.1', port: ports.hub };
      config.emulators.logging = { host: '127.0.0.1', port: ports.logging };
      config.emulators.ui = { enabled: false };
      config.emulators.firestore.websocketPort = ports.websocket;
    }
    await writeFile(join(directory, 'firebase.json'), JSON.stringify(config));
    await copyFile(join(root, 'firestore.rules'), join(directory, 'firestore.rules'));

    // Firebase Tools inclui o ambiente do processo filho no log de depuração.
    const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|OS|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|JAVA_HOME)$/i;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
    Object.assign(env, { TEMP: directory, TMP: directory, TMPDIR: directory });
    if (alternate) env.FREIXO_TEST_ALT_PORTS = '1';
    if (disposable) Object.assign(env, {
      ECHO_FULL_DIRECTORY: directory, ECHO_FULL_PORTS: JSON.stringify(ports), CI: '1', FIREBASE_CLI_DISABLE_UPDATE_CHECK: '1',
      FIREBASE_EMULATORS_PATH: join(homedir(), '.cache', 'firebase', 'emulators'),
      HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory, XDG_CONFIG_HOME: directory,
      NODE_OPTIONS: '--import=' + new URL('./integration-network.mjs', import.meta.url).href,
    });
    if (playtest) {
      env.ECHO_PLAYTEST_INPUT = input;
      env.ECHO_PLAYTEST_OUTPUT = await mkdtemp(join(tmpdir(), 'echo-arc-playtest-'));
      console.log('Relatório local:', env.ECHO_PLAYTEST_OUTPUT);
    }
    if (continuity) {
      env.ECHO_CONTINUITY_LIMIT = process.argv[2] === '--continuity-smoke' ? '4' : '40';
      const report = await mkdtemp(join(tmpdir(), 'echo-arc-continuity-'));
      env.ECHO_CONTINUITY_REPORT = join(report, 'sessao.jsonl');
      console.log('Relatório local:', env.ECHO_CONTINUITY_REPORT);
    }
    if (full) console.log('Portas descartáveis:', ports);
    const firebase = join(root, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
    const command = `node "${fileURLToPath(import.meta.url)}" ${playtest ? '--run-playtest' : continuity ? '--run-continuity' : full ? '--run-full' : visual ? '--serve-visual' : '--run-test'}`;
    process.exitCode = run([firebase, 'emulators:exec', '--only', 'auth,firestore',
      '--project', 'demo-rpg-ai-engine', '--non-interactive', command], directory, env);
  }
} catch (error) {
  console.error(`[Integração HTTP] ${error.message}`);
  process.exitCode = 1;
} finally {
  if (ownedDirectory) await rm(ownedDirectory, { recursive: true, force: true, maxRetries: 3 });
  if (full) console.log(`check:full | saída ${process.exitCode ?? 0} | ${((performance.now() - started) / 1000).toFixed(2)} s`);
}
