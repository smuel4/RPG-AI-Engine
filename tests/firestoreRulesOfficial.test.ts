import { isolatedFirestore } from '../scripts/isolated-firestore.mjs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';

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

test('regras de staging isolam a campanha reservada e as coleções privadas', async () => {
  const env = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: {
    host: EMULATOR_HOST, port: EMULATOR_PORT, rules: readFileSync('firestore.staging.rules', 'utf8'),
  } });
  try {
    const path = 'campaigns/echo-arc-server-pilot';
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      for (const target of ['stagingAccess/pilot', path, 'campaigns/geral', path + '/narrative/a',
        path + '/npcRoutineState/tl_root', path + '/turnReceipts/turno', path + '/checkpoints/um',
        path + '/pilotCheckpoints/um', path + '/pilotCheckpointReceipts/um']) {
        await setDoc(doc(db, target), { ownerId: 'convidado' });
      }
    });
    const guest = env.authenticatedContext('convidado', { email_verified: true }).firestore();
    const other = env.authenticatedContext('outro', { email_verified: true }).firestore();
    const unverified = env.authenticatedContext('convidado', { email_verified: false }).firestore();
    await assertSucceeds(getDoc(doc(guest, path)));
    await assertSucceeds(getDocs(query(collection(guest, path, 'narrative'), where('ownerId', '==', 'convidado'))));
    for (const db of [other, unverified, env.unauthenticatedContext().firestore()]) {
      await assertFails(getDoc(doc(db, path)));
    }
    const privateCheckpoints = [path + '/pilotCheckpoints/um', path + '/pilotCheckpointReceipts/um'];
    for (const target of ['campaigns/geral', path + '/npcRoutineState/tl_root', path + '/turnReceipts/turno',
      path + '/checkpoints/um', ...privateCheckpoints]) {
      await assertFails(getDoc(doc(guest, target)));
    }
    for (const target of [path, path + '/narrative/a', path + '/checkpoints/um', 'stagingAccess/pilot', ...privateCheckpoints]) {
      await assertFails(setDoc(doc(guest, target), { ownerId: 'convidado' }));
    }
  } finally {
    await env.cleanup();
  }
});
