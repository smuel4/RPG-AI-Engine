import { isolatedFirestore } from '../scripts/isolated-firestore.mjs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc } from 'firebase/firestore';

const isolatedPort = await isolatedFirestore();

const PROJECT_ID = 'demo-rpg-ai-engine';
const EMULATOR_HOST = '127.0.0.1';
const EMULATOR_PORT = isolatedPort;

test('Firestore Emulator: bloqueia leitura de campanha sem autenticação', async () => {
  const rules = readFileSync('firestore.rules', 'utf8');
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: EMULATOR_HOST,
      port: EMULATOR_PORT,
      rules,
    },
  });

  try {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'campaigns', 'campanha_de_teste')));
  } finally {
    await env.cleanup();
  }
});
