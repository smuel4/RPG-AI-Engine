import { isolatedFirestore } from '../scripts/isolated-firestore.mjs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, runTransaction, serverTimestamp, setDoc, Timestamp } from 'firebase/firestore';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { buildCheckpointPayload } from '../src/engine/rulesEngine';

const isolatedPort = await isolatedFirestore();

const PROJECT_ID = 'demo-rpg-ai-engine';
const HOST = '127.0.0.1';
const PORT = isolatedPort;
const UID = 'usuario_teste_local';

test('Firestore oficial: transação completa de salvamento de checkpoint', async () => {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: HOST,
      port: PORT,
      rules: readFileSync('firestore.rules', 'utf8'),
    },
  });

  try {
    // O emulador só contém dados fictícios. Limpa dados locais de rodadas anteriores.
    await env.clearFirestore();
    const bundle = createEchoArcBundle(UID);
    const campaignId = bundle.campaign.id;
    const campaignPath = `campaigns/${campaignId}`;

    // Semeia uma campanha fictícia, exclusivamente no emulador.
    await env.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), campaignPath), {
        ...bundle.campaign,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
    });

    // Usa as funções reais do motor para gerar os mesmos tipos de payloads do aplicativo.
    const built = buildCheckpointPayload(
      bundle.campaign,
      bundle.inventory,
      bundle.npcs,
      'Teste oficial',
      'Sem alterar campanha real',
    );
    if (!built.ok) throw new Error(`Motor rejeitou payload: ${built.error}`);
    const { checkpoint, event, nextLastSequence, nextRevision } = built.data;

    console.log('Campos do checkpoint:', Object.keys(checkpoint).join(', '));
    console.log('Campos do evento:', Object.keys(event).join(', '));

    // Usuário fictício com e-mail verificado, exigido pelas regras atuais.
    const db = env.authenticatedContext(UID, {
      email: 'teste-local@example.com',
      email_verified: true,
    }).firestore();
    const campaignRef = doc(db, campaignPath);
    const checkpointRef = doc(db, campaignPath, 'checkpoints', checkpoint.id);
    const eventRef = doc(db, campaignPath, 'events', event.id);

    // Três gravações numa única transação — exatamente a operação que está falhando.
    await runTransaction(db, async (tx) => {
      const current = await tx.get(campaignRef);
      if (!current.exists()) throw new Error('Campanha fictícia não encontrada');
      if (current.data().revision !== bundle.campaign.revision) {
        throw new Error('Revisão inesperada na campanha fictícia');
      }
      tx.update(campaignRef, {
        lastSequence: nextLastSequence,
        revision: nextRevision,
        updatedAt: serverTimestamp(),
      });
      tx.set(checkpointRef, { ...checkpoint, createdAt: serverTimestamp() });
      tx.set(eventRef, { ...event, createdAt: serverTimestamp() });
    }, { maxAttempts: 1 });

    const savedCheckpoint = await getDoc(checkpointRef);
    const savedEvent = await getDoc(eventRef);
    if (!savedCheckpoint.exists() || !savedEvent.exists()) {
      throw new Error('Transação retornou sem erro, mas checkpoint/evento não foram encontrados');
    }
    console.log('OK: checkpoint e evento persistidos no emulador, na mesma transação.');
  } finally {
    await env.cleanup();
  }
});
