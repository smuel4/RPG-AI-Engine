import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryFirestore } from '../scripts/freixoEvaluationStore';
import { familyYard, freixoPlayableCatalog } from '../scripts/echoArcFreeTurn';
import { familyKitchen } from '../scripts/echoArcContinuityFixture';
import { listPilotCheckpoints, mutatePilotCheckpoint, PilotCheckpointError } from '../server/pilotCheckpoints';
import { persistPilotTurn, SERVER_PILOT_ID } from '../server/persistPilotTurn';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { getActiveTimelineId } from '../src/engine/rulesEngine';
import type { NpcRoutineState } from '../src/engine/npcRoutine';
import type { PilotCheckpointAction } from '../src/engine/pilotCheckpoint';
import type { Campaign, NarrativeEntry } from '../src/types/game';

function fixture() {
  const owner = 'dono';
  const bundle = createEchoArcBundle(owner);
  const campaign = { ...bundle.campaign, id: SERVER_PILOT_ID, currentLocation: familyKitchen, lastSequence: 9 };
  const ref = 'campaigns/' + campaign.id;
  const docs = new Map<string, object>([[ref, campaign]]);
  const db = memoryFirestore(docs);
  const state = () => docs.get(ref) as Campaign;
  const identity = () => ({
    campaignId: campaign.id, baseTimelineId: getActiveTimelineId(state()), expectedRevision: state().revision,
  });
  const request = (action: PilotCheckpointAction) => ({ ...identity(), ...action, requestId: crypto.randomUUID() });
  const mutate = (input: unknown, uid = owner) => mutatePilotCheckpoint(db, uid, input);
  return { owner, bundle, campaign, ref, docs, db, state, request, mutate, identity };
}

