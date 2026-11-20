import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freixoEmulatorPorts } from '../server/freixoEmulatorPorts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const testArgs = ['--import', 'tsx', '--test', '--test-reporter=spec', 'tests/freixoObjectsHttpOfficial.test.ts'];

function run(args, cwd, env) {
  const result = spawnSync(process.execPath, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function checkPort(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error) => {
      reject(new Error(`Porta ${port}: esperada livre, obtido ${error.code}. Integração HTTP pendente.`));
    });
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}

try {
  if (process.argv[2] === '--run-test') {
    process.exitCode = run(testArgs, root, process.env);
  } else {
    const alternate = process.argv.includes('--alternate');
    const ports = freixoEmulatorPorts(alternate);
    for (const port of Object.values(ports)) await checkPort(port);
    const directory = await mkdtemp(join(tmpdir(), 'echo-arc-engine-http-'));
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
    const firebase = join(root, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
    const command = `node "${fileURLToPath(import.meta.url)}" --run-test`;
    process.exitCode = run([firebase, 'emulators:exec', '--only', 'auth,firestore',
      '--project', 'demo-rpg-ai-engine', '--non-interactive', command], directory, env);
  }
} catch (error) {
  console.error(`[Integração HTTP] ${error.message}`);
  process.exitCode = 1;
}
