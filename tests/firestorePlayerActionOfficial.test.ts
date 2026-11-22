import { isolatedFirestore } from '../scripts/isolated-firestore.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  setDoc,
  getDoc,
  getDocs,
  collection,
  query,
  where,
  serverTimestamp,
  terminate,
} from 'firebase/firestore';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { processPlayerAction } from '../src/engine/rulesEngine';
import { turnDocumentIds } from '../src/engine/turnIdentity';
import { commitPlayerActionTransaction } from '../src/services/campaignRepository';
import type { Campaign, NarrativeEntry, GameEvent } from '../src/types/game';

const isolatedPort = await isolatedFirestore();

const PROJECT = 'demo-rpg-ai-engine';
const DATABASE = 'ai-studio-31936b9f-7516-468c-9cf4-6dd4da7fb704';
const OWNER_UID = 'dono_teste_narrador';
const INTRUDER_UID = 'intruso_teste_narrador';

function cliente(nome: string, uid: string) {
  const app = initializeApp(
    { projectId: PROJECT, apiKey: 'demo', appId: 'demo' },
    nome,
  );
  const db = getFirestore(app, DATABASE);
  connectFirestoreEmulator(db, '127.0.0.1', isolatedPort, {
    mockUserToken: {
      user_id: uid,
      email: `${uid}@example.com`,
      email_verified: true,
    },
  });
  return { app, db };
}