test('restaura estado, memória e vínculos na nova timeline com recibos idempotentes', async () => {
  const { owner, bundle, campaign, ref, docs, db, state, request, mutate, identity } = fixture();
  const teresa = { ...bundle.npcs[0], location: familyKitchen, campaignId: campaign.id };
  const item = { ...bundle.inventory[0], campaignId: campaign.id };
  const npcPath = ref + '/npcs/' + teresa.id;
  const itemPath = ref + '/inventory/' + item.id;
  const objectPath = ref + '/pilotObjectLocations/bloco';
  const root = getActiveTimelineId(campaign);
  const runtimePath = ref + '/npcRoutineState/';
  const runtime: NpcRoutineState = {
    holds: [], activities: [], observations: [], openObjects: ['armario'],
    completedActivities: ['organizar'], witnessedOccurrences: [{ id: 'convite', sequence: 6 }],
    bridgeOffer: { id: 'convite', npcId: 'henrique', recipientId: 'player', status: 'pending' },
    memories: [{ npcId: teresa.id, timelineId: root, turnId: 'origem', sequence: 7,
      origin: { kind: 'reported', reporterId: 'player' }, fact: 'Segredo anterior.' }],
    relationships: [{ from: teresa.id, toward: 'player', timelineId: root, bond: 'family',
      familiarity: 3, trust: 4, respect: 0, rapport: 0, disclosure: { turnId: 'origem', sequence: 7 } }],
  };
  const placement = { ownerId: owner, campaignId: campaign.id, timelineId: root, location: familyYard };
  docs.set(itemPath, item);
  docs.set(npcPath, teresa);
  docs.set(objectPath, placement);
  docs.set(runtimePath + root, runtime);
  const addHistory = (id: string, sequence: number, privateRecipientId?: string) =>
    docs.set(ref + '/narrative/' + id, { id, ownerId: owner, campaignId: campaign.id, timelineId: root, sequence,
      content: id, authorRole: 'player_action', worldTimeLabel: '', ...(privateRecipientId && { privateRecipientId }) } satisfies NarrativeEntry);
  addHistory('antes', 6, teresa.id);
  addHistory('privado', 7, 'outro-npc');

  const save = request({ action: 'save', label: 'Antes da pausa', note: '' });
  const saved = await mutate(save);
  assert.deepEqual(await mutate(save), saved);
  const summaries = await listPilotCheckpoints(db, owner);
  assert.equal(summaries[0].id, saved.checkpointId);
  assert.equal(summaries[0].inventoryCount, 1);
  assert.deepEqual(Object.keys(summaries[0]).sort(),
    ['currency', 'currentLocation', 'id', 'inventoryCount', 'label', 'note', 'revision', 'worldTime'].sort());
  assert.deepEqual(state().worldTime, campaign.worldTime);
  docs.delete(itemPath);
  docs.set(ref + '/inventory/posterior', { ...item, id: 'posterior' });
  docs.set(npcPath, { ...teresa, location: familyYard });
  docs.delete(objectPath);
  docs.set(runtimePath + root, { ...runtime, memories: [], relationships: [], openObjects: [], witnessedOccurrences: [] });
  docs.set(ref, { ...state(), currentLocation: familyYard, lastSequence: 15, revision: saved.revision + 1,
    worldTime: { ...campaign.worldTime, hour: 14 } });
  addHistory('posterior', 13);
  const abandonedTurn = { ...identity(), turnId: crypto.randomUUID(), declaredAction: 'Vou ao quintal.', advanceMinutes: 1 };
  docs.set(ref + '/turnReceipts/' + abandonedTurn.turnId, { untouched: true });
  const restore = request({ action: 'restore', checkpointId: saved.checkpointId });
  const restored = await mutate(restore);
  assert.notEqual(restored.timelineId, root);
  assert.equal(restored.revision, saved.revision + 2);
  assert.equal(state().lastSequence, 17);
  assert.equal(state().currentLocation, familyKitchen);
  assert.deepEqual(state().worldTime, campaign.worldTime);
  assert.deepEqual(docs.get(itemPath), item);
  assert.equal(docs.has(ref + '/inventory/posterior'), false);
  assert.deepEqual(docs.get(npcPath), teresa);
  assert.deepEqual(docs.get(objectPath), { ...placement, timelineId: restored.timelineId });
  assert.deepEqual(docs.get(runtimePath + restored.timelineId), { ...runtime,
    memories: runtime.memories!.map((entry) => ({ ...entry, timelineId: restored.timelineId })),
    relationships: runtime.relationships!.map((entry) => ({ ...entry, timelineId: restored.timelineId })),
  });
  assert.deepEqual(docs.get(ref + '/turnReceipts/' + abandonedTurn.turnId), { untouched: true });
  assert.deepEqual(await mutate(restore), restored);
  assert.equal(state().lastSequence, 17);
  await assert.rejects(mutate({ ...restore, requestId: crypto.randomUUID() }), /campanha mudou/i);
  await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, owner, abandonedTurn, async () => assert.fail()),
    /CONCURRENT_STATE_CONFLICT/);
  const dialogue = { ...identity(), turnId: crypto.randomUUID(), declaredAction: 'Converso com Teresa.', advanceMinutes: 1 };
  const narrate: Parameters<typeof persistPilotTurn>[4] = async (_at, _intent, scene, _relationships, history) => {
    assert.ok(scene.memories.some(({ memories }) => memories.some(({ fact }) => fact === 'Segredo anterior.')));
    assert.ok(history.some(({ id }) => id === 'antes'));
    assert.equal(history.some(({ id }) => id === 'posterior' || id === 'privado'), false);
    return 'Teresa escuta.';
  };
  const turn = await persistPilotTurn(db, freixoPlayableCatalog, owner, dialogue, narrate);
  assert.equal((await persistPilotTurn(db, freixoPlayableCatalog, owner, dialogue, async () => assert.fail())).narration,
    turn.narration);
  assert.deepEqual(await mutate(restore), restored);
  assert.notEqual(state().revision, restored.revision);
});

test('rejeita acesso, campanha, identidade reaproveitada e turno concorrente sem efeitos', async () => {
  const { owner, ref, docs, db, state, request, mutate, identity } = fixture();
  const save = request({ action: 'save', label: 'Cozinha', note: '' });
  const status = (expected: number) => (error: unknown) => error instanceof PilotCheckpointError && error.status === expected;
  await assert.rejects(mutate(save, 'outra-conta'), status(403));
  await assert.rejects(listPilotCheckpoints(db, 'outra-conta'), status(403));
  await assert.rejects(mutate({ ...save, campaignId: 'outra-campanha' }), status(403));
  await assert.rejects(mutate({ ...save, worldTime: {} }), status(400));
  const saved = await mutate(save);
  await assert.rejects(mutate({ ...save, label: 'Outro' }), status(409));
  const source = docs.get(ref + '/pilotCheckpoints/' + saved.checkpointId) as { checkpoint: object };
  docs.set(ref + '/pilotCheckpoints/externo', { ...source,
    checkpoint: { ...source.checkpoint, id: 'externo', campaignId: 'outra-campanha' } });
  await assert.rejects(mutate(request({ action: 'restore', checkpointId: 'externo' })), status(404));
  const turn = { ...identity(), turnId: crypto.randomUUID(), declaredAction: 'Vou ao quintal.', advanceMinutes: 1 };
  const restore = request({ action: 'restore', checkpointId: saved.checkpointId });
  await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, owner, turn, async () => {
    await mutate(restore);
    return 'A luz ilumina as pedras.';
  }), /CONCURRENT_STATE_CONFLICT/);
  assert.equal(state().currentLocation, familyKitchen);
  assert.equal(docs.has(ref + '/turnReceipts/' + turn.turnId), false);
});

