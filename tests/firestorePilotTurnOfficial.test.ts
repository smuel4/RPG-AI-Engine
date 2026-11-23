import { isolatedFirestore } from '../scripts/isolated-firestore.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { initializeApp as initializeClient, deleteApp as deleteClient } from 'firebase/app';
import { connectFirestoreEmulator, doc, getDoc, getFirestore as clientFirestore, serverTimestamp, setDoc, updateDoc, terminate } from 'firebase/firestore';
import { persistPilotTurn, SERVER_PILOT_ID } from '../server/persistPilotTurn';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { advanceWorldTime } from '../src/engine/rulesEngine';
import { createWellEncounterNpc, villageWell } from '../src/engine/echoArcEncounters';

const isolatedPort = await isolatedFirestore();

test('piloto grava chegada uma vez e o navegador não escreve estado nem recibos', async () => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:' + isolatedPort);
  const projectId = 'demo-rpg-ai-engine';
  const database = 'ai-studio-31936b9f-7516-468c-9cf4-6dd4da7fb704';
  const admin = initializeApp({ projectId }, 'pilot-admin');
  const app = initializeClient({ projectId, apiKey: 'demo', appId: 'demo' }, 'pilot-owner');
  const browser = clientFirestore(app, database);
  connectFirestoreEmulator(browser, '127.0.0.1', isolatedPort, {
    mockUserToken: { user_id: 'dono', email_verified: true },
  });
  const db = getFirestore(admin, database);
  const ref = db.collection('campaigns').doc(SERVER_PILOT_ID);
  try {
    const bundle = createEchoArcBundle('dono');
    const [teresa, henrique] = bundle.npcs;
    const home = teresa.location;
    const workshop = henrique.location;
    const campaign = { ...bundle.campaign, id: SERVER_PILOT_ID, currentLocation: home };
    await ref.set(campaign);
    const npcRef = ref.collection('npcs');
    await npcRef.doc(teresa.id).set({ ...teresa, campaignId: SERVER_PILOT_ID });
    await npcRef.doc(henrique.id).set({ ...henrique, campaignId: SERVER_PILOT_ID, location: home });
    const catalog = { places: [{ id: home, aliases: ['casa'] }, { id: 'Praça', aliases: [] }, { id: workshop, aliases: [] }],
      routes: [{ from: home, to: 'Praça', minutes: 8 }, { from: home, to: workshop, minutes: 4 },
        { from: 'Praça', to: home, minutes: 8 }] };
    const turn = { turnId: crypto.randomUUID(), campaignId: SERVER_PILOT_ID, declaredAction: 'Vou até a praça',
      advanceMinutes: 700, expectedRevision: campaign.revision, baseTimelineId: campaign.activeTimelineId || 'tl_root' };
    const scene = 'Bancas de madeira cercam o chafariz.';
    const narrate: Parameters<typeof persistPilotTurn>[4] = async (_campaign, _intent, present) => {
      assert.deepEqual(present, { npcs: [], knowledge: [], activities: [], memories: [] });
      return scene;
    };
    const submit = () => persistPilotTurn(db, catalog, 'dono', turn, narrate);
    await assert.rejects(persistPilotTurn(db, catalog, 'outro', turn, narrate), /CAMPAIGN_ACCESS_DENIED/);
    await assert.rejects(persistPilotTurn(db, catalog, 'dono', { ...turn, expectedRevision: turn.expectedRevision + 1 }, narrate), /CONCURRENT_STATE_CONFLICT/);
    await assert.rejects(persistPilotTurn(db, catalog, 'dono', turn, async () => 'Samuel voltou ao Porto.'), /PILOT_NARRATION_CONFLICT/);
    assert.equal((await ref.get()).data()?.currentLocation, home);
    assert.equal((await npcRef.doc(henrique.id).get()).data()?.location, home);
    assert.equal((await ref.collection('npcRoutineState').get()).size, 0);
    await assert.rejects(updateDoc(doc(browser, 'campaigns', SERVER_PILOT_ID, 'npcs', henrique.id),
      { location: workshop, updatedAt: serverTimestamp() }), /permission|insufficient/i);
    assert.equal((await ref.collection('events').get()).size, 0);
    assert.equal((await ref.collection('turnReceipts').get()).size, 0);
    await assert.rejects(updateDoc(doc(browser, 'campaigns', SERVER_PILOT_ID), {
      currentLocation: 'Praça', worldTime: advanceWorldTime(campaign.worldTime, 8),
      revision: campaign.revision + 1, updatedAt: serverTimestamp(),
    }), /permission|insufficient/i);
    for (const collection of ['narrative', 'events', 'turnReceipts', 'checkpoints']) {
      await assert.rejects(setDoc(doc(browser, 'campaigns', SERVER_PILOT_ID, collection, 'forjado'), {
        id: 'forjado', ownerId: 'dono',
      }), /permission|insufficient/i);
    }
    const replies = await Promise.all([submit(), submit()]);
    assert.equal(replies[0].narration, replies[1].narration);
    assert.equal((await persistPilotTurn(db, catalog, 'dono', turn, async () => assert.fail('renarrou'))).narration,
      replies[0].narration);
    const after = (await ref.get()).data()!;
    assert.equal(after.currentLocation, 'Praça');
    assert.deepEqual(after.worldTime, advanceWorldTime(campaign.worldTime, 8));
    assert.equal(after.revision, campaign.revision + 1);
    assert.equal((await ref.collection('narrative').get()).size, 2);
    assert.equal((await ref.collection('events').get()).size, 1);
    assert.equal((await ref.collection('turnReceipts').get()).size, 1);
    assert.equal((await npcRef.doc(henrique.id).get()).data()?.location, workshop);
    assert.equal((await npcRef.doc(teresa.id).get()).data()?.location, home);
    const [runtime] = (await ref.collection('npcRoutineState').get()).docs;
    assert.equal(runtime.data().memories.length, 1);
    assert.equal(runtime.data().memories[0].turnId, turn.turnId);
    const privateRef = doc(browser, 'campaigns', SERVER_PILOT_ID, 'npcRoutineState', runtime.id);
    await assert.rejects(getDoc(privateRef), /permission|insufficient/i);
    await assert.rejects(updateDoc(privateRef, { memories: [] }), /permission|insufficient/i);
    for (const collection of ['narrative', 'events']) {
      const [record] = (await ref.collection(collection).get()).docs;
      await assert.rejects(setDoc(doc(browser, 'campaigns', SERVER_PILOT_ID, collection, 'duplicado'), {
        ...record.data(), id: 'duplicado', createdAt: serverTimestamp(),
      }), /permission|insufficient/i);
    }
    await persistPilotTurn(db, catalog, 'dono', { ...turn, turnId: crypto.randomUUID(),
      expectedRevision: after.revision, declaredAction: 'Vou até a casa' }, async (_arrival, _intent, present) => {
      assert.deepEqual(present.npcs.map(({ name }) => name), ['Teresa']);
      assert.deepEqual(present.memories, []);
      return 'Teresa organiza a mesa.';
    });
    const revision = (await ref.get()).data()!.revision;
    const conversation = { ...turn, turnId: crypto.randomUUID(), expectedRevision: revision,
      declaredAction: 'Conto a Teresa: Talvez eu viaje.' };
    await persistPilotTurn(db, catalog, 'dono', conversation, async () => 'Teresa escuta.');
    await persistPilotTurn(db, catalog, 'dono', conversation, async () => assert.fail('renarrou a conversa'));
    await persistPilotTurn(db, catalog, 'dono', { ...conversation, turnId: crypto.randomUUID(),
      expectedRevision: revision + 1, declaredAction: 'Digo a Teresa: Bom dia.' },
    async (_arrival, _intent, present) => {
      assert.deepEqual(present.memories[0].memories.filter(({ source }) => source === 'reported'),
        [{ source: 'reported', speaker: campaign.protagonist.name, fact: 'Talvez eu viaje.' }]);
      return 'Teresa retribui o cumprimento.';
    });
    const memories = (await runtime.ref.get()).data()!.memories;
    assert.equal(memories.filter((memory: { turnId: string }) => memory.turnId === conversation.turnId).length, 1);
    const disclosure = { ...conversation, turnId: crypto.randomUUID(), expectedRevision: revision + 2,
      declaredAction: 'Confidencio a Teresa: Tenho medo de sair de casa.' };
    await persistPilotTurn(db, catalog, 'dono', disclosure, async () => 'Teresa escuta.');
    await persistPilotTurn(db, catalog, 'dono', disclosure, async () => assert.fail('renarrou a confidência'));
    await assert.rejects(updateDoc(privateRef, { relationships: [] }), /permission|insufficient/i);
    const relationships = (await runtime.ref.get()).data()!.relationships;
    assert.equal(relationships.length, 1);
    assert.equal(relationships[0].disclosure.turnId, disclosure.turnId);
    const lira = createWellEncounterNpc('dono', SERVER_PILOT_ID);
    await npcRef.doc(lira.id).set(lira);
    const visit = { ...turn, turnId: crypto.randomUUID(), expectedRevision: revision + 3,
      declaredAction: 'Vou até o poço' };
    const wellCatalog = { places: [...catalog.places, { id: villageWell, aliases: ['poço'] }],
      routes: [...catalog.routes, { from: home, to: villageWell, minutes: 6 }] };
    await persistPilotTurn(db, wellCatalog, 'dono', visit, async (_arrival, _intent, _present, relationships) => {
      assert.deepEqual(relationships, []);
      return 'Lira segura a corda do balde.';
    });
    await persistPilotTurn(db, wellCatalog, 'dono', visit, async () => assert.fail('repetiu encontro'));
    const stored = (await runtime.ref.get()).data()!.relationships;
    assert.equal(stored.length, 2);
    assert.equal(stored.find((entry: { from: string }) => entry.from === lira.id)?.firstEncounter.turnId, visit.turnId);
  } finally {
    await terminate(browser);
    await deleteClient(app);
    await deleteApp(admin);
  }
});
