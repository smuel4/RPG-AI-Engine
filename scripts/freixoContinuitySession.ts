import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DocumentData, DocumentReference } from 'firebase-admin/firestore';
import { requestNarratorTurn } from '../src/services/narratorClient';
import type { Campaign, GameEvent, NarrativeEntry } from '../src/types/game';
import { advanceWorldTime } from '../src/engine/rulesEngine';
import { readCommittedTurn, turnDocumentIds, type TurnIdentity } from '../src/engine/turnIdentity';
import { villageWell } from '../src/engine/echoArcEncounters';
import { freixoWoodWorkshop } from '../src/engine/npcIdentity';
import { familyYard } from './echoArcFreeTurn';
import { familyKitchen } from './echoArcContinuityFixture';

export const continuitySecret = 'Tenho receio de atravessar a ponte sozinho.';
const block = 'demo-bloco-madeira';
const cabinet = 'demo-armario-cozinha';
const organized = 'demo-organizar-cozinha';
const phases: readonly (readonly [
  command: string, kind: string, minutes?: number, location?: string, narration?: RegExp,
][])[] = [
  [
    ['Examino o armário.', 'observation', 0, familyKitchen, /fechado/],
    ['Examino a bancada.', 'observation', 0, familyKitchen, /organizar/],
    ['Digo a Teresa: Bom dia.', 'speech'],
    ['Confidencio a Teresa: ' + continuitySecret, 'speech'],
    ['Vou ao poço.', 'travel', 6, villageWell],
    ['Examino o poço.', 'observation'],
    ['Digo a Lira: Bom dia.', 'speech'],
    ['Vou ao quintal.', 'travel', 4, familyYard],
    ['Observo o quintal.', 'observation'],
    ['Vou à cozinha.', 'travel', 2, familyKitchen],
  ],
  [
    ['Pego o bloco.', 'pickup'],
    ['Escancaro o armário.', 'open-close'],
    ['Guardo o bloco no armário.', 'store'],
    ['Fecho o armário.', 'open-close'],
    ['Abro o armário.', 'open-close'],
    ['Retiro o bloco do armário.', 'retrieve'],
    ['Fecho o armário.', 'open-close'],
    ['Organizo a bancada.', 'organize', 5],
    ['Vou à oficina.', 'travel', 6, freixoWoodWorkshop],
    ['Entrego o bloco para Henrique.', 'delivery'],
  ],
  [
    ['Henrique, o que eu te entreguei?', 'speech', 0, freixoWoodWorkshop, /Você me entregou/],
    ['Aguardo cinco minutos.', 'wait', 5],
    ['Deixo dois minutos passarem.', 'wait', 2],
    ['Vou ao quintal.', 'travel', 4, familyYard],
    ['Aguardo até as 11h.', 'wait', 26],
    ['Aguardo até as 11h34.', 'wait', 34],
    ['Henrique, no que você está trabalhando?', 'speech', 0, familyYard, /pausa no quintal/],
    ['Henrique, lembra do bloco que te entreguei?', 'speech', 0, familyYard, /bloco de madeira/],
    ['Observo Henrique.', 'observation'],
    ['Vou à cozinha.', 'travel', 2, familyKitchen],
  ],
  [
    ['Examino a bancada.', 'observation', 0, familyKitchen, /está organizada/],
    ['Teresa, lembra que organizei a bancada?', 'speech', 0, familyKitchen, /Vi você organizar/],
    ['Examino o armário.', 'observation', 0, familyKitchen, /fechado/],
    ['Conto a Teresa: Entreguei o bloco a Henrique.', 'speech'],
    ['Digo a Teresa: Obrigado.', 'speech'],
    ['Vou ao poço.', 'travel', 6, villageWell],
    ['Digo a Lira: Como vai?', 'speech'],
    ['Vou ao quintal.', 'travel', 4, familyYard],
    ['Henrique, como está a bancada da cozinha?', 'speech', 0, familyYard, /Não sei te dizer/],
    ['Digo a Henrique: Obrigado.', 'speech'],
  ],
];

export const continuityCollections = ['npcs', 'npcRoutineState', 'inventory', 'pilotObjectLocations',
  'turnReceipts', 'events', 'narrative'] as const;
type Collection = typeof continuityCollections[number];
export type ContinuitySnapshot = { campaign: Campaign; docs: Record<Collection, Record<string, DocumentData>> };
type Session = {
  read: () => Promise<ContinuitySnapshot>;
  send: (turn: TurnIdentity) => Promise<{ narration: string }>;
  log: (record: object) => void | Promise<void>;
};

