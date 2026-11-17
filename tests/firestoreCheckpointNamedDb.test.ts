import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  getFirestore, connectFirestoreEmulator, doc,
  setDoc, getDoc, runTransaction, serverTimestamp, terminate
} from 'firebase/firestore';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { buildCheckpointPayload } from '../src/engine/rulesEngine';

const PROJECT = 'demo-rpg-ai-engine';
const DATABASE = 'ai-studio-31936b9f-7516-468c-9cf4-6dd4da7fb704';
const UID = 'dono_teste_nomeado';

function cliente(nome: string, uid: string) {
  const app = initializeApp(
    { projectId: PROJECT, apiKey: 'demo', appId: 'demo' },
    nome
  );
  const db = getFirestore(app, DATABASE);
  connectFirestoreEmulator(db, '127.0.0.1', 8080, {
    mockUserToken: {
      user_id: uid,
      email: 'teste@example.com',
      email_verified: true
    }
  });
  return { app, db };
}

test('Checkpoint no banco nomeado com isolamento de usuarios', async () => {
  const dono = cliente('teste-dono-nomeado', UID);
  const intruso = cliente('teste-intruso-nomeado', 'outro_usuario');

  try {
    const bundle = createEchoArcBundle(UID);
    const path = 'campaigns/' + bundle.campaign.id;
    const campanhaRef = doc(dono.db, path);

    await setDoc(campanhaRef, {
      ...bundle.campaign,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    const resultado = buildCheckpointPayload(
      bundle.campaign, bundle.inventory, bundle.npcs,
      'Teste banco nomeado', 'Dados ficticios'
    );

    if (!resultado.ok) throw new Error(resultado.error);

    const { checkpoint, event, nextLastSequence, nextRevision } = resultado.data;
    const cpRef = doc(dono.db, path, 'checkpoints', checkpoint.id);
    const eventoRef = doc(dono.db, path, 'events', event.id);

    await runTransaction(dono.db, async tx => {
      const atual = await tx.get(campanhaRef);
      assert.equal(atual.exists(), true);

      tx.update(campanhaRef, {
        lastSequence: nextLastSequence,
        revision: nextRevision,
        updatedAt: serverTimestamp()
      });
      tx.set(cpRef, { ...checkpoint, createdAt: serverTimestamp() });
      tx.set(eventoRef, { ...event, createdAt: serverTimestamp() });
    }, { maxAttempts: 1 });

    assert.equal((await getDoc(cpRef)).exists(), true);
    assert.equal((await getDoc(eventoRef)).exists(), true);

    await assert.rejects(
      getDoc(doc(intruso.db, path, 'checkpoints', checkpoint.id)),
      (erro: any) => erro.code === 'permission-denied'
    );

    console.log('OK: checkpoint salvo no BANCO NOMEADO.');
    console.log('OK: outro usuario bloqueado.');
  } finally {
    await terminate(dono.db);
    await terminate(intruso.db);
    await deleteApp(dono.app);
    await deleteApp(intruso.app);
  }
});