test('revogação impede confirmação do turno que já começou e reenvio de checkpoint com recibo gravado', async () => {
  const { owner, ref, docs, db, state, request, identity } = fixture();
  const invitation = 'stagingAccess/pilot';
  docs.set(invitation, { ownerId: owner });
  const save = request({ action: 'save', label: 'Cozinha', note: '' });
  const saved = await mutatePilotCheckpoint(db, owner, save, true);
  const turn = { ...identity(), turnId: crypto.randomUUID(), declaredAction: 'Vou ao quintal.', advanceMinutes: 1 };
  await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, owner, turn, async () => {
    docs.delete(invitation);
    return 'A luz ilumina as pedras.';
  }, undefined, undefined, true), /CAMPAIGN_ACCESS_DENIED/);
  const before = [...docs.entries()];
  await assert.rejects(mutatePilotCheckpoint(db, owner, save, true), /Convite/);
  await assert.rejects(listPilotCheckpoints(db, owner, true), /Convite/);
  assert.deepEqual([...docs.entries()], before);
  assert.equal(state().revision, saved.revision);
  assert.equal(docs.has(ref + '/turnReceipts/' + turn.turnId), false);
});

test('projeção legada limita o volume da listagem mesmo com histórico longo e snapshots grandes', async (t) => {
  const { owner, docs, ref, mutate, request, identity } = fixture();
  const runtime = { holds: [], activities: [], observations: [{ npcId: 'teresa', subjectId: 'cozinha',
    fact: 'x'.repeat(475_000) }] };
  docs.set(ref + '/npcRoutineState/' + identity().baseTimelineId, runtime);
  const first = await mutate(request({ action: 'save', label: 'Cozinha', note: 'Amostra sintética' }));
  const savedPath = ref + '/pilotCheckpoints/';
  const initial = docs.get(savedPath + first.checkpointId) as { checkpoint: { id: string; lastSequence: number } };
  const snapshots = Array.from({ length: 30 }, (_, index) => {
    const id = 'amostra-' + index;
    const document = { ...initial, checkpoint: { ...initial.checkpoint, id, lastSequence: 100 + index }, runtime };
    docs.set(savedPath + id, document);
    return document;
  });
  for (let i = 0; i < 1500; i++) docs.set(ref + '/narrative/amostra-' + i, { sequence: i, content: 'Histórico sintético' });
  const before = Buffer.byteLength(JSON.stringify(snapshots));
  let after = 0;
  let reads = 0;
  const measured = memoryFirestore(docs, (kind, values) => {
    if (kind !== 'query') return;
    reads += values.length;
    after += Buffer.byteLength(JSON.stringify(values));
    assert.ok(values.every((value) => value && typeof value === 'object' &&
      Object.keys(value).length === 1 && 'checkpoint' in value));
  });
  const started = performance.now();
  const summaries = await listPilotCheckpoints(measured, owner);
  const elapsed = performance.now() - started;
  assert.equal(reads, 30);
  assert.equal(summaries[0].id, 'amostra-29');
  assert.ok(before > 14_000_000 && after < 30_000);
  let restoreWrites = 0;
  await mutatePilotCheckpoint(memoryFirestore(docs, (kind, values) => {
    if (kind === 'writes') restoreWrites += values.length;
  }), owner, request({ action: 'restore', checkpointId: first.checkpointId }));
  assert.equal(restoreWrites, 5);
  t.diagnostic(JSON.stringify({ snapshotDocuments: reads, fullJsonBytes: before, projectedJsonBytes: after,
    inMemoryMs: Math.round(elapsed * 100) / 100, processRssBytes: process.memoryUsage().rss, restoreWrites }));
});