export async function verifyFreixoContinuity({ read, send, log }: Session, limit: 4 | 40) {
  const start = performance.now();
  const initial = await read();
  const entries = phases.flat().slice(0, limit);
  const timeline = initial.campaign.activeTimelineId ?? 'tl_root';
  const { campaign: { id: campaignId, ownerId } } = initial;
  const npc = (name: string) => Object.entries(initial.docs.npcs).find(([, value]) => value.name === name)![0];
  const teresa = npc('Teresa');
  const henrique = npc('Henrique');
  const lira = npc('Lira');
  let accepted = 0;
  let refused = 0;
  let replayed = 0;
  let step = 'estado inicial';
  let after = initial;
  const history = new Map<number, { turn: TurnIdentity; narration: string; sequence: number }>();
  const newTurn = (declaredAction: string): TurnIdentity => ({ campaignId, declaredAction, advanceMinutes: 10,
    turnId: randomUUID(), expectedRevision: after.campaign.revision, baseTimelineId: timeline });
  const summarize = ({ campaign, docs }: ContinuitySnapshot) => ({
    revision: campaign.revision, time: campaign.worldTime, location: campaign.currentLocation,
    inventory: Object.keys(docs.inventory), block: docs.pilotObjectLocations[block] &&
      { containerId: docs.pilotObjectLocations[block].containerId, npcId: docs.pilotObjectLocations[block].npcId },
    npcs: Object.values(docs.npcs).map(({ name, location }) => ({ name, location })),
    openObjects: docs.npcRoutineState[timeline]?.openObjects ?? [],
    completedActivities: docs.npcRoutineState[timeline]?.completedActivities ?? [],
  });
  const refusal = async (command: string, code: string) => {
    step = 'recusa após turno ' + accepted + ' — ' + command;
    await assert.rejects(send(newTurn(command)), { code });
    refused++;
    assert.deepEqual(await read(), after, 'recusa alterou o estado');
    await log({ type: 'refused', afterTurn: accepted, command, code, checks: ['estado integral preservado'] });
  };
  const replay = async (number: number) => {
    step = 'replay do turno ' + number + ' após turno ' + accepted;
    const entry = history.get(number)!;
    assert.equal((await send(entry.turn)).narration, entry.narration);
    replayed++;
    assert.deepEqual(await read(), after, 'replay alterou o estado');
    await log({ type: 'replay', originalTurn: number, afterTurn: accepted, checks: ['mesma narração', 'estado integral preservado'] });
  };
  try {
    assert.equal(entries.length, limit);
    assert.equal(initial.campaign.currentLocation, familyKitchen);
    assert.equal(initial.campaign.worldTime.hour, 10);
    assert.equal(initial.campaign.worldTime.minute, 0);
    assert.deepEqual(Object.keys(initial.docs.turnReceipts), []);
    assert.deepEqual(Object.keys(initial.docs.inventory), []);
    assert.deepEqual(Object.keys(initial.docs.pilotObjectLocations), []);
    await log({ type: 'initial', limit, state: summarize(initial) });
    for (const [index, [command, kind, minutes = 0, destination, narration]] of entries.entries()) {
      const number = index + 1;
      step = 'turno ' + number + ' — ' + command;
      const before = after;
      const turn = newTurn(command);
      const result = await send(turn);
      accepted++;
      after = await read();
      const { campaign, docs } = after;
      const ids = await turnDocumentIds(turn);
      const receipt = docs.turnReceipts[turn.turnId];
      const event = docs.events[ids.event] as GameEvent;
      const player = docs.narrative[ids.player] as NarrativeEntry;
      const engine = docs.narrative[ids.engine] as NarrativeEntry;
      const expectedLocation = destination ?? before.campaign.currentLocation;
      const changed = continuityCollections.filter((name) => !isDeepStrictEqual(before.docs[name], docs[name]));
      await log({ type: 'turn', number, phase: 'ABCD'[Math.floor(index / 10)], command, turnId: turn.turnId,
        plan: receipt?.plan?.kind ?? receipt?.plan?.intent?.kind, event: ids.event, sequence: event?.sequence,
        changes: changed, state: summarize(after), narration: result.narration });
      assert.equal(campaign.revision, initial.campaign.revision + number);
      assert.equal(campaign.lastSequence, initial.campaign.lastSequence + number * 3);
      assert.equal(campaign.currentLocation, expectedLocation);
      assert.deepEqual(campaign.worldTime, advanceWorldTime(before.campaign.worldTime, minutes));
      assert.equal(receipt.plan.kind ?? receipt.plan.intent.kind, kind);
      assert.deepEqual(receipt.outcome, { location: expectedLocation, elapsedMinutes: minutes });
      assert.equal(receipt.resolution.completed, true);
      assert.equal(receipt.playerEntryId, ids.player);
      assert.deepEqual(receipt.turn, turn);
      assert.equal(Object.keys(docs.turnReceipts).length, number);
      assert.equal(Object.keys(docs.events).length, Object.keys(initial.docs.events).length + number);
      assert.equal(Object.keys(docs.narrative).length, Object.keys(initial.docs.narrative).length + number * 2);
      for (const [name, newIds] of [
        ['turnReceipts', new Set([turn.turnId])], ['events', new Set([ids.event])],
        ['narrative', new Set([ids.player, ids.engine])],
      ] as const) {
        const previous = Object.fromEntries(Object.entries(docs[name]).filter(([id]) =>
          !newIds.has(id)));
        assert.deepEqual(previous, before.docs[name], 'Histórico anterior foi alterado em ' + name);
      }
      assert.equal(event.sequence, campaign.lastSequence);
      assert.equal(readCommittedTurn(turn, ownerId, event, player, engine)?.content, result.narration);
      history.set(number, { turn, narration: result.narration, sequence: event.sequence });

      const runtime = docs.npcRoutineState[timeline];
      assert.equal(docs.inventory[block]?.quantity, [11, 12, 16, 17, 18, 19].includes(number) ? 1 : undefined);
      assert.equal(docs.pilotObjectLocations[block]?.containerId, number >= 13 && number <= 15 ? cabinet : undefined);
      assert.equal(docs.pilotObjectLocations[block]?.npcId, number >= 20 ? henrique : undefined);
      assert.deepEqual(runtime?.openObjects ?? [], [12, 13, 15, 16].includes(number) ? [cabinet] : []);
      assert.deepEqual(runtime?.completedActivities ?? [], number >= 18 ? [organized] : []);
      assert.equal(docs.npcs[henrique].location, number >= 26 ? familyYard : freixoWoodWorkshop);
      assert.equal(docs.npcs[teresa].location, familyKitchen);
      assert.equal(docs.npcs[lira].location, villageWell);
      for (const [sourceTurn, npcId, provenance, fact] of [
        [4, teresa, 'reported', continuitySecret],
        [18, teresa, 'observed', 'Viu Samuel organizar a bancada.'],
        [20, henrique, 'participated', 'Recebeu de Samuel o item “bloco de madeira”.'],
        [34, teresa, 'reported', 'Entreguei o bloco a Henrique.'],
      ] as const) {
        if (number < sourceTurn) continue;
        const source = history.get(sourceTurn)!;
        const memories = runtime.memories.filter((memory: DocumentData) => memory.fact === fact);
        assert.equal(memories.length, 1, 'Memória ausente ou duplicada no turno de origem ' + sourceTurn);
        assert.partialDeepStrictEqual(memories[0], { npcId, timelineId: timeline, turnId: source.turn.turnId,
          sequence: source.sequence, origin: { kind: provenance } });
      }
      if (number >= 4) {
        assert.equal(runtime.relationships.find((relation: DocumentData) => relation.from === teresa)
          ?.disclosure?.turnId, history.get(4)!.turn.turnId);
        const original = await turnDocumentIds(history.get(4)!.turn);
        assert.equal(docs.narrative[original.player].privateRecipientId, teresa);
        assert.equal(docs.narrative[original.engine].privateRecipientId, teresa);
      }
      if (number >= 5) assert.equal(runtime.relationships.find((relation: DocumentData) => relation.from === lira)
        ?.firstEncounter?.turnId, history.get(5)!.turn.turnId);
      await log({ type: 'state-checks', number, checks: ['revisão', 'relógio', 'local', 'histórico', 'evento',
        'recibo', 'posse', 'ambiente', 'NPCs', 'memórias e relacionamentos aplicáveis'],
        newMemories: (runtime?.memories ?? []).filter(({ turnId }: DocumentData) => turnId === turn.turnId)
          .map(({ npcId, fact, origin, sequence }: DocumentData) => ({ npc: docs.npcs[npcId]?.name, fact, origin, sequence })),
      });
      if (narration) assert.match(result.narration, narration);
      if (number !== 4) assert.ok(!result.narration.includes(continuitySecret), 'confidência reapareceu na prosa');
      await log({ type: 'narrative-checks', number, factualCheck: Boolean(narration), secretAbsent: number !== 4 });
      if (number === 4) {
        await refusal('Deixo o bloco.', 'PILOT_OBJECT_NOT_HELD');
        await replay(4);
      }
      if (number === 14) await refusal('Retiro o bloco do armário.', 'PILOT_STORAGE_CLOSED');
      if (number === 24) await refusal('Aguardo sessenta e um minutos.', 'PILOT_WAIT_UNAVAILABLE');
      if (number === 33) await refusal('Organizo a bancada.', 'PILOT_ENVIRONMENT_ALREADY_ORGANIZED');
      if (number === 40) {
        await replay(4);
        await replay(20);
        await replay(26);
      }
    }
  } catch (error) {
    await log({ type: 'first-divergence', step, message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await log({ type: 'summary', limit, accepted, refused, replayed, elapsedMs: Math.round(performance.now() - start),
      final: summarize(after) });
  }
}

export async function runFreixoContinuityHttp(ref: DocumentReference, token: string, limit: 4 | 40,
  log: Session['log']) {
  await verifyFreixoContinuity({
    read: async () => {
      const campaign = (await ref.get()).data() as Campaign;
      const docs = await Promise.all(continuityCollections.map(async (name) =>
        [name, Object.fromEntries((await ref.collection(name).get()).docs.map((doc) => [doc.id, doc.data()]))] as const));
      return { campaign, docs: Object.fromEntries(docs) as ContinuitySnapshot['docs'] };
    },
    send: ({ campaignId, declaredAction, advanceMinutes, ...turn }) =>
      requestNarratorTurn(token, { campaignId, declaredAction, advanceMinutes, turn }),
    log,
  }, limit);
}
