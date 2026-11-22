import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { freixoEmulatorPorts } from '../server/freixoEmulatorPorts.mjs';

export const project = 'demo-rpg-ai-engine';
export const namedDatabase = 'ai-studio-31936b9f-7516-468c-9cf4-6dd4da7fb704';

export async function isolatedFirestore() {
  const ports = freixoEmulatorPorts(true);
  const address = (port) => '127.0.0.1:' + port;
  const hub = address(ports.hub);
  const directory = process.env.ECHO_FULL_DIRECTORY;
  if (!directory || resolve(directory) !== resolve(tmpdir()) || !basename(directory).startsWith('echo-arc-full-') ||
      process.env.GCLOUD_PROJECT !== project || process.env.FIRESTORE_EMULATOR_HOST !== address(ports.firestore) ||
      process.env.FIREBASE_AUTH_EMULATOR_HOST !== address(ports.auth) || process.env.FIREBASE_EMULATOR_HUB !== hub) {
    throw new Error('Integração exige a sessão descartável criada por check:full.');
  }
  const get = async (path) => {
    const response = await fetch('http://' + hub + path, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Hub indisponível: ' + response.status);
    return response.json();
  };
  const locator = JSON.parse(await readFile(join(directory, 'hub-' + project + '.json'), 'utf8'));
  const config = JSON.parse(await readFile(join(directory, 'firebase.json'), 'utf8'));
  if (config.firestore?.length !== 1 || config.firestore[0].database !== namedDatabase ||
      config.firestore[0].rules !== 'firestore.rules') throw new Error('Banco ou regras inesperados na sessão descartável.');
  const live = await get('/');
  const services = await get('/emulators');
  if (!Number.isInteger(locator.pid) || live.pid !== locator.pid || !locator.origins.includes('http://' + hub) ||
      ['firestore', 'auth', 'hub'].some((name) => services[name]?.host !== '127.0.0.1' || services[name].port !== ports[name])) {
    throw new Error('O hub ativo não confirma a identidade dos emuladores desta execução.');
  }
  return ports.firestore;
}