for (const concurrent of [false, true]) {
test('Firestore oficial: turno ' + (concurrent ? 'concorrente' : 'simples') + ' e reenvio', async () => {
  const dono = cliente('app-dono-narrador', OWNER_UID);
  const intruso = cliente('app-intruso-narrador', INTRUDER_UID);

  try {
    const bundle = createEchoArcBundle(OWNER_UID);
    const campaignId = bundle.campaign.id;
    const campaignRefDono = doc(dono.db, 'campaigns', campaignId);

    // 1. Prepara campanha inicial no Firestore
    await setDoc(campaignRefDono, {
      ...bundle.campaign,
      revision: 1,
      lastSequence: 4,
      activeTimelineId: 'tl_root',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const actionText = 'Samuel caminha até o poço da vila para buscar água fresca.';
    const narrationText =
      'A brisa da manhã refresca o vale enquanto Samuel gira a manivela do poço. ' +
      'Teresa o observa da soleira da porta, satisfeita com o dia claro.';

    const ruleResult = processPlayerAction(
      {
        ...bundle.campaign,
        id: campaignId,
        revision: 1,
        lastSequence: 4,
        activeTimelineId: 'tl_root',
      } as Campaign,
      [],
      [],
      actionText,
      10,
      narrationText,
    );

    assert.ok(ruleResult.ok);
    const actionData = ruleResult.data;
    const turn = { turnId: globalThis.crypto.randomUUID(), campaignId, declaredAction: actionText,
      expectedRevision: 1, baseTimelineId: 'tl_root', advanceMinutes: 10 };
    const ids = await turnDocumentIds(turn);
    const ownedCount = async (name: string) => (await getDocs(query(
      collection(dono.db, 'campaigns', campaignId, name), where('ownerId', '==', OWNER_UID),
    ))).size;
    const beforeCounts = await Promise.all([ownedCount('narrative'), ownedCount('events')]);
    const beforeCampaign = (await getDoc(campaignRefDono)).data();
    for (const invalid of [
      { currentLocation: '' },
      { timelineLineage: [{ timelineId: 'incorreta', fromSequence: -1, toSequence: null }] },
      { ownerId: INTRUDER_UID },
      { revision: 3 },
    ]) {
      await assert.rejects(setDoc(campaignRefDono, {
        revision: 2, updatedAt: serverTimestamp(), ...invalid,
      }, { merge: true }), /permission.?denied/i);
    }

    // Force the emulator rules to reject one write of the batch.
    await assert.rejects(commitPlayerActionTransaction(campaignId, {
      ...actionData, engineEntry: { ...actionData.engineEntry, content: 'x'.repeat(2001) },
    }, 1, 'tl_root', { db: dono.db, skipAuthCheck: true, turn }), /permission.?denied/i);
    assert.deepEqual((await getDoc(campaignRefDono)).data(), beforeCampaign);
    assert.deepEqual(await Promise.all([ownedCount('narrative'), ownedCount('events')]), beforeCounts);

    // 2. Jogador autorizado grava ação, narrativa e evento atomicamente
    const submit = () => commitPlayerActionTransaction(
      campaignId,
      actionData,
      1,
      'tl_root',
      { db: dono.db, skipAuthCheck: true, turn },
    );
    if (concurrent) {
      const replies = await Promise.allSettled([submit(), submit()]);
      const failures = replies.flatMap((reply, index) => reply.status === 'rejected'
        ? ['submissão ' + (index + 1) + ': ' + String(reply.reason)] : []);
      assert.equal(failures.length, 0, failures.join('\n'));
      const values = replies.flatMap((reply) => reply.status === 'fulfilled' ? [reply.value] : []);
      assert.equal(values.filter((value) => value === undefined).length, 1);
      assert.equal(values.find(Boolean)?.content, narrationText);
    } else {
      assert.equal(await submit(), undefined);
    }
    assert.equal((await submit())?.content, narrationText);
    await assert.rejects(commitPlayerActionTransaction(campaignId, actionData, 1, 'tl_root',
      { db: dono.db, skipAuthCheck: true, turn: { ...turn, advanceMinutes: 11 } }), /TURN_ID_CONFLICT/);

    // 3. Verificação no Firestore: campanha atualizada com revisão e sequência corretas
    const updatedSnap = await getDoc(campaignRefDono);
    assert.ok(updatedSnap.exists());
    const updatedCampaign = updatedSnap.data() as Campaign;
    assert.equal(updatedCampaign.revision, 2);
    assert.equal(updatedCampaign.lastSequence, actionData.nextLastSequence);
    assert.deepEqual(updatedCampaign.worldTime, actionData.nextWorldTime);
    assert.equal(updatedCampaign.currentLocation, bundle.campaign.currentLocation);
    assert.deepEqual(await Promise.all([ownedCount('narrative'), ownedCount('events')]),
      [beforeCounts[0] + 2, beforeCounts[1] + 1]);

    // Verifica que narrative do jogador foi salva
    const playerEntrySnap = await getDoc(
      doc(dono.db, `campaigns/${campaignId}/narrative`, ids.player),
    );
    assert.ok(playerEntrySnap.exists());
    const playerEntry = playerEntrySnap.data() as NarrativeEntry;
    assert.equal(playerEntry.authorRole, 'player_action');
    assert.equal(playerEntry.content, actionText);

    // Verifica que narrativa do narrador foi salva
    const engineEntrySnap = await getDoc(
      doc(dono.db, `campaigns/${campaignId}/narrative`, ids.engine),
    );
    assert.ok(engineEntrySnap.exists());
    const engineEntry = engineEntrySnap.data() as NarrativeEntry;
    assert.equal(engineEntry.authorRole, 'engine_response');
    assert.equal(engineEntry.content, narrationText);

    // Verifica que evento foi salvo
    const eventSnap = await getDoc(
      doc(dono.db, `campaigns/${campaignId}/events`, ids.event),
    );
    assert.ok(eventSnap.exists());
    const eventData = eventSnap.data() as GameEvent;
    assert.equal(eventData.type, 'PLAYER_ACTION');

    // 4. Acesso por outro usuário é recusado (regras do Firestore bloqueiam com PERMISSION_DENIED)
    const ruleResult2 = processPlayerAction(
      updatedCampaign,
      [],
      [],
      'Ação forjada por outro usuário',
      10,
      'Resposta forjada',
    );
    assert.ok(ruleResult2.ok);

    await assert.rejects(
      async () => {
        await commitPlayerActionTransaction(
          campaignId,
          ruleResult2.data,
          2,
          'tl_root',
          { db: intruso.db, skipAuthCheck: true },
        );
      },
      (err: Error) => {
        return (
          err.message.includes('permission-denied') ||
          err.message.includes('PERMISSION_DENIED')
        );
      },
      'Intruso deve ser bloqueado pelas regras do Firestore',
    );

    // 5. Restauração de checkpoint ou mudança de revisão durante a geração impede gravação antiga
    // Simulando que o estado avançou para revisão 3 (ou foi restaurado por checkpoint)
    await setDoc(
      campaignRefDono,
      {
        ...updatedCampaign,
        revision: 3,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    // Tentativa de gravar com a revisão antiga (expectedRevision: 2) deve abortar
    await assert.rejects(
      async () => {
        await commitPlayerActionTransaction(
          campaignId,
          ruleResult2.data,
          2, // Esperava 2, mas banco já está em 3!
          'tl_root',
          { db: dono.db, skipAuthCheck: true },
        );
      },
      (err: Error) => {
        return err.message.includes('CONCURRENT_STATE_CONFLICT');
      },
      'Mudança concorrente de revisão deve abortar a transação sem gravar dados',
    );

    // 6. Mudança de timeline ativa (ex.: checkpoint restaurado para outra ramificação)
    await setDoc(
      campaignRefDono,
      {
        ...updatedCampaign,
        revision: 4,
        activeTimelineId: 'tl_ramo_restaurado',
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    await assert.rejects(
      async () => {
        await commitPlayerActionTransaction(
          campaignId,
          ruleResult2.data,
          4, // Revisão bate, mas linha temporal mudou!
          'tl_root', // Esperava tl_root, mas banco está em tl_ramo_restaurado
          { db: dono.db, skipAuthCheck: true },
        );
      },
      (err: Error) => {
        return err.message.includes('CONCURRENT_STATE_CONFLICT');
      },
      'Mudança na linha temporal ativa deve abortar a transação',
    );
    const afterTimelineChange = (await getDoc(campaignRefDono)).data();
    assert.equal((await submit())?.content, narrationText);
    assert.deepEqual((await getDoc(campaignRefDono)).data(), afterTimelineChange);
    assert.deepEqual(await Promise.all([ownedCount('narrative'), ownedCount('events')]),
      [beforeCounts[0] + 2, beforeCounts[1] + 1]);
  } finally {
    await terminate(dono.db);
    await terminate(intruso.db);
    await deleteApp(dono.app);
    await deleteApp(intruso.app);
  }
});
}
