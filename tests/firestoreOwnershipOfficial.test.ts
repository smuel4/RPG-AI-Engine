import { isolatedFirestore } from '../scripts/isolated-firestore.mjs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, deleteDoc, setDoc, Timestamp } from 'firebase/firestore';

const isolatedPort = await isolatedFirestore();

const PROJECT_ID = 'demo-rpg-ai-engine';
const OWNER = 'usuario_dono_local';
const OTHER = 'usuario_estranho_local';
const CAMPAIGN = 'campanha_teste_isolamento';
const CHECKPOINT = 'chk_teste_isolamento';
const EVENT = 'evt_teste_isolamento';

test('Firestore oficial: dono autorizado e outro usuario bloqueado', async () => {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: '127.0.0.1', port: isolatedPort,
      rules: readFileSync('firestore.rules', 'utf8'),
    },
  });

  try {
    await env.clearFirestore(); // somente banco de DEMONSTRACAO no emulador
    const rootPath = `campaigns/${CAMPAIGN}`;
    const checkpointPath = `${rootPath}/checkpoints/${CHECKPOINT}`;
    const eventPath = `${rootPath}/events/${EVENT}`;

    // Dados ficticios inseridos por administrador apenas para testar a leitura.
    await env.withSecurityRulesDisabled(async (admin) => {
      const db = admin.firestore();
      await setDoc(doc(db, rootPath), { id: CAMPAIGN, ownerId: OWNER, status: 'active' });
      await setDoc(doc(db, checkpointPath), {
        id: CHECKPOINT, ownerId: OWNER, campaignId: CAMPAIGN, createdAt: Timestamp.now(),
      });
      await setDoc(doc(db, eventPath), {
        id: EVENT, ownerId: OWNER, campaignId: CAMPAIGN, createdAt: Timestamp.now(),
      });
    });

    const dono = env.authenticatedContext(OWNER, { email_verified: true }).firestore();
    const estranho = env.authenticatedContext(OTHER, { email_verified: true }).firestore();
    const naoVerificado = env.authenticatedContext(OWNER, { email_verified: false }).firestore();
    const anonimo = env.unauthenticatedContext().firestore();

    await assertSucceeds(getDoc(doc(dono, rootPath)));
    await assertSucceeds(getDoc(doc(dono, checkpointPath)));
    await assertSucceeds(getDoc(doc(dono, eventPath)));
    console.log('OK: dono autenticado e verificado le campanha, checkpoint e evento.');

    await assertFails(getDoc(doc(estranho, rootPath)));
    await assertFails(getDoc(doc(estranho, checkpointPath)));
    await assertFails(getDoc(doc(estranho, eventPath)));
    await assertFails(deleteDoc(doc(estranho, checkpointPath)));
    await assertFails(deleteDoc(doc(estranho, eventPath)));
    console.log('OK: usuario de outra conta nao le nem exclui checkpoint/evento.');

    await assertFails(getDoc(doc(naoVerificado, rootPath)));
    await assertFails(getDoc(doc(naoVerificado, checkpointPath)));
    await assertFails(getDoc(doc(anonimo, rootPath)));
    console.log('OK: email nao verificado e visitante sem login sao bloqueados.');
  } finally {
    await env.cleanup();
  }
});
