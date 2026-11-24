import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryFirestore } from '../scripts/freixoEvaluationStore';
import { persistPilotTurn, PilotTurnError, SERVER_PILOT_ID } from '../server/persistPilotTurn';
import { issuePilotClarification, readPilotClarification } from '../server/pilotClarification';
import { describePilotFeedback } from '../server/pilotFeedback';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { advanceWorldTime, buildCheckpointPayload, prepareCheckpointRestore } from '../src/engine/rulesEngine';
import { readPilotScene } from '../server/pilotScene';
import { turnDocumentIds } from '../src/engine/turnIdentity';
import { createWellEncounterNpc, villageWell } from '../src/engine/echoArcEncounters';
import { freixoWoodWorkshop } from '../src/engine/npcIdentity';
import type { NpcRoutineState } from '../src/engine/npcRoutine';
import { buildNarratorContext } from '../server/narratorMemory';
import { buildNarratorPrompt, NarratorFailure } from '../server/narratorProvider';
import { claimsUnconfirmedPlayerConsequence } from '../server/pilotNarrativeIntegrity';
import { familyKitchen } from '../scripts/echoArcContinuityFixture';
import { familyYard, freixoPlayableCatalog } from '../scripts/echoArcFreeTurn';
import { requestNarratorTurn } from '../src/services/narratorClient';
import { freixoWoodland } from '../src/world/freixo';
import { continuityCollections, continuitySecret, verifyFreixoContinuity,
  type ContinuitySnapshot } from '../scripts/freixoContinuitySession';

test('Henrique oferece conversa na pausa, com replay e continuidade pelo corte do checkpoint', async () => {
  const owner = 'dono';
  const bundle = createEchoArcBundle(owner);
  const campaign = { ...bundle.campaign, id: SERVER_PILOT_ID, currentLocation: familyYard,
    worldTime: advanceWorldTime({ ...bundle.campaign.worldTime, hour: 11, minute: 29 }, 0) };
  const henrique = { ...bundle.npcs[1], campaignId: campaign.id, location: freixoWoodWorkshop };
  const path = 'campaigns/' + campaign.id;
  const npcPath = path + '/npcs/' + henrique.id;
  const docs = new Map<string, object>([[path, campaign], [npcPath, henrique]]);
  const db = memoryFirestore(docs);
  const state = () => docs.get(path) as typeof campaign;
  const npc = () => docs.get(npcPath) as typeof henrique;
  const next = (declaredAction: string) => ({ campaignId: campaign.id, turnId: crypto.randomUUID(),
    baseTimelineId: state().activeTimelineId ?? 'tl_root', expectedRevision: state().revision, advanceMinutes: 10, declaredAction });
  const fixed = async () => 'A luz ilumina as pedras.';
  const noNarration = async () => assert.fail('A espera ou consulta factual dispensa o narrador.');
  const send = (turn: ReturnType<typeof next>, narrate: Parameters<typeof persistPilotTurn>[4] = noNarration) =>
    persistPilotTurn(db, freixoPlayableCatalog, owner, turn, narrate);
  const cue = /Henrique faz um aceno do quintal/u;
  const snapshot = () => structuredClone([...docs]);
  const checkpoint = (label: string) => {
    const built = buildCheckpointPayload(state(), [], [npc()], label, '');
    assert.ok(built.ok);
    return built.data.checkpoint;
  };
  const restore = (saved: ReturnType<typeof checkpoint>) => {
    const restored = prepareCheckpointRestore(state(), saved, [], [npc()]);
    assert.ok(restored.ok);
    const plan = restored.data;
    docs.set(path, { ...state(), ...plan.restoredState, revision: plan.nextRevision,
      lastSequence: plan.nextLastSequence, activeTimelineId: plan.nextTimelineId, timelineLineage: plan.nextTimelineLineage });
    docs.set(npcPath, { ...npc(), location: saved.npcsSnapshot[0].location });
    docs.set(path + '/narrative/' + plan.narrativeEntry.id, plan.narrativeEntry);
    docs.set(path + '/events/' + plan.event.id, plan.event);
  };

  const initial = snapshot();
  assert.deepEqual((await readPilotScene(db, freixoPlayableCatalog, owner))?.people, []);
  assert.deepEqual(snapshot(), initial);
  for (const [location, hour, minute, holds] of [
    [familyKitchen, 11, 29, []],
    [familyYard, 13, 0, []],
    [familyYard, 11, 29, [{ npcId: henrique.id, reason: 'commitment',
      until: { ...campaign.worldTime, hour: 12, minute: 0 } }]],
  ] as const) {
    const fixture = new Map<string, object>([[path, { ...campaign, currentLocation: location,
      worldTime: { ...campaign.worldTime, hour, minute } }], [npcPath, henrique],
      [path + '/npcRoutineState/' + next('').baseTimelineId, { activities: [], observations: [], holds }]]);
    const result = await persistPilotTurn(memoryFirestore(fixture), freixoPlayableCatalog, owner,
      next('Espero seis minutos.'), noNarration);
    assert.doesNotMatch(result.narration, cue);
  }
  const privateTurn = next('Vou ao quintal e converso com Henrique.');
  const privateFixture = new Map<string, object>([
    [path, { ...campaign, currentLocation: familyKitchen, worldTime: advanceWorldTime(campaign.worldTime, 6) }],
    [npcPath, { ...henrique, location: familyYard }],
  ]);
  const privateResult = await persistPilotTurn(memoryFirestore(privateFixture), freixoPlayableCatalog, owner, privateTurn, fixed);
  const privateIds = await turnDocumentIds(privateTurn);
  assert.doesNotMatch(privateResult.narration, cue);
  assert.equal((privateFixture.get(path + '/narrative/' + privateIds.engine) as { privateRecipientId: string })
    .privateRecipientId, henrique.id);
  assert.doesNotMatch((await send(next('Como chego ao poço?'))).narration, cue);
  assert.deepEqual(state().worldTime, campaign.worldTime);
  assert.equal(npc().location, freixoWoodWorkshop);
  const before = checkpoint('Antes da pausa');
  assert.doesNotMatch((await send(next('Espero um minuto.'))).narration, cue);
  const trigger = next('Espero cinco minutos.');
  const event = await send(trigger);
  assert.match(event.narration, cue);
  assert.equal(npc().location, familyYard);
  assert.deepEqual(state().worldTime, advanceWorldTime(campaign.worldTime, 6));
  const ids = await turnDocumentIds(trigger);
  assert.equal((docs.get(path + '/narrative/' + ids.player) as { content: string }).content, trigger.declaredAction);
  const response = docs.get(path + '/narrative/' + ids.engine) as { privateRecipientId?: string; content: string };
  assert.equal(response.privateRecipientId, undefined);
  assert.equal(response.content, event.narration);
  assert.deepEqual(state().protagonist, campaign.protagonist);
  assert.deepEqual(state().currency, campaign.currency);
  assert.equal([...docs.keys()].some((key) => key.includes('/inventory/')), false);
  const committed = snapshot();
  assert.equal((await send(trigger)).narration, event.narration);
  assert.deepEqual(snapshot(), committed);
  const after = checkpoint('Depois da pausa');
  assert.doesNotMatch((await send(next('Espero um minuto.'))).narration, cue);
  assert.doesNotMatch((await send(next('Vou ao poço.'), fixed)).narration, cue);
  restore(after);
  assert.doesNotMatch((await send(next('Espero um minuto.'))).narration, cue);
  restore(before);
  assert.match((await send(next('Espero seis minutos.'))).narration, cue);
  assert.doesNotMatch((await send(next('Henrique, o que você está fazendo?'))).narration, cue);
  assert.doesNotMatch((await send(next('Converso com Henrique sobre a oficina.'), async (_campaign, _intent, scene) => {
    assert.deepEqual(scene.npcs.map(({ id }) => id), [henrique.id]);
    return 'Henrique escuta.';
  })).narration, cue);
});

test('exploração distingue localização, consulta, conversa e destinos indisponíveis', async () => {
  const owner = 'dono';
  const bundle = createEchoArcBundle(owner);
  const campaign = { ...bundle.campaign, id: SERVER_PILOT_ID, currentLocation: familyKitchen };
  const [teresa] = bundle.npcs;
  const lira = createWellEncounterNpc(owner, campaign.id);
  const path = 'campaigns/' + campaign.id;
  const docs = new Map<string, object>([[path, campaign], [path + '/npcs/' + lira.id, lira],
    [path + '/npcs/' + teresa.id, { ...teresa, campaignId: campaign.id, location: familyKitchen }]]);
  const db = memoryFirestore(docs);
  const catalog = freixoPlayableCatalog;
  const state = () => docs.get(path) as typeof campaign;
  const send = (declaredAction: string, narrate: Parameters<typeof persistPilotTurn>[4] = async () => 'A luz ilumina as pedras.',
    activeCatalog: Parameters<typeof persistPilotTurn>[1] = catalog) =>
    persistPilotTurn(db, activeCatalog, owner, {
      campaignId: campaign.id, turnId: crypto.randomUUID(), baseTimelineId: state().activeTimelineId || 'tl_root',
      expectedRevision: state().revision, advanceMinutes: 10, declaredAction,
    }, narrate);
  const factual = async () => assert.fail('Consulta factual chamou o narrador.');
  const start = state();
  await assert.rejects(send('Quero conversar com Lira.'), { code: 'PILOT_SPEECH_UNAVAILABLE', absentNpcName: 'Lira' });
  await assert.rejects(send('Quero explorar o castelo.'), { code: 'PILOT_TRAVEL_UNAVAILABLE', reason: 'unknown-destination' });
  await assert.rejects(send('Vou ao poço ou à oficina.'), { code: 'PILOT_TRAVEL_UNAVAILABLE', reason: 'ambiguous-destination' });
  await assert.rejects(send('Vou ao poço.', factual, { ...catalog, routes: [] }),
    { code: 'PILOT_TRAVEL_UNAVAILABLE', reason: 'unknown-route' });
  assert.equal(state(), start);
  assert.match((await send('Onde posso encontrar Lira?', factual)).narration, /nem confirmar onde/);
  assert.match((await send('Será que existe um caminho para o castelo?', factual)).narration, /não reconhece/);
  assert.match((await send('Como chego ao poço?', factual)).narration, /caminho acessível.*6 min/);
  assert.equal(state().currentLocation, familyKitchen);
  assert.deepEqual(state().worldTime, start.worldTime);
  await send('Confidencio a Teresa: ' + continuitySecret);
  await send('Pergunto a Teresa o que ela sabe sobre a vila.', async (_scene, _intent, present, _relations, _history, action) => {
    assert.deepEqual(present.npcs.map(({ id }) => id), [teresa.id]);
    assert.match(action, /sobre a vila/);
    return 'Teresa escuta.';
  });
  await send('Quero explorar o poço.');
  assert.equal(state().currentLocation, villageWell);
  assert.deepEqual(state().worldTime, advanceWorldTime(start.worldTime, 6));
  assert.match((await send('Onde posso encontrar Lira?', factual)).narration, /Lira está aqui/);
  await send('Examino o poço.');
  await send('Dou uma olhada nos arredores.');
  await send('Quero conversar com Lira.');
  const turn = { campaignId: campaign.id, turnId: crypto.randomUUID(), baseTimelineId: state().activeTimelineId || 'tl_root',
    expectedRevision: state().revision, advanceMinutes: 10, declaredAction: 'Converso com Lira sobre o poço.' };
  const dialogue = await persistPilotTurn(db, catalog, owner, turn, async (_scene, intent, present, _relations, history, action) => {
    assert.deepEqual(present.npcs.map(({ id }) => id), [lira.id]);
    assert.match(intent, /discurso indireto/);
    assert.match(action, /sobre o poço/);
    assert.ok(!JSON.stringify({ present, history }).includes(continuitySecret));
    return 'Lira escuta.';
  });
  const after = structuredClone([...docs]);
  assert.equal((await persistPilotTurn(db, catalog, owner, turn, factual)).narration, dialogue.narration);
  assert.deepEqual(structuredClone([...docs]), after);
  assert.equal(state().currentLocation, villageWell);
  assert.deepEqual(state().worldTime, advanceWorldTime(start.worldTime, 6));
  docs.set(path, { ...state(), setting: 'A história local menciona o castelo.' });
  await assert.rejects(send('Vou ao castelo.'), { code: 'PILOT_TRAVEL_UNAVAILABLE', reason: 'uncatalogued-destination' });
  const journey = { ...turn, turnId: crypto.randomUUID(), expectedRevision: state().revision,
    declaredAction: 'Vou ao bosque da vila.' };
  const arrived = await persistPilotTurn(db, catalog, owner, journey, async (_scene, _intent, present, _relations, history) => {
    assert.deepEqual(present.npcs, []);
    assert.ok(!JSON.stringify({ present, history }).includes(continuitySecret));
    return 'Folhas secas cobrem o chão.';
  });
  assert.equal(state().currentLocation, freixoWoodland);
  assert.deepEqual(state().worldTime, advanceWorldTime(start.worldTime, 11));
  assert.equal((await persistPilotTurn(db, catalog, owner, journey, factual)).narration, arrived.narration);
  assert.match((await send('Examino o marco.')).narration, /marco de pedra coberto de musgo/);
  assert.deepEqual(state().worldTime, advanceWorldTime(start.worldTime, 11));
  await assert.rejects(send('Pego o marco.'), { code: 'PILOT_OBJECT_FIXED' });
  await send('Vou ao poço.');
  assert.equal(state().currentLocation, villageWell);
  assert.deepEqual(state().worldTime, advanceWorldTime(start.worldTime, 16));
});

test('baseline natural preserva intenção, local e relógio no piloto', async () => {
  const owner = 'dono';
  const { campaign: seed } = createEchoArcBundle(owner);
  const campaign = { ...seed, id: SERVER_PILOT_ID, currentLocation: familyKitchen };
  const path = 'campaigns/' + campaign.id;
  const lira = createWellEncounterNpc(owner, campaign.id);
  const corpus = [
    ['executável', familyYard, 'Volto ao poço.', villageWell, 4],
    ['executável', freixoWoodland, 'Quero retornar para o poço.', villageWell, 5],
    ['executável', familyYard, 'Vou até a oficina.', freixoWoodWorkshop, 4],
    ['executável', villageWell, 'Quero conversar com Lira.', villageWell, 0],
    ['consulta', villageWell, 'Será que consigo ir ao bosque?', villageWell, 0],
    ['executável', familyKitchen, 'Aguardo cinco minutos.', familyKitchen, 5],
    ['executável', familyKitchen, 'Abro o armário.', familyKitchen, 0],
    ['executável', freixoWoodland, 'Examino o marco.', freixoWoodland, 0],
    ['contextual', freixoWoodland, 'Examino aquele marco.', freixoWoodland, 0],
    ['composta', familyKitchen, 'Vou ao poço e converso com Lira.', villageWell, 6],
    ['impedida', familyKitchen, 'Quero conversar com Lira.', 'PILOT_SPEECH_UNAVAILABLE'],
    ['impedida', familyKitchen, 'Vou ao bosque e converso com Lira.', 'PILOT_SPEECH_UNAVAILABLE'],
    ['fora do catálogo', familyKitchen, 'Vou ao castelo.', 'PILOT_TRAVEL_UNAVAILABLE', 'unknown-destination'],
    ['fora do catálogo', familyKitchen, 'Pego o cetro.', 'PILOT_OBJECT_UNREGISTERED'],
    ['ambígua', familyKitchen, 'Vou ao poço ou à oficina.', 'PILOT_TRAVEL_UNAVAILABLE', 'ambiguous-destination'],
    ['fora da mecânica', familyKitchen, 'Lanço uma magia.', 'PILOT_ACTION_UNSUPPORTED'],
    ['não reconhecida', familyYard, 'Bato perna rumo ao poço.', 'PILOT_ACTION_UNSUPPORTED'],
    ['negativa', familyKitchen, 'Não quero sair daqui.', 'PILOT_ACTION_UNSUPPORTED'],
    ['hipótese', familyKitchen, 'Se eu voltar ao poço.', 'PILOT_ACTION_UNSUPPORTED'],
  ] as const;
  for (const [category, location, declaredAction, expected, detail] of corpus) {
    const docs = new Map<string, object>([[path, { ...campaign, currentLocation: location }], [path + '/npcs/' + lira.id, lira]]);
    const db = memoryFirestore(docs);
    const current = () => docs.get(path) as typeof campaign;
    const send = async (action: string) => persistPilotTurn(db, freixoPlayableCatalog, owner, {
      campaignId: campaign.id, turnId: crypto.randomUUID(), baseTimelineId: current().activeTimelineId ?? 'tl_root',
      expectedRevision: current().revision, advanceMinutes: 10, declaredAction: action,
    }, async () => 'A luz ilumina as pedras.');
    if (category === 'contextual') await send('Examino o marco.');
    const before = structuredClone([...docs]);
    const initialTime = current().worldTime;
    if (typeof detail === 'number') {
      const result = await send(declaredAction);
      assert.equal(current().currentLocation, expected, declaredAction);
      assert.deepEqual(current().worldTime, advanceWorldTime(initialTime, detail), declaredAction);
      if (category === 'consulta') assert.match(result.narration, /5 min/);
      if (category === 'contextual') assert.match(result.narration, /marco de pedra coberto de musgo/);
    } else {
      await assert.rejects(send(declaredAction), { code: expected, ...(detail ? { reason: detail } : {}) }, declaredAction);
      assert.deepEqual([...docs], before, declaredAction);
    }
  }
});

test('perguntas e hipóteses não autorizam efeitos antes da confirmação do jogador', async () => {
  const owner = 'dono';
  const { campaign: seed, npcs: [teresa, henrique] } = createEchoArcBundle(owner);
  const campaign = { ...seed, id: SERVER_PILOT_ID, currentLocation: familyKitchen };
  const path = 'campaigns/' + campaign.id;
  const lira = createWellEncounterNpc(owner, campaign.id);
  const docs = new Map<string, object>([[path, campaign],
    ...[teresa, henrique, lira].map((npc) => [path + '/npcs/' + npc.id, { ...npc, campaignId: campaign.id,
      location: npc === teresa ? familyKitchen : npc === henrique ? freixoWoodWorkshop : villageWell }] as const)]);
  const db = memoryFirestore(docs);
  const state = () => docs.get(path) as typeof campaign;
  const noNarration = async () => assert.fail('Consulta factual ou recusa chamou o narrador.');
  const send = (declaredAction: string, narrate: Parameters<typeof persistPilotTurn>[4] = noNarration) =>
    persistPilotTurn(db, freixoPlayableCatalog, owner, {
      campaignId: campaign.id, turnId: crypto.randomUUID(), baseTimelineId: state().activeTimelineId ?? 'tl_root',
      expectedRevision: state().revision, advanceMinutes: 10, declaredAction,
    }, narrate);
  const before = structuredClone([...docs]);
  for (const text of [
    'Pego o bloco?', 'Posso pegar o bloco?', 'Abro o armário?', 'Vou ao poço?', 'Converso com Teresa?',
    'Poderia guardar o bloco no armário', 'Espero dez minutos？!', 'Como você está?', 'Queria saber como está a vila?',
  ]) await assert.rejects(send(text), { code: 'PILOT_INTENT_CLARIFICATION' }, text);
  for (const text of [
    'Talvez eu pegue o bloco.', 'E se eu fosse ao bosque?', 'Não quero pegar o bloco.', 'Eu talvez espere um pouco?',
  ]) await assert.rejects(send(text), { code: 'PILOT_ACTION_UNSUPPORTED' }, text);
  await assert.rejects(send('Vou ao poço; posso pegar o bloco?'), { code: 'PILOT_INTENT_CLARIFICATION', step: 2 });
  await assert.rejects(send('Posso pegar o bloco?; vou ao poço.'), { code: 'PILOT_INTENT_CLARIFICATION', step: 1 });
  await assert.rejects(send('Vou ao poço; dá para chegar ao bosque?'), { code: 'PILOT_SEQUENCE_NEEDS_REPLY', step: 2 });
  assert.deepEqual(structuredClone([...docs]), before);

  assert.match((await send('Dá para chegar ao poço?')).narration, /caminho acessível.*6 min/u);
  assert.match((await send('É possível chegar à oficina por aqui?')).narration, /caminho acessível.*6 min/u);
  assert.match((await send('Onde está Henrique?')).narration, /nem confirmar onde/u);
  assert.equal(state().currentLocation, familyKitchen);
  assert.deepEqual(state().worldTime, campaign.worldTime);
  assert.equal(docs.has(path + '/inventory/demo-bloco-madeira'), false);
  assert.equal([...docs.values()].some((doc) => 'privateRecipientId' in doc), false);

  let addressed: string | undefined;
  const controlledSpeech = async (_scene: unknown, _intent: string, present: { npcs: { name: string }[] }) => {
    addressed = present.npcs[0]?.name;
    return 'A conversa segue em tom tranquilo.';
  };
  await send('Converso com Teresa.', controlledSpeech);
  assert.equal(addressed, 'Teresa');
  await send('Pergunto a Teresa se posso sair.', controlledSpeech);
  await send('Pego o bloco.');
  assert.equal(docs.has(path + '/inventory/demo-bloco-madeira'), true);
  await send('Vou ao poço.', async () => 'A luz ilumina as pedras.');
  assert.equal(state().currentLocation, villageWell);
  await send('Converso com Lira sobre o poço.', controlledSpeech);
  assert.equal(addressed, 'Lira');
  await send('Vou até a oficina.', async () => 'A luz ilumina a oficina.');
  await send("Digo a Henrique: 'Posso ajudar na oficina?'", controlledSpeech);
  const explicit = [...docs.values()].find((doc) => 'plan' in doc &&
    JSON.stringify(doc.plan).includes("'Posso ajudar na oficina?'"));
  assert.ok(explicit);
  assert.equal(state().currentLocation, freixoWoodWorkshop);
  assert.deepEqual(state().worldTime, advanceWorldTime(campaign.worldTime, 14));
});

test('oferta de Teresa é visível, privada e responde uma vez à decisão de Samuel', async (t) => {
  for (const [decision, command] of [
    ['accepted', 'Aceito a companhia.'],
    ['accepted', 'Teresa, pode vir comigo.'],
    ['accepted', 'Pode me acompanhar, mãe.'],
    ['accepted', 'Quero que você venha comigo.'],
    ['accepted', 'Sim, vamos juntos.'],
    ['declined', 'Teresa, não aceito.'],
    ['pending', null],
  ] as const) {
    await t.test(command ?? decision, async () => {
      const owner = 'dono';
      const bundle = createEchoArcBundle(owner);
      const campaign = { ...bundle.campaign, id: SERVER_PILOT_ID, currentLocation: familyKitchen,
        activeTimelineId: 'tl_playtest_' + decision };
      const [teresa, henrique] = bundle.npcs;
      const path = 'campaigns/' + campaign.id;
      const timeline = campaign.activeTimelineId ?? 'tl_root';
      const docs = new Map<string, object>([[path, campaign], ...[teresa, henrique].map((npc) =>
        [path + '/npcs/' + npc.id, { ...npc, campaignId: campaign.id, location: familyKitchen }] as const)]);
      const db = memoryFirestore(docs);
      const state = () => docs.get(path) as typeof campaign;
      const runtime = (id = timeline) => docs.get(path + '/npcRoutineState/' + id) as NpcRoutineState | undefined;
      const next = (declaredAction: string) => ({ turnId: crypto.randomUUID(), campaignId: campaign.id,
        declaredAction, advanceMinutes: 10, expectedRevision: state().revision, baseTimelineId: timeline });
      const fixed = async () => 'A conversa segue em tom tranquilo.';
      const noGeneration = async () => assert.fail('A resposta social deve ser confirmada pela engine.');
      const trace = (entry: object) => {
        if (process.env.ECHO_SOCIAL_TRACE === '1') console.info(JSON.stringify({ scenario: decision, ...entry }));
      };
      const send = async (turn: ReturnType<typeof next>, narrate: Parameters<typeof persistPilotTurn>[4] = fixed) => {
        const before = runtime()?.bridgeOffer?.status ?? 'none';
        const replay = docs.has(path + '/turnReceipts/' + turn.turnId);
        try {
          const result = await persistPilotTurn(db, freixoPlayableCatalog, owner, turn, narrate);
          trace({ command: turn.declaredAction, replay, shown: result.narration, before,
            after: runtime()?.bridgeOffer?.status ?? 'none', time: state().worldTime, location: state().currentLocation });
          return result;
        } catch (error) {
          trace({ command: turn.declaredAction, before, after: runtime()?.bridgeOffer?.status ?? 'none',
            feedback: error instanceof PilotTurnError ? describePilotFeedback(error, false) : undefined });
          throw error;
        }
      };
      const beforeInvalid = structuredClone([...docs]);
      await assert.rejects(send(next('Aceito a companhia.')), { code: 'PILOT_BRIDGE_OFFER_UNAVAILABLE' });
      assert.deepEqual(structuredClone([...docs]), beforeInvalid);
      await send(next('Quero conversar com Teresa.'));
      assert.equal((await send(next('Teresa, pode vir comigo.'))).narration, await fixed());
      assert.equal(runtime()?.bridgeOffer, undefined);
      await send(next('Confidencio a Teresa: ' + continuitySecret));
      assert.equal(runtime()?.bridgeOffer, undefined);
      const offer = next('Quero conversar com Teresa.');
      const offered = await send(offer, noGeneration);
      assert.match(offered.narration, /posso atravessar a ponte com você/);
      const offerEntry = await turnDocumentIds(offer);
      assert.partialDeepStrictEqual(docs.get(path + '/narrative/' + offerEntry.engine),
        { content: offered.narration, privateRecipientId: teresa.id });
      const pending = { id: offer.turnId, npcId: teresa.id, recipientId: 'player', status: 'pending' };
      assert.deepEqual(runtime()?.bridgeOffer, pending);
      assert.deepEqual(await send(offer, noGeneration), offered);
      const duplicate = await send(next('Quero conversar com Teresa.'), async (_scene, intent) => {
        assert.match(intent, /aguarda resposta de Samuel/);
        return fixed();
      });
      assert.doesNotMatch(duplicate.narration, /posso atravessar a ponte/);
      if (decision === 'pending') {
        const beforeDefer = state();
        await send(next('Vou pensar.'), noGeneration);
        for (const uncertain of ['Teresa, talvez eu aceite.', 'Talvez você possa vir comigo.',
          'E se você viesse comigo?', 'Vou pensar melhor.', 'Se eu aceitar, quando vamos?']) {
          const turn = next(uncertain);
          const reply = await send(turn, noGeneration);
          assert.match(reply.narration, /oferta continua em aberto/);
          assert.partialDeepStrictEqual(docs.get(path + '/narrative/' + (await turnDocumentIds(turn)).engine),
            { content: reply.narration, privateRecipientId: teresa.id });
          assert.deepEqual(runtime()?.bridgeOffer, pending);
        }
        assert.equal((await send(next('Teresa, pode vir comigo até a oficina.'))).narration, await fixed());
        assert.equal((await send(next('Henrique, pode vir comigo.'))).narration, await fixed());
        await assert.rejects(send(next('Sim, vamos juntos.')), { code: 'PILOT_ACTION_UNSUPPORTED' });
        assert.equal(state().currentLocation, beforeDefer.currentLocation);
        assert.deepEqual(state().worldTime, beforeDefer.worldTime);
      }
      assert.deepEqual(runtime()?.bridgeOffer, pending);
      const before = state();
      const relationships = runtime()?.relationships;
      if (command) {
        const reply = next(command);
        const confirmed = await send(reply, noGeneration);
        assert.match(confirmed.narration, decision === 'accepted' ? /Combinado/ : /Respeito sua escolha/);
        assert.deepEqual(runtime()?.bridgeOffer, { ...pending, status: decision, decisionTurnId: reply.turnId });
        const snapshot = structuredClone([...docs]);
        assert.equal((await send(reply, noGeneration)).narration, confirmed.narration);
        assert.deepEqual(structuredClone([...docs]), snapshot);
        await assert.rejects(send(next('Aceito a companhia.'), noGeneration), { code: 'PILOT_BRIDGE_OFFER_UNAVAILABLE' });
        assert.deepEqual(structuredClone([...docs]), snapshot);
      }
      assert.equal(state().currentLocation, before.currentLocation);
      assert.deepEqual(state().worldTime, before.worldTime);
      assert.deepEqual(runtime()?.relationships, relationships);
      await send(next('Examino o armário.'));
      await send(next('Espero 10 minutos.'));
      assert.deepEqual(state().worldTime, advanceWorldTime(before.worldTime, 10));
      assert.equal(runtime()?.bridgeOffer?.status, decision);
      await send(next('Digo a Teresa: Obrigado.'), async (_scene, intent, present) => {
        assert.match(intent, decision === 'accepted' ? /foi aceita/ : decision === 'declined' ? /foi recusada/ : /aguarda resposta/);
        const memories = present.memories.flatMap(({ memories }) => memories);
        assert.ok(memories.some(({ fact }) => fact === continuitySecret));
        assert.deepEqual(memories.filter(({ source }) => source === 'consequence').map(({ fact }) => fact),
          decision === 'pending' ? [] : [
            'Samuel ' + (decision === 'accepted' ? 'aceitou' : 'recusou') + ' a oferta de companhia para atravessar a ponte.',
          ]);
        trace({ context: 'Teresa', memories, offerStatus: runtime()?.bridgeOffer?.status });
        return fixed();
      });
      await send(next('Digo a Henrique: Bom dia.'), async (_scene, intent, present, _relations, history) => {
        assert.doesNotMatch(JSON.stringify({ intent, present, history }), /oferta de Teresa|oferta de companhia|posso atravessar|Tenho receio/);
        trace({ context: 'Henrique', privateOfferOrDisclosure: false });
        return fixed();
      });
      const original = state();
      docs.set(path, { ...original, activeTimelineId: timeline + '_outro' });
      const isolated = await persistPilotTurn(db, freixoPlayableCatalog, owner,
        { ...next('Teresa, pode vir comigo.'), baseTimelineId: timeline + '_outro' },
        async (_scene, intent, present, _relationships, history) => {
          assert.doesNotMatch(JSON.stringify({ intent, present, history }), /oferta de Teresa|posso atravessar|Tenho receio/);
          return fixed();
        });
      assert.equal(isolated.narration, await fixed());
      assert.equal(runtime(timeline + '_outro')?.bridgeOffer, undefined);
      assert.equal(runtime()?.bridgeOffer?.status, decision);
    });
  }
});

test('grava somente transições de abertura confirmadas pela engine', async () => {
  const bundle = createEchoArcBundle('dono');
  const campaign = { ...bundle.campaign, id: SERVER_PILOT_ID, currentLocation: familyKitchen };
  const path = 'campaigns/' + campaign.id;
  const timeline = campaign.activeTimelineId ?? 'tl_root';
  const teresa = bundle.npcs[0];
  const docs = new Map<string, object>([[path, campaign],
    [path + '/npcs/' + teresa.id, { ...teresa, campaignId: campaign.id, location: familyKitchen }]]);
  const db = memoryFirestore(docs);
  const historical = "Teresa ergue a cabeça da tábua de pão que estava preparando, o sorriso suave ampliando-se ao ouvir a saudação do filho. “Bom dia, Samuel,” responde ela, a voz calma envolvendo a cozinha enquanto fecha delicadamente o armário ao seu lado. Um leve aroma de ervas frescas se mistura ao cheiro do pão recém-assado, e ela ajeita um prato de frutas na bancada, pronta para seguir a rotina matinal. Por um instante, o sol que entra pela janela ilumina o canto onde eles estão, trazendo a sensação tranquila de um novo dia na vila.";
  const homonyms = { ...freixoPlayableCatalog, objects: [...freixoPlayableCatalog.objects, {
    id: 'armario-oficina', name: 'armário', aliases: ['armário da oficina'], location: freixoWoodWorkshop,
    description: 'Um armário.', openable: { aberto: 'Aberto.', fechado: 'Fechado.' },
  }] };
  for (const [generated, blocked, catalog = freixoPlayableCatalog] of [
    [historical, true],
    ['Teresa abre o armário.', true],
    ['Teresa toca no armário fechado.', false],
    ['Teresa sugere abrir o armário.', false],
    ['Teresa diz: “Não abri o armário.”', false],
    ['Teresa não fecha o armário.', false],
    ['Se Teresa fecha o armário, a madeira range.', false],
    ['Teresa lembra que fechou o armário ontem.', false],
    ['Teresa fecha o armário.', false, homonyms],
    ['Teresa fecha o armário da cozinha.', true, homonyms],
  ] as const) {
    const turn = { turnId: crypto.randomUUID(), campaignId: campaign.id, declaredAction: 'Digo a Teresa: Bom dia, mãe.',
      advanceMinutes: 10, expectedRevision: (docs.get(path) as typeof campaign).revision, baseTimelineId: timeline };
    await persistPilotTurn(db, catalog, 'dono', turn, async () => generated);
    const expected = blocked ? 'A conversa faz uma pausa.' : generated;
    const ids = await turnDocumentIds(turn);
    assert.partialDeepStrictEqual(docs.get(path + '/narrative/' + ids.engine), { content: expected });
    assert.ok(!(docs.get(path + '/npcRoutineState/' + timeline) as { openObjects?: string[] } | undefined)?.openObjects?.length);
    const beforeReplay = structuredClone([...docs]);
    const replay = await persistPilotTurn(db, catalog, 'dono', turn, async () => assert.fail('renarrou'));
    assert.equal(replay.narration, expected);
    assert.deepEqual(structuredClone([...docs]), beforeReplay);
  }
  const open = { turnId: crypto.randomUUID(), campaignId: campaign.id, declaredAction: 'Abro o armário.',
    advanceMinutes: 10, expectedRevision: (docs.get(path) as typeof campaign).revision, baseTimelineId: timeline };
  await persistPilotTurn(db, freixoPlayableCatalog, 'dono', open, async () => assert.fail('abertura depende da engine'));
  assert.deepEqual((docs.get(path + '/npcRoutineState/' + timeline) as { openObjects: string[] }).openObjects, ['demo-armario-cozinha']);
  assert.partialDeepStrictEqual(docs.get(path + '/narrative/' + (await turnDocumentIds(open)).engine),
    { content: 'O armário está aberto.' });
});

test('chegada preserva o local de objetos fixos e descarta prosa conflitante antes de persistir', async () => {
  const owner = 'dono';
  const campaign = { ...createEchoArcBundle(owner).campaign, id: SERVER_PILOT_ID, currentLocation: familyKitchen };
  const path = 'campaigns/' + campaign.id;
  const timelineId = campaign.activeTimelineId ?? 'tl_root';
  const docs = new Map<string, object>([[path, campaign]]);
  const db = memoryFirestore(docs);
  const next = (declaredAction: string) => ({ turnId: crypto.randomUUID(), expectedRevision: (docs.get(path) as typeof campaign).revision,
    campaignId: campaign.id, declaredAction, advanceMinutes: 10, baseTimelineId: timelineId });
  await persistPilotTurn(db, freixoPlayableCatalog, owner, next('Escancaro o armário.'), async () => assert.fail('narrou abertura'));
  const travel = next('Vou ao quintal.');
  const beforeTravel = structuredClone([...docs]);
  await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, owner, travel, async () => {
    throw new NarratorFailure('GROQ_HTTP_ERROR', 'provider_http', 429);
  }), { code: 'GROQ_HTTP_ERROR', status: 429 });
  assert.deepEqual(structuredClone([...docs]), beforeTravel);
  const invented = 'No quintal, o armário recém-aberto permanece com as portas escancaradas.';
  const result = await persistPilotTurn(db, freixoPlayableCatalog, owner, travel,
    async (arrival, sceneIntent, present, relationships, narrative, declaredAction) => {
      const context = buildNarratorContext({ campaign: arrival, inventory: [], npcs: present.npcs, narrative,
        sceneKnowledge: present.knowledge, npcMemories: present.memories, npcRelationships: relationships });
      const prompt = buildNarratorPrompt({ context, sceneIntent, declaredAction });
      assert.match(prompt, /O armário está aberto/);
      assert.match(sceneIntent, /estado prevalece sobre a prosa do histórico/);
      assert.ok(sceneIntent.includes(JSON.stringify({ name: 'armário', location: familyKitchen, state: 'aberto' })));
      return invented;
    });
  assert.equal(result.narration, 'Nada mais se destaca neste momento.');
  assert.equal((docs.get(path) as typeof campaign).currentLocation, familyYard);
  assert.deepEqual((docs.get(path + '/npcRoutineState/' + timelineId) as { openObjects: string[] }).openObjects, ['demo-armario-cozinha']);
  assert.ok(!JSON.stringify([...docs]).includes(invented));
  await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, owner, next('Fecho o armário.'), async () =>
    assert.fail('narrou interação distante')), { code: 'PILOT_OBJECT_OUT_OF_REACH' });
  const creative = 'Um armário de nuvens parece desenhado no céu.';
  const observation = await persistPilotTurn(db, freixoPlayableCatalog, owner, next('Observo o quintal.'), async () => creative);
  assert.equal(observation.narration, creative);
});

test('sessão de Freixo preserva consequências e conhecimento após 40 turnos autoritativos', async () => {
  for (const limit of [4, 40] as const) {
    const ownerId = 'dono-continuidade';
    const bundle = createEchoArcBundle(ownerId);
    const campaign = { ...bundle.campaign, id: SERVER_PILOT_ID, currentLocation: familyKitchen,
      worldTime: { ...bundle.campaign.worldTime, hour: 10, minute: 0 } };
    const path = 'campaigns/' + campaign.id;
    const lira = createWellEncounterNpc(ownerId, campaign.id);
    const [teresa, henrique] = bundle.npcs;
    const docs = new Map<string, object>([[path, campaign]]);
    for (const npc of [{ ...teresa, location: familyKitchen }, henrique, lira]) {
      docs.set(path + '/npcs/' + npc.id, { ...npc, campaignId: campaign.id });
    }
    const db = memoryFirestore(docs);
    let recipientChecks = 0;
    await verifyFreixoContinuity({
      read: async () => structuredClone({
        campaign: docs.get(path) as typeof campaign,
        docs: Object.fromEntries(continuityCollections.map((name) => {
          const prefix = path + '/' + name + '/';
          return [name, Object.fromEntries([...docs].filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => [key.slice(prefix.length), value]))];
        })) as ContinuitySnapshot['docs'],
      }),
      send: (turn) => persistPilotTurn(db, freixoPlayableCatalog, ownerId, turn,
        async (arrival, sceneIntent, present, relationships, narrative, action) => {
          const context = buildNarratorContext({ campaign: arrival, inventory: [], npcs: present.npcs, narrative,
            sceneKnowledge: present.knowledge, npcActivities: present.activities,
            npcMemories: present.memories, npcRelationships: relationships });
          const prompt = buildNarratorPrompt({ context, sceneIntent, declaredAction: action });
          if (action === 'Vou à cozinha.' || action === 'Vou ao poço.' || action === 'Vou ao quintal.') {
            assert.ok(!prompt.includes(continuitySecret), 'confidência vazou para uma chegada');
            assert.equal(context.currentState.privateNpcMemories, undefined);
            assert.equal(context.currentState.privateNpcRelationships, undefined);
          }
          if (action === 'Digo a Teresa: Obrigado.') {
            assert.ok(prompt.includes(continuitySecret), 'Teresa perdeu acesso à confidência');
            assert.match(prompt, /Entreguei o bloco a Henrique/);
            assert.ok(present.memories.some(({ name, memories }) => name === 'Teresa' &&
              memories.some(({ fact, source, speaker }) => fact === continuitySecret &&
                source === 'reported' && speaker === 'Samuel')));
            recipientChecks++;
          }
          if (action === 'Digo a Henrique: Obrigado.') {
            assert.ok(!prompt.includes(continuitySecret), 'confidência vazou para Henrique');
            assert.match(prompt, /bloco de madeira/);
            assert.ok(present.memories.some(({ name, memories }) => name === 'Henrique' &&
              memories.some(({ source }) => source === 'participated')));
            recipientChecks++;
          }
          if (action === 'Digo a Lira: Como vai?') {
            assert.ok(!prompt.includes(continuitySecret), 'confidência vazou para Lira');
            recipientChecks++;
          }
          return sceneIntent.startsWith('Mostre a reação')
            ? 'A fala encontra uma pausa atenta.' : 'O movimento da manhã segue ao redor.';
        }),
      log: (record) => {
        if (process.env.ECHO_CONTINUITY_TRACE === '1' || 'step' in record) console.info(JSON.stringify(record));
      },
    }, limit);
    assert.equal(recipientChecks, limit === 40 ? 3 : 0);
    if (limit === 40 && process.env.ECHO_CONTINUITY_TRACE === '1') {
      console.info(JSON.stringify({ type: 'prompt-checks', count: recipientChecks,
        checks: ['Teresa recebe memória pessoal e relato', 'Lira não recebe a confidência',
          'Henrique recebe a entrega, mas não a confidência'] }));
    }
  }
});

const recordedGroqArrival = "O poço da Vila de Freixo surge como um círculo de pedra escura ladeado por trepadeiras de flores silvestres, onde a água reflete o céu matutino ainda levemente rosado. Ao redor, alguns aldeões carregam baldes de madeira; um velho pescador bate o pé na borda, enquanto duas crianças correm entre as sombras das casas, lançando risos que se perdem no canto do vento. Lira, de cabelos trançados e avental manchado de terra, está inclinada sobre o balde, enchendo‑o com cuidado antes de virar-se para conversar com quem se aproximar.  \n\n**Destinos disponíveis agora:**  \n- Quintal da casa da família, Vila de Freixo  \n- Cozinha da casa da família, Vila de Freixo";

test('turno servidor aplica a rota e recupera o recibo sem narrar de novo', async (t) => {
  const campaign = { ...createEchoArcBundle('dono').campaign, id: SERVER_PILOT_ID, currentLocation: 'Porto' };
  const path = 'campaigns/' + SERVER_PILOT_ID;
  const docs = new Map<string, object>([[path, campaign]]);
  const db = memoryFirestore(docs);
  const turn = { turnId: crypto.randomUUID(), campaignId: SERVER_PILOT_ID, declaredAction: 'Vou até a praça',
    advanceMinutes: 720, expectedRevision: campaign.revision, baseTimelineId: campaign.activeTimelineId || 'tl_root' };
  const catalog = { places: [{ id: 'Porto', aliases: [] }, { id: 'Praça', aliases: [] }],
    routes: [{ from: 'Porto', to: 'Praça', minutes: 8 }] };
  await assert.rejects(persistPilotTurn(db, catalog, 'dono', { ...turn, declaredAction: 'Observo o que ela está fazendo.' },
    async () => assert.fail('referência sem alvo não chama o narrador')),
    { code: 'PILOT_OBSERVATION_UNAVAILABLE', absentNpcName: undefined });
  assert.equal(docs.size, 1);
  await assert.rejects(persistPilotTurn(db, { ...catalog, routes: [{ ...catalog.routes[0], blocked: true }] },
    'dono', turn, async () => assert.fail('rota bloqueada não narra')), /PILOT_TRAVEL_UNAVAILABLE/);
  await assert.rejects(persistPilotTurn(db, catalog, 'dono', turn, async () => 'Samuel voltou ao Porto.'),
    /PILOT_NARRATION_CONFLICT/);
  assert.equal(docs.size, 1);
  const result = await persistPilotTurn(db, catalog, 'dono', turn, async () => 'Vasos ladeiam o chafariz.');
  assert.equal(docs.size, 5);
  const after = docs.get(path) as typeof campaign;
  assert.equal(after.currentLocation, 'Praça');
  assert.deepEqual(after.worldTime, advanceWorldTime(campaign.worldTime, 8));
  assert.equal(after.revision, campaign.revision + 1);
  assert.equal((await persistPilotTurn(db, catalog, 'dono', turn, async () => assert.fail('renarrou'))).narration, result.narration);
  await assert.rejects(persistPilotTurn(db, catalog, 'dono', { ...turn, advanceMinutes: 3 },
    async () => assert.fail('identidade divergente não narra')), /TURN_ID_CONFLICT/);
  assert.equal(docs.size, 5);
  docs.set(path, { ...after, currentLocation: 'Porto', activeTimelineId: 'tl_restored', revision: after.revision + 1 });
  await assert.rejects(persistPilotTurn(db, catalog, 'dono', turn,
    async () => assert.fail('turno da linha abandonada não narra')), /CONCURRENT_STATE_CONFLICT/);
  assert.equal((docs.get(path) as typeof campaign).currentLocation, 'Porto');
  assert.equal(docs.size, 5);

  const [teresa, henrique] = createEchoArcBundle('dono').npcs;
  const home = teresa.location;
  const workshop = henrique.location;
  const npcPath = path + '/npcs/';
  docs.clear();
  docs.set(path, { ...campaign, currentLocation: home });
  docs.set(npcPath + teresa.id, { ...teresa, campaignId: SERVER_PILOT_ID });
  docs.set(npcPath + henrique.id, { ...henrique, campaignId: SERVER_PILOT_ID, location: home });
  const routineCatalog = { places: [{ id: home, aliases: ['casa'] }, { id: workshop, aliases: ['oficina'] }, catalog.places[1]],
    routes: [{ from: home, to: workshop, minutes: 4 }, { from: home, to: 'Praça', minutes: 8 }] };
  const routineTurn = { ...turn, turnId: crypto.randomUUID() };
  await assert.rejects(persistPilotTurn(db, routineCatalog, 'dono', routineTurn, async () => {
    throw new Error('narrador indisponível');
  }), /narrador indisponível/);
  assert.equal((docs.get(npcPath + henrique.id) as typeof henrique).location, home);
  assert.equal(docs.size, 3);
  await persistPilotTurn(db, routineCatalog, 'dono', routineTurn, async (_arrival, _intent, present) => {
    assert.equal(present.npcs.length, 0);
    return 'Vasos ladeiam o chafariz.';
  });
  assert.equal((docs.get(npcPath + henrique.id) as typeof henrique).location, workshop);
  assert.equal((docs.get(npcPath + teresa.id) as typeof teresa).location, home);
  assert.equal(docs.size, 8);
  await persistPilotTurn(db, routineCatalog, 'dono', routineTurn, async () => assert.fail('renarrou'));
  assert.equal(docs.size, 8);
  const statePath = path + '/npcRoutineState/' + routineTurn.baseTimelineId;
  assert.deepEqual((docs.get(statePath) as { memories: { npcId: string; turnId: string; sequence: number }[] })
    .memories.map(({ npcId, turnId, sequence }) => ({ npcId, turnId, sequence })),
  [{ npcId: teresa.id, turnId: routineTurn.turnId, sequence: campaign.lastSequence + 3 }]);

  const afterTravel = docs.get(path) as typeof campaign;
  const homeCatalog = { ...routineCatalog, routes: [...routineCatalog.routes, { from: 'Praça', to: home, minutes: 8 }] };
  const next = (declaredAction: string) => ({ ...turn, turnId: crypto.randomUUID(), declaredAction,
    expectedRevision: (docs.get(path) as typeof campaign).revision });
  await assert.rejects(persistPilotTurn(db, homeCatalog, 'dono', next('Conto a Teresa: Talvez eu viaje.'),
    async () => assert.fail('destinatária ausente')), /PILOT_SPEECH_UNAVAILABLE/);
  await persistPilotTurn(db, homeCatalog, 'dono', next('Vou até a casa'), async () => 'Teresa organiza a mesa.');
  const beforeGreeting = docs.get(path) as typeof campaign;
  const greetings = ['Digo a Teresa: Bom dia, mãe.', 'Digo a Teresa: Bom dia.',
    'Digo\u00a0a Teresa ： Bom dia, mãe.', 'Bom dia, mãe!', 'Teresa, como você está?',
    'Bom\u00a0dia ， ma\u0303e！', '“Oi, Teresa!”', 'Bom dia mãe!'];
  for (const greeting of greetings) {
    const identity = next(greeting);
    const browserFetch = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, request?: RequestInit) => {
      assert.equal(url, '/api/narrator/turn');
      const body = JSON.parse(String(request?.body));
      assert.deepEqual(body, identity);
      const result = await persistPilotTurn(db, homeCatalog, 'dono', body, async (scene, intent) => {
        assert.equal(scene.currentLocation, home);
        assert.match(intent, /Mostre a reação de Teresa/);
        return 'Teresa retribui o cumprimento.';
      });
      return Response.json(result);
    });
    const reply = await requestNarratorTurn('token-teste', { ...identity, turn: identity });
    browserFetch.mock.restore();
    assert.equal(reply.narration, 'Teresa retribui o cumprimento.');
  }
  const afterGreetings = docs.get(path) as typeof campaign;
  assert.equal(afterGreetings.currentLocation, home);
  assert.deepEqual(afterGreetings.worldTime, beforeGreeting.worldTime);
  assert.equal(afterGreetings.revision, beforeGreeting.revision + greetings.length);
  assert.equal((docs.get(statePath) as { relationships?: unknown }).relationships, undefined);
  await assert.rejects(persistPilotTurn(db, homeCatalog, 'dono', next('Digo a Teresa Bom dia.'),
    async () => assert.fail('fala inválida chamou o narrador')), /PILOT_SPEECH_UNAVAILABLE/);
  await assert.rejects(persistPilotTurn(db, homeCatalog, 'dono', next('Observo a mesa.'),
    async () => assert.fail('alvo desconhecido chamou o narrador')), /PILOT_OBSERVATION_UNAVAILABLE/);
  await assert.rejects(persistPilotTurn(db, homeCatalog, 'dono', next('Vou examinar o caldeirão.'),
    async () => assert.fail('exame virou deslocamento')), /PILOT_OBSERVATION_UNAVAILABLE/);
  const observeBefore = docs.get(path) as typeof campaign;
  await persistPilotTurn(db, homeCatalog, 'dono', next('Olho ao meu redor.'), async (_scene, intent, context) => {
    assert.match(intent, /somente o que pode ser percebido/);
    assert.deepEqual(context.memories, []);
    return 'Há utensílios sobre uma bancada.';
  });
  assert.deepEqual((docs.get(path) as typeof campaign).worldTime, observeBefore.worldTime);
  const observation = next('Observo a cozinha.');
  const kitchenCatalog = { ...homeCatalog, places: homeCatalog.places.map((place) =>
    place.id === home ? { ...place, aliases: [...place.aliases, 'cozinha'] } : place) };
  const beforeRejectedObservation = [...docs];
  for (const [prose, reason] of [
    ['Samuel sai da cozinha e entra no quintal.', 'observation-agency-or-movement'],
    ['Samuel decide ajudar Teresa amanhã.', 'observation-agency-or-movement'],
    ['Você recebe uma faca de Teresa.', 'observation-agency-or-movement'],
    ['Cinco minutos depois, Teresa volta a mexer a panela.', 'observation-time-advance'],
  ]) {
    await assert.rejects(persistPilotTurn(db, kitchenCatalog, 'dono', observation, async () => prose),
      { code: 'PILOT_NARRATION_CONFLICT', reason });
    assert.deepEqual([...docs], beforeRejectedObservation);
  }
  const kitchenProse = 'Samuel observa a cozinha. Teresa volta à bancada e mexe a panela. A colher escorrega para o lado.';
  const observed = await persistPilotTurn(db, kitchenCatalog, 'dono', observation, async () => kitchenProse);
  assert.equal(observed.narration, kitchenProse);
  const afterObservation = docs.get(path) as typeof campaign;
  assert.equal(afterObservation.currentLocation, observeBefore.currentLocation);
  assert.deepEqual(afterObservation.worldTime, observeBefore.worldTime);
  const householdCatalog = { ...kitchenCatalog,
    objects: [{ id: 'bancada', name: 'bancada', aliases: [], location: home,
      description: 'Uma bancada de trabalho.', condition: { activityId: 'bancada', initial: 'Ainda por organizar.' } }],
    activities: [{ id: 'bancada', location: home, participant: 'Teresa',
    verb: 'organizar', target: 'cozinha', minutes: 5, result: 'A bancada ficou organizada.' }] };
  await t.test('esclarece apenas um objeto, preserva a revisão e recupera o recibo', async () => {
    const original = [...docs] as const;
    docs.set(path, { ...afterObservation, currentLocation: familyKitchen });
    const before = [...docs];
    const ask = next('Examino aquele objeto.');
    const noNarration = async () => assert.fail('a pergunta ou a recusa não deve narrar');
    try {
      let token = '';
      await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, 'dono', ask, noNarration), (error) => {
        if (!(error instanceof PilotTurnError) || !error.clarificationPrefix) return false;
        assert.equal(error.code, 'PILOT_OBJECT_AMBIGUOUS');
        assert.equal(describePilotFeedback(error, true), 'Qual objeto você deseja examinar?');
        token = issuePilotClarification('dono', ask, error.clarificationPrefix);
        return true;
      });
      const prefix = readPilotClarification('dono', ask, token);
      assert.equal(prefix, 'Examino');
      assert.equal(readPilotClarification('outra-pessoa', ask, token), undefined);
      assert.equal(readPilotClarification('dono', { ...ask, expectedRevision: ask.expectedRevision + 1 }, token), undefined);
      const resume = (answer: string, narrate: Parameters<typeof persistPilotTurn>[4] = noNarration,
        catalog = freixoPlayableCatalog) => persistPilotTurn(db, catalog,
        'dono', { ...ask, declaredAction: prefix + ' ' + answer }, narrate, answer);
      await assert.rejects(resume('Teresa'), { code: 'PILOT_OBJECT_UNREGISTERED' });
      await assert.rejects(resume('a bancada da oficina'), { code: 'PILOT_OBJECT_OUT_OF_REACH' });
      await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, 'dono',
        next('Vou ao quintal e examino a bancada da oficina.'), noNarration), (error) => {
        if (!(error instanceof PilotTurnError) || error.code !== 'PILOT_OBJECT_OUT_OF_REACH') return false;
        assert.equal(describePilotFeedback(error, false),
          'Etapa 2. Samuel não conseguiria examinar “bancada da oficina” a partir do local previsto (quintal).');
        return true;
      });
      await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, 'dono',
        next('Examino a bancada da oficina.'), noNarration), (error) => {
        if (!(error instanceof PilotTurnError) || error.code !== 'PILOT_OBJECT_OUT_OF_REACH') return false;
        assert.match(describePilotFeedback(error, false) ?? '', /“bancada da oficina” está fora do alcance/);
        return true;
      });
      await assert.rejects(resume('a bancada e observo a cozinha'), { code: 'PILOT_OBJECT_UNREGISTERED' });
      await assert.rejects(resume('a bancada', noNarration, { ...freixoPlayableCatalog,
        objects: freixoPlayableCatalog.objects!.map((object) => ({ ...object, location: familyKitchen })),
      }), { code: 'PILOT_OBJECT_AMBIGUOUS' });
      assert.deepEqual([...docs], before);

      const stale = next('Examino.');
      await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, 'dono', stale, noNarration),
        { code: 'PILOT_OBJECT_AMBIGUOUS', clarificationPrefix: 'Examino' });
      const result = await resume('A bancada da cozinha', async () => 'A luz toca a superfície.');
      assert.match(result.narration, /bancada de trabalho na cozinha/);
      const after = [...docs];
      assert.deepEqual((docs.get(path) as typeof campaign).worldTime, afterObservation.worldTime);
      assert.equal((await resume('A bancada da cozinha')).narration, result.narration);
      await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, 'dono',
        { ...stale, declaredAction: 'Examino A bancada da cozinha' }, noNarration, 'A bancada da cozinha'),
        { code: 'CONCURRENT_STATE_CONFLICT' });
      assert.deepEqual([...docs], after);
    } finally {
      docs.clear();
      for (const [key, value] of original) docs.set(key, value);
    }
  });
  await t.test('guardar e retirar o bloco exige posse, alcance e armário aberto', async () => {
    const original = [...docs];
    const item = path + '/inventory/demo-bloco-madeira';
    const placement = path + '/pilotObjectLocations/demo-bloco-madeira';
    const store = 'Guardo o bloco no armário.';
    const submit = (identity: typeof turn) => persistPilotTurn(db, freixoPlayableCatalog, 'dono', identity,
      async () => assert.fail('A transferência deve produzir um resultado factual.'));
    const play = (action: string) => submit(next(action));
    const refuse = async (action: string, code: string) => {
      const before = [...docs];
      await assert.rejects(play(action), { code });
      assert.deepEqual([...docs], before);
    };
    docs.set(path, { ...afterObservation, currentLocation: familyKitchen });
    try {
      await play('Abro o armário.');
      await refuse(store, 'PILOT_OBJECT_NOT_HELD');
      await refuse('Retiro o bloco do armário.', 'PILOT_STORAGE_EMPTY');
      await play('Pego o bloco.');
      await refuse('Vou ao quintal e guardo o bloco no armário.', 'PILOT_TRANSFER_SEQUENCE');
      await refuse('Guardo o bloco na oficina.', 'PILOT_ACTION_UNSUPPORTED');
      await refuse('Coloco o bloco no poço.', 'PILOT_OBJECT_UNREGISTERED');
      await refuse('Coloco o bloco no bloco.', 'PILOT_STORAGE_UNAVAILABLE');
      await play('Fecho o armário.');
      await refuse(store, 'PILOT_STORAGE_CLOSED');
      await play('Abro o armário.');
      const attempt = next('Coloco o bloco de madeira dentro do armário da cozinha.');
      const before = [...docs];
      await assert.rejects(submit({ ...attempt, campaignId: 'outra' }), { code: 'CAMPAIGN_ACCESS_DENIED' });
      await assert.rejects(submit({ ...attempt, baseTimelineId: 'outra' }), { code: 'CONCURRENT_STATE_CONFLICT' });
      assert.deepEqual([...docs], before);
      const answer = await submit(attempt);
      assert.match(answer.narration, /guardou.*bloco de madeira.*armário/);
      assert.equal(docs.has(item), false);
      assert.deepEqual(docs.get(placement), { ownerId: 'dono', campaignId: SERVER_PILOT_ID,
        timelineId: attempt.baseTimelineId, containerId: 'demo-armario-cozinha' });
      const saved = structuredClone([...docs]);
      for (const [key, value] of saved) docs.set(key, value);
      assert.equal((await submit(attempt)).narration, answer.narration);
      assert.deepEqual([...docs], saved);
      await refuse(store, 'PILOT_OBJECT_NOT_HELD');
      await refuse('Pego o bloco.', 'PILOT_STORAGE_EXPLICIT');
      await refuse('Largo o bloco.', 'PILOT_OBJECT_NOT_HELD');
      const kitchen = docs.get(path) as typeof campaign;
      docs.set(path, { ...kitchen, currentLocation: familyYard });
      await refuse(store, 'PILOT_STORAGE_DISTANT');
      await refuse('Pego o bloco do armário.', 'PILOT_STORAGE_DISTANT');
      docs.set(path, kitchen);
      await play('Tento retirar o bloco de dentro do armário.');
      assert.equal(docs.has(placement), false);
      assert.partialDeepStrictEqual(docs.get(item), { quantity: 1, id: 'demo-bloco-madeira', ownerId: 'dono' });

      docs.delete(item);
      docs.set(placement, { ownerId: 'dono', campaignId: SERVER_PILOT_ID, timelineId: attempt.baseTimelineId, npcId: henrique.id });
      await refuse(store, 'PILOT_OBJECT_NOT_HELD');
      await refuse('Retiro o bloco do armário.', 'PILOT_STORAGE_EMPTY');
    } finally {
      docs.clear();
      for (const [key, value] of original) docs.set(key, value);
    }
  });

  await t.test('transfere o mesmo bloco entre chão e inventário e preserva o replay', async () => {
    const original = [...docs];
    docs.set(path, { ...afterObservation, currentLocation: familyKitchen });
    const itemPath = path + '/inventory/demo-bloco-madeira';
    const groundPath = path + '/pilotObjectLocations/demo-bloco-madeira';
    const noNarration = async () => assert.fail('a transferência ou recusa dispensa narrador');
    const play = (declared: string, narrate: Parameters<typeof persistPilotTurn>[4] = noNarration) =>
      persistPilotTurn(db, freixoPlayableCatalog, 'dono', next(declared), narrate);
    const before = [...docs];
    try {
      for (const [action, code] of [
        ['Pego a bancada da cozinha.', 'PILOT_OBJECT_FIXED'],
        ['Pego um jarro.', 'PILOT_OBJECT_UNREGISTERED'],
        ['Largo o bloco.', 'PILOT_OBJECT_NOT_HELD'],
        ['Vou ao quintal e pego o bloco.', 'PILOT_TRANSFER_SEQUENCE'],
      ]) await assert.rejects(play(action), { code });
      const reservedCatalog = { ...freixoPlayableCatalog, objects: freixoPlayableCatalog.objects.map((object) =>
        object.id === 'demo-bloco-madeira' ? { ...object, portable: { ownerNpcId: teresa.id } } : object) };
      await assert.rejects(persistPilotTurn(db, reservedCatalog, 'dono', next('Pego o bloco.'), noNarration),
        { code: 'PILOT_OBJECT_OWNED' });
      assert.deepEqual([...docs], before);
      await play('Examino o bloco de madeira.', async () => 'A madeira é clara.');
      const pickup = next('Pego aquele objeto.');
      await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, 'outro', pickup, noNarration),
        { code: 'CAMPAIGN_ACCESS_DENIED' });
      const result = await persistPilotTurn(db, freixoPlayableCatalog, 'dono', pickup, noNarration);
      assert.match(result.narration, /recolheu.*bloco/);
      assert.partialDeepStrictEqual(docs.get(itemPath), { id: 'demo-bloco-madeira', ownerId: 'dono', quantity: 1 });
      assert.equal(docs.has(groundPath), false);
      assert.deepEqual((docs.get(path) as typeof campaign).worldTime, afterObservation.worldTime);
      docs.set(npcPath + teresa.id, { ...teresa, campaignId: SERVER_PILOT_ID, location: familyKitchen });
      const carried = [...docs];
      assert.equal((await persistPilotTurn(db, freixoPlayableCatalog, 'dono', pickup, noNarration)).narration, result.narration);
      await assert.rejects(play('Recolho o bloco.'), { code: 'PILOT_OBJECT_ALREADY_HELD' });
      await assert.rejects(play('Examino o bloco.'), { code: 'PILOT_OBJECT_ALREADY_HELD' });
      await assert.rejects(play('Entrego o bloco para Teresa.'), { code: 'PILOT_DELIVERY_NOT_ALLOWED' });
      assert.deepEqual([...docs], carried);
      const heldItem = docs.get(itemPath);
      for (const [action, minutes] of [
        ['Aguardo cinco minutos.', 5], ['Deixo dois minutos passarem.', 2],
      ] as const) {
        const before = docs.get(path) as typeof campaign;
        const wait = next(action);
        const result = await persistPilotTurn(db, freixoPlayableCatalog, 'dono', wait, noNarration);
        assert.deepEqual((docs.get(path) as typeof campaign).worldTime, advanceWorldTime(before.worldTime, minutes));
        assert.deepEqual(docs.get(itemPath), heldItem);
        assert.equal(docs.has(groundPath), false);
        const waited = [...docs];
        assert.deepEqual(await persistPilotTurn(db, freixoPlayableCatalog, 'dono', wait, noNarration),
          { ...result, mode: 'replay' });
        assert.deepEqual([...docs], waited);
      }
      await play('Vou ao quintal.', async () => 'Há luz no quintal.');
      assert.equal(docs.has(itemPath), true);
      const drop = next('Deixo o bloco de madeira no chão.');
      await persistPilotTurn(db, freixoPlayableCatalog, 'dono', drop, noNarration);
      assert.equal(docs.has(itemPath), false);
      assert.partialDeepStrictEqual(docs.get(groundPath), { location: familyYard });
      const dropped = [...docs];
      await persistPilotTurn(db, freixoPlayableCatalog, 'dono', drop, noNarration);
      await persistPilotTurn(db, freixoPlayableCatalog, 'dono', pickup, noNarration);
      assert.deepEqual([...docs], dropped);
      await play('Vou até a cozinha.', async () => 'Há luz na cozinha.');
      await assert.rejects(play('Pego o bloco.'), { code: 'PILOT_OBJECT_OUT_OF_REACH' });
      await play('Vou ao quintal.', async () => 'Há luz no quintal.');
      await play('Pego o bloco.');
      assert.equal(docs.has(itemPath), true);
      assert.equal(docs.has(groundPath), false);
      docs.set(npcPath + henrique.id, { ...henrique, campaignId: SERVER_PILOT_ID, location: freixoWoodWorkshop });
      const beforeDelivery = [...docs];
      await assert.rejects(play('Entrego o bloco para Henrique.'), {
        code: 'PILOT_DELIVERY_RECIPIENT', absentNpcName: 'Henrique',
      });
      await assert.rejects(play('Ofereço o bloco para Henrique.'), { code: 'PILOT_DELIVERY_OFFER' });
      await assert.rejects(play('Dou o bloco para ninguém.'), { code: 'PILOT_DELIVERY_RECIPIENT' });
      await assert.rejects(play('Entrego a bancada da cozinha para Henrique.'), { code: 'PILOT_DELIVERY_NOT_TRANSFERABLE' });
      await assert.rejects(play('Vou até a oficina e entrego o bloco para Henrique.'), { code: 'PILOT_TRANSFER_SEQUENCE', step: 2 });
      assert.deepEqual([...docs], beforeDelivery);
      await play('Vou até a oficina.', async () => 'Há luz na oficina.');
      await play('Observo Henrique.', async () => 'Henrique está junto à bancada.');
      const deliver = next('Entrego aquele objeto para ele.');
      await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, 'outro', deliver, noNarration),
        { code: 'CAMPAIGN_ACCESS_DENIED' });
      await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, 'dono', { ...deliver, campaignId: 'outra' }, noNarration),
        { code: 'CAMPAIGN_ACCESS_DENIED' });
      const noPermission = { ...freixoPlayableCatalog, objects: freixoPlayableCatalog.objects.map((object) =>
        object.id === 'demo-bloco-madeira' ? { ...object, portable: {} } : object) };
      await assert.rejects(persistPilotTurn(db, noPermission, 'dono', deliver, noNarration),
        { code: 'PILOT_DELIVERY_NOT_TRANSFERABLE' });
      const timeBeforeDelivery = (docs.get(path) as typeof campaign).worldTime;
      const delivered = await persistPilotTurn(db, freixoPlayableCatalog, 'dono', deliver, noNarration);
      assert.match(delivered.narration, /entregou.*bloco.*Henrique/);
      const deliveryIds = await turnDocumentIds(deliver);
      assert.partialDeepStrictEqual(docs.get(path + '/events/' + deliveryIds.event), {
        type: 'PLAYER_ACTION', afterSummary: delivered.narration + ' ' + freixoWoodWorkshop + ' (+0 min)',
      });
      assert.equal(docs.has(itemPath), false);
      assert.deepEqual(docs.get(groundPath), { ownerId: 'dono', campaignId: SERVER_PILOT_ID,
        timelineId: deliver.baseTimelineId, npcId: henrique.id });
      assert.deepEqual((docs.get(path) as typeof campaign).worldTime, timeBeforeDelivery);
      const confirmed = [...docs];
      await assert.rejects(play('Dou o bloco ao Henrique.'), { code: 'PILOT_OBJECT_NOT_HELD' });
      await assert.rejects(play('Pego o bloco.'), { code: 'PILOT_OBJECT_OWNED' });
      assert.equal((await persistPilotTurn(db, freixoPlayableCatalog, 'dono', deliver, noNarration)).narration, delivered.narration);
      assert.deepEqual([...docs], confirmed);
      const runtime = docs.get(statePath) as import('../src/engine/npcRoutine').NpcRoutineState;
      assert.ok(runtime.memories?.some(({ npcId, origin }) => npcId === henrique.id &&
        origin.kind === 'participated' && origin.event === 'delivery'));
      assert.match((await play('Henrique, o que eu te entreguei?')).narration, /Você me entregou o bloco de madeira/);
      docs.set(statePath, { ...runtime, memories: runtime.memories?.filter(({ origin }) =>
        !(origin.kind === 'participated' && origin.event === 'delivery')) });
      assert.match((await play('Henrique, lembra do bloco que te entreguei?')).narration, /Você me entregou o bloco de madeira/);
      assert.ok(!(docs.get(statePath) as typeof runtime).memories?.some(({ origin }) =>
        origin.kind === 'participated' && origin.event === 'delivery'));
      docs.set(statePath, runtime);
      const direct = next('Vou da oficina para a cozinha.');
      const blocked = { ...freixoPlayableCatalog, routes: freixoPlayableCatalog.routes.map((route) =>
        route.from === freixoWoodWorkshop ? { ...route, blocked: true } : route) };
      const beforeBlocked = [...docs];
      await assert.rejects(persistPilotTurn(db, blocked, 'dono', direct, noNarration), { code: 'PILOT_TRAVEL_UNAVAILABLE' });
      assert.deepEqual([...docs], beforeBlocked);
      await persistPilotTurn(db, freixoPlayableCatalog, 'dono', direct, async () => 'Há luz na cozinha.');
      const arrived = docs.get(path) as typeof campaign;
      assert.equal(arrived.currentLocation, familyKitchen);
      assert.deepEqual(arrived.worldTime, advanceWorldTime(timeBeforeDelivery, 6));
      assert.partialDeepStrictEqual(docs.get(path + '/turnReceipts/' + direct.turnId), {
        plan: { routePath: [freixoWoodWorkshop, familyYard, familyKitchen], expectedMinutes: 6 },
      });
      const traveled = [...docs];
      await persistPilotTurn(db, freixoPlayableCatalog, 'dono', direct, noNarration);
      assert.deepEqual([...docs], traveled);
    } finally {
      docs.clear();
      for (const [key, value] of original) docs.set(key, value);
    }
  });
  await t.test('organiza a mesma bancada uma vez e examina o estado persistido', async () => {
    const original = [...docs];
    const inventoryPath = path + '/inventory';
    const ownershipPath = path + '/pilotObjectLocations/demo-bloco-madeira';
    docs.set(path, { ...afterObservation, currentLocation: familyKitchen });
    docs.set(ownershipPath, { ownerId: 'dono', campaignId: SERVER_PILOT_ID,
      timelineId: afterObservation.activeTimelineId ?? 'tl_root', npcId: henrique.id });
    const untouchedItems = [...docs].filter(([key]) => key.startsWith(inventoryPath + '/') || key === ownershipPath);
    const failNarration = async () => assert.fail('o resultado da bancada é produzido pelo motor');
    const play = (action: string) => persistPilotTurn(db, freixoPlayableCatalog, 'dono', next(action), failNarration);
    try {
      const initial = await play('Examino a bancada da cozinha.');
      assert.match(initial.narration, /ainda está por organizar/);
      assert.match((await play('  EXAMINO   A BANCDA DA COZINHA!!  ')).narration, /ainda está por organizar/);
      const before = [...docs];
      await assert.rejects(play('Examino a bancda da oficina.'), { code: 'PILOT_OBJECT_OUT_OF_REACH' });
      await assert.rejects(play('Examino a bancda.'), { code: 'PILOT_OBJECT_AMBIGUOUS', clarificationPrefix: 'Examino' });
      await assert.rejects(play('Xzr a bancada.'), { code: 'PILOT_ACTION_UNSUPPORTED' });
      await assert.rejects(play('Pego a bancada da cozinha!!'), { code: 'PILOT_OBJECT_FIXED' });
      const legacyState = docs.get(statePath) ?? {};
      docs.set(statePath, { ...legacyState, completedActivities: ['demo-organizar-cozinha'] });
      const alreadyOrganized = [...docs];
      await assert.rejects(play('Arrumo a bancada.'), { code: 'PILOT_ENVIRONMENT_ALREADY_ORGANIZED' });
      assert.deepEqual([...docs], alreadyOrganized);
      assert.match((await play('Examino a bancada.')).narration, /A bancada está organizada\./);
      docs.clear();
      for (const [key, value] of before) docs.set(key, value);
      await assert.rejects(play('Organizo a mesa inexistente.'), { code: 'PILOT_OBJECT_UNREGISTERED' });
      await assert.rejects(play('Arrumo a bancada da oficina.'), { code: 'PILOT_OBJECT_OUT_OF_REACH' });
      await assert.rejects(play('Vou ao quintal e arrumo a bancada.'), { code: 'PILOT_ENVIRONMENT_SEQUENCE', step: 2 });
      await assert.rejects(play('Desorganizo a bancada.'), { code: 'PILOT_ACTION_UNSUPPORTED' });
      assert.deepEqual([...docs], before);
      const turn = next('Vou organizar aquele objeto.');
      await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, 'dono',
        { ...turn, campaignId: 'outra' }, failNarration), { code: 'CAMPAIGN_ACCESS_DENIED' });
      await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, 'outro', turn, failNarration),
        { code: 'CAMPAIGN_ACCESS_DENIED' });
      const completed = await persistPilotTurn(db, freixoPlayableCatalog, 'dono', turn, failNarration);
      assert.match(completed.narration, /ficou organizada/);
      assert.deepEqual((docs.get(path) as typeof campaign).worldTime, advanceWorldTime(afterObservation.worldTime, 5));
      assert.deepEqual((docs.get(statePath) as { completedActivities?: string[] }).completedActivities,
        ['demo-organizar-cozinha']);
      const ids = await turnDocumentIds(turn);
      assert.partialDeepStrictEqual(docs.get(path + '/events/' + ids.event), { type: 'PLAYER_ACTION' });
      assert.partialDeepStrictEqual(docs.get(path + '/turnReceipts/' + turn.turnId), {
        plan: { kind: 'organize', objectId: 'demo-bancada-cozinha', from: 'desorganizada', to: 'organizada' },
      });
      const confirmed = [...docs];
      await assert.rejects(play('Organizo a bancada novamente.'), { code: 'PILOT_ENVIRONMENT_ALREADY_ORGANIZED' });
      await assert.rejects(play('Ajudo Teresa a organizar a cozinha.'), { code: 'PILOT_ACTIVITY_UNAVAILABLE' });
      assert.equal((await persistPilotTurn(db, freixoPlayableCatalog, 'dono', turn, failNarration)).narration, completed.narration);
      assert.deepEqual([...docs], confirmed);
      assert.match((await play('Examino a bancada.')).narration, /A bancada está organizada\./);
      assert.deepEqual([...docs].filter(([key]) => key.startsWith(inventoryPath + '/') || key === ownershipPath), untouchedItems);
      const start = docs.get(path) as typeof campaign;
      const beforeWait = [...docs];
      await assert.rejects(play('Espero um pouco.'), { code: 'PILOT_WAIT_UNAVAILABLE', reason: 'unspecified' });
      await assert.rejects(play('Espero 10 minutos e examino a bancada.'), { code: 'PILOT_WAIT_SEQUENCE', step: 1 });
      const wait = { ...next('Fico aqui esperando meia hora.'), advanceMinutes: 10 };
      await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, 'outro', wait, failNarration),
        { code: 'CAMPAIGN_ACCESS_DENIED' });
      assert.deepEqual([...docs], beforeWait);
      const result = await persistPilotTurn(db, freixoPlayableCatalog, 'dono', wait, failNarration);
      assert.match(result.narration, /^Samuel aguardou 30 minutos\. Agora são \d{2}:\d{2}\.$/);
      const afterWait = docs.get(path) as typeof campaign;
      assert.equal(afterWait.currentLocation, start.currentLocation);
      assert.deepEqual(afterWait.worldTime, advanceWorldTime(start.worldTime, 30));
      assert.equal(afterWait.revision, start.revision + 1);
      assert.partialDeepStrictEqual(docs.get(path + '/turnReceipts/' + wait.turnId),
        { plan: { kind: 'wait', elapsedMinutes: 30 } });
      const waited = [...docs];
      assert.equal((await persistPilotTurn(db, freixoPlayableCatalog, 'dono', wait, failNarration)).narration, result.narration);
      assert.deepEqual([...docs], waited);
      assert.deepEqual([...docs].filter(([key]) => key.startsWith(inventoryPath + '/') || key === ownershipPath), untouchedItems);
      await assert.rejects(play('Examino a bancada e escancaro o armário.'), { code: 'PILOT_OPEN_CLOSE_SEQUENCE', step: 2 });
      await assert.rejects(play('Deixo dois minutos passarem e examino a bancada.'), { code: 'PILOT_WAIT_SEQUENCE', step: 1 });
      await assert.rejects(play('Deixo dois ou três minutos passarem.'), { code: 'PILOT_WAIT_UNAVAILABLE', reason: 'unspecified' });
      await assert.rejects(play('Escancararia o armário.'), { code: 'PILOT_ACTION_UNSUPPORTED' });
      assert.deepEqual([...docs], waited);
      assert.match((await play('Examino a bancada.')).narration, /A bancada está organizada/);
      assert.match((await play('Examino o armário.')).narration, /O armário está fechado\./);
      const beforeOpening = [...docs];
      await assert.rejects(play('Fecho o armário.'), { code: 'PILOT_OPEN_CLOSE_ALREADY_SET', reason: 'fechado' });
      await assert.rejects(play('Abro a bancada.'), { code: 'PILOT_OPEN_CLOSE_UNAVAILABLE' });
      await assert.rejects(play('Abro a arca.'), { code: 'PILOT_OBJECT_UNREGISTERED' });
      await assert.rejects(play('Abro o armário e examino a bancada.'), { code: 'PILOT_OPEN_CLOSE_SEQUENCE', step: 1 });
      const open = next('Escancaro o armário.');
      await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, 'dono', { ...open, campaignId: 'outra' }, failNarration),
        { code: 'CAMPAIGN_ACCESS_DENIED' });
      await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, 'outro', open, failNarration),
        { code: 'CAMPAIGN_ACCESS_DENIED' });
      assert.deepEqual([...docs], beforeOpening);
      const opened = await persistPilotTurn(db, freixoPlayableCatalog, 'dono', open, failNarration);
      assert.equal(opened.narration, 'O armário está aberto.');
      assert.partialDeepStrictEqual(docs.get(path + '/turnReceipts/' + open.turnId), {
        plan: { kind: 'open-close', objectId: 'demo-armario-cozinha', from: 'fechado', to: 'aberto' },
      });
      assert.deepEqual((docs.get(statePath) as { openObjects: string[] }).openObjects, ['demo-armario-cozinha']);
      assert.match((await play('Examino o armário da cozinha.')).narration, /O armário está aberto\./);
      const afterOpening = [...docs];
      await assert.rejects(play('Escancaro o armário novamente.'), { code: 'PILOT_OPEN_CLOSE_ALREADY_SET', reason: 'aberto' });
      assert.deepEqual([...docs], afterOpening);
      assert.equal((await play('Fecho o armário.')).narration, 'O armário está fechado.');
      assert.deepEqual((docs.get(statePath) as { openObjects: string[] }).openObjects, []);
      assert.match((await play('Examino o armário.')).narration, /O armário está fechado\./);
      const closed = [...docs];
      await assert.rejects(play('Fecho o armário novamente.'), { code: 'PILOT_OPEN_CLOSE_ALREADY_SET', reason: 'fechado' });
      assert.equal((await persistPilotTurn(db, freixoPlayableCatalog, 'dono', open, failNarration)).narration, opened.narration);
      assert.deepEqual([...docs], closed);
      assert.deepEqual((docs.get(path) as typeof campaign).worldTime, afterWait.worldTime);
      assert.deepEqual([...docs].filter(([key]) => key.startsWith(inventoryPath + '/') || key === ownershipPath), untouchedItems);
      docs.set(path, { ...(docs.get(path) as typeof campaign), currentLocation: freixoWoodWorkshop });
      const distant = [...docs];
      await assert.rejects(play('Escancaro o armário da cozinha.'), { code: 'PILOT_OBJECT_OUT_OF_REACH' });
      assert.deepEqual([...docs], distant);
    } finally {
      docs.clear();
      for (const [key, value] of original) docs.set(key, value);
    }
  });
  await t.test('chegada às 11h persiste a posição, sem criar histórico de trabalho', async () => {
    const original = [...docs];
    const base = { ...afterObservation, currentLocation: workshop,
      worldTime: { ...afterObservation.worldTime, hour: 10, minute: 56 } };
    const failNarration = async () => assert.fail('espera, replay e pergunta factual dispensam narrador');
    docs.set(path, base);
    docs.set(npcPath + henrique.id, { ...henrique, campaignId: SERVER_PILOT_ID, location: familyYard });
    docs.set(statePath, { activities: [], observations: [], holds: [] });
    try {
      const wait = next('Espero 4 minutos.');
      const result = await persistPilotTurn(db, freixoPlayableCatalog, 'dono', wait, failNarration);
      assert.deepEqual((docs.get(path) as typeof campaign).worldTime, advanceWorldTime(base.worldTime, 4));
      assert.equal((docs.get(npcPath + henrique.id) as typeof henrique).location, workshop);
      assert.ok(!(docs.get(statePath) as { activities: { npcId: string }[] }).activities
        .some(({ npcId }) => npcId === henrique.id));

      const committed = structuredClone([...docs]);
      for (const [key, value] of committed) docs.set(key, value);
      assert.deepEqual(await persistPilotTurn(db, freixoPlayableCatalog, 'dono', wait, failNarration),
        { ...result, mode: 'replay' });
      assert.deepEqual([...docs], committed);
      const answer = await persistPilotTurn(db, freixoPlayableCatalog, 'dono',
        next('Henrique, o que você estava fazendo antes?'), failNarration);
      assert.equal(answer.narration, 'Henrique: “Não sei te dizer com certeza.”');
    } finally {
      docs.clear();
      for (const [key, value] of original) docs.set(key, value);
    }
  });

  await t.test('respostas factuais usam somente rotina, objeto e testemunho autorizados', async () => {
    const original = [...docs];
    const base = { ...afterObservation, currentLocation: familyKitchen };
    const originalRuntime = docs.get(statePath) as import('../src/engine/npcRoutine').NpcRoutineState;
    const failNarration = async () => assert.fail('pergunta factual não depende de narrador');
    const play = (declared: string, narrate: Parameters<typeof persistPilotTurn>[4] = failNarration) =>
      persistPilotTurn(db, freixoPlayableCatalog, 'dono', next(declared), narrate);
    docs.set(path, base);
    docs.set(npcPath + teresa.id, { ...teresa, campaignId: SERVER_PILOT_ID, location: familyKitchen });
    docs.set(npcPath + henrique.id, { ...henrique, campaignId: SERVER_PILOT_ID, location: freixoWoodWorkshop });
    docs.set(statePath, { ...originalRuntime, completedActivities: ['demo-organizar-cozinha'] });
    try {
      const before = [...docs];
      await assert.rejects(play('Henrique, no que você está trabalhando?'),
        { code: 'PILOT_SPEECH_UNAVAILABLE', absentNpcName: 'Henrique' });
      assert.deepEqual([...docs], before);
      const duplicatePath = npcPath + 'outra-teresa';
      docs.set(duplicatePath, { ...teresa, id: 'outra-teresa', campaignId: SERVER_PILOT_ID, location: familyKitchen });
      await assert.rejects(play('Teresa, como está a bancada da cozinha?'), { code: 'PILOT_SPEECH_UNAVAILABLE' });
      docs.delete(duplicatePath);
      assert.deepEqual([...docs], before);
      assert.match((await play('Teresa, como está a bancada da cozinha?')).narration, /A bancada está organizada/);
      assert.match((await play('Teresa, lembra que organizei a bancada?')).narration, /Não sei te dizer/);
      await play('Conto a Teresa: Organizei a bancada.', async () => 'Teresa escuta.');
      assert.match((await play('Teresa, lembra que organizei a bancada?')).narration, /Você me contou/);
      docs.set(statePath, { ...originalRuntime, completedActivities: [] });
      await play('Organizo a bancada.');
      assert.match((await play('Teresa, lembra que organizei a bancada?')).narration, /Vi você organizar/);
      assert.match((await play('Teresa, você viu Henrique sair?')).narration, /Vi Henrique sair/);
      assert.match((await play('Teresa, onde Henrique está?')).narration, /Não sei te dizer/);
      await play('Teresa, você gosta de música?', async (_scene, intent) => {
        assert.match(intent, /reação de Teresa/);
        return 'Teresa escuta a pergunta.';
      });
      docs.set(path, { ...(docs.get(path) as typeof campaign), currentLocation: freixoWoodWorkshop });
      const ask = next('Henrique, no que voce esta trabalhando?');
      await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, 'outro', ask, failNarration), { code: 'CAMPAIGN_ACCESS_DENIED' });
      await assert.rejects(persistPilotTurn(db, freixoPlayableCatalog, 'dono', { ...ask, campaignId: 'outra' }, failNarration),
        { code: 'CAMPAIGN_ACCESS_DENIED' });
      const answer = await persistPilotTurn(db, freixoPlayableCatalog, 'dono', ask, failNarration);
      assert.match(answer.narration, /Estou trabalhando a madeira na oficina/);
      const ids = await turnDocumentIds(ask);
      assert.partialDeepStrictEqual(docs.get(path + '/narrative/' + ids.engine),
        { content: answer.narration, privateRecipientId: henrique.id });
      const committed = [...docs];
      assert.equal((await persistPilotTurn(db, freixoPlayableCatalog, 'dono', ask, failNarration)).narration, answer.narration);
      assert.deepEqual([...docs], committed);
      assert.match((await play('Henrique, como está a bancada da cozinha?')).narration, /Não sei te dizer/);
      const reported = { ...originalRuntime, memories: [...(originalRuntime.memories ?? []), {
        npcId: henrique.id, timelineId: ask.baseTimelineId, sequence: base.lastSequence, turnId: ask.turnId,
        origin: { kind: 'reported' as const, reporterId: 'player' }, fact: 'Viu Teresa sair.',
      }] };
      docs.set(statePath, reported);
      assert.match((await play('Henrique, você viu Teresa sair?')).narration, /Não sei te dizer/);
      const current = docs.get(path) as typeof campaign;
      docs.set(statePath, { ...originalRuntime, holds: [{ npcId: henrique.id,
        until: advanceWorldTime(current.worldTime, 10), reason: 'commitment' }] });
      const occupied = [...docs];
      await assert.rejects(play('Henrique, você ainda está trabalhando?'), { code: 'PILOT_FACTUAL_NPC_OCCUPIED' });
      assert.deepEqual([...docs], occupied);
      docs.set(path, { ...current, worldTime: { ...current.worldTime, hour: 11, minute: 0 } });
      assert.match((await play('Henrique, você ainda está trabalhando?')).narration, /Já não estou/);
      assert.match((await play('Henrique, o que você estava fazendo antes?')).narration, /Eu estava trabalhando a madeira na oficina/);
      assert.deepEqual((docs.get(statePath) as typeof originalRuntime).memories, originalRuntime.memories);
      await play('Espero 40 minutos.');
      const afterWait = docs.get(path) as typeof campaign;
      docs.set(path, { ...afterWait, currentLocation: familyYard });
      const beforeQuestions = docs.get(statePath);
      assert.match((await play('Henrique, no que você está trabalhando?')).narration,
        /Agora não estou trabalhando\. Estou fazendo uma pausa no quintal\./);
      assert.match((await play('Henrique, o que você está fazendo?')).narration,
        /Henrique: “Estou fazendo uma pausa no quintal\.”/);
      assert.match((await play('Henrique, você ainda está trabalhando?')).narration,
        /Henrique: “Não\. Estou fazendo uma pausa no quintal\.”/);
      assert.match((await play('Henrique, o que você estava fazendo antes?')).narration,
        /Eu estava trabalhando a madeira na oficina/);
      assert.deepEqual(docs.get(statePath), beforeQuestions);
      assert.deepEqual((docs.get(path) as typeof campaign).worldTime, afterWait.worldTime);
      docs.set(statePath, { ...originalRuntime, activities: [] });
      assert.match((await play('Henrique, o que você está fazendo?')).narration, /Não sei te dizer com certeza/);
      assert.match((await play('Henrique, o que você estava fazendo antes?')).narration, /Não sei te dizer com certeza/);
    } finally {
      docs.clear();
      for (const [key, value] of original) docs.set(key, value);
    }
  });
  const inspect = async (declared: string, expected: string) => {
    const turn = next(declared);
    const before = docs.get(path) as typeof campaign;
    const result = await persistPilotTurn(db, householdCatalog, 'dono', turn, async (_scene, intent) => {
      assert.ok(intent.includes(expected));
      return 'A luz toca a superfície.';
    });
    assert.ok(result.narration.includes(expected));
    const after = docs.get(path) as typeof campaign;
    assert.deepEqual(after.worldTime, before.worldTime);
    assert.equal(after.currentLocation, before.currentLocation);
    const committed = [...docs];
    const replay = await persistPilotTurn(db, householdCatalog, 'dono', turn, async () => assert.fail('exame repetido'));
    assert.equal(replay.narration, result.narration);
    assert.deepEqual([...docs], committed);
  };
  await assert.rejects(persistPilotTurn(db, householdCatalog, 'dono', next('Examino aquele objeto.'),
    async () => assert.fail('a bancada na prosa não identifica um objeto')), { code: 'PILOT_OBJECT_AMBIGUOUS' });
  await inspect('Examino a bancada.', 'Ainda por organizar.');
  const help = next('Ajudo Teresa a organizar a cozinha.');
  const helped = await persistPilotTurn(db, householdCatalog, 'dono', help, async () => 'Os utensílios ficam alinhados.');
  assert.match(helped.narration, /A bancada ficou organizada/);
  await persistPilotTurn(db, householdCatalog, 'dono', help, async () => assert.fail('atividade repetida'));
  assert.deepEqual((docs.get(path) as typeof campaign).worldTime, advanceWorldTime(observeBefore.worldTime, 5));
  await inspect('Observo aquela bancada.', 'A bancada ficou organizada.');
  await inspect('Quero olhar mais de perto a bancada.', 'A bancada ficou organizada.');
  await inspect('Examino aquele objeto.', 'A bancada ficou organizada.');
  await inspect('Examino a bancada e observo aquele objeto.', 'A bancada ficou organizada.');
  const beforeInvalidObject = [...docs];
  for (const [action, code, catalog] of [
    ['Examino o jarro.', 'PILOT_OBJECT_UNREGISTERED', householdCatalog],
    ['Examino aquele objeto.', 'PILOT_OBJECT_OUT_OF_REACH', { ...householdCatalog,
      objects: householdCatalog.objects.map((object) => ({ ...object, location: workshop })) }],
  ] as const) {
    await assert.rejects(persistPilotTurn(db, catalog, 'dono', next(action), async () => assert.fail('exame indisponível')),
      { code });
    assert.deepEqual([...docs], beforeInvalidObject);
  }
  await assert.rejects(persistPilotTurn(db, householdCatalog, 'dono', next(help.declaredAction),
    async () => assert.fail('atividade já concluída')), /PILOT_ACTIVITY_UNAVAILABLE/);
  const statement = 'Talvez eu viaje.';
  const report = next('Conto a Teresa: ' + statement);
  await assert.rejects(persistPilotTurn(db, homeCatalog, 'outro', report, async () => assert.fail('usuário errado')),
    /CAMPAIGN_ACCESS_DENIED/);
  await assert.rejects(persistPilotTurn(db, homeCatalog, 'dono', { ...report, expectedRevision: afterTravel.revision },
    async () => assert.fail('revisão antiga')), /CONCURRENT_STATE_CONFLICT/);
  await assert.rejects(persistPilotTurn(db, homeCatalog, 'dono', { ...report, baseTimelineId: 'tl_outro' },
    async () => assert.fail('linha incorreta')), /CONCURRENT_STATE_CONFLICT/);
  await persistPilotTurn(db, homeCatalog, 'dono', report, async (_arrival, _intent, present, _relations, history, action) => {
    assert.equal(action, report.declaredAction);
    assert.ok(!present.memories.some(({ memories }) => memories.some(({ fact }) => fact === statement)));
    assert.ok(!history.some(({ content }) => content.includes(statement)));
    return 'Teresa escuta com atenção.';
  });
  await persistPilotTurn(db, homeCatalog, 'dono', report, async () => assert.fail('renarrou'));
  assert.equal((docs.get(statePath) as { relationships?: unknown }).relationships, undefined);
  await persistPilotTurn(db, homeCatalog, 'dono', next('Digo a Teresa: Bom dia.'), async (_arrival, _intent, present) => {
    assert.deepEqual(present.memories[0].memories.filter(({ source }) => source === 'reported'),
      [{ source: 'reported', speaker: campaign.protagonist.name, fact: statement }]);
    return 'Teresa sorri.';
  });
  await persistPilotTurn(db, homeCatalog, 'dono', next('Confidencio a Teresa: Bom dia!'), async () => 'Teresa sorri.');
  assert.equal((docs.get(statePath) as { relationships?: unknown }).relationships, undefined);
  const personal = next('Confidencio a Teresa: Tenho medo de sair de casa.');
  const beforeDisclosure = docs.get(statePath);
  await assert.rejects(persistPilotTurn(db, homeCatalog, 'dono', personal, async () => { throw new Error('sem narração'); }),
    /sem narração/);
  assert.equal(docs.get(statePath), beforeDisclosure);
  await persistPilotTurn(db, homeCatalog, 'dono', personal, async () => 'Teresa escuta.');
  await persistPilotTurn(db, homeCatalog, 'dono', personal, async () => assert.fail('renarrou'));
  const beforeScopedDialogue = [...docs];
  try {
    docs.set(npcPath + henrique.id, { ...henrique, campaignId: SERVER_PILOT_ID, location: home });
    await persistPilotTurn(db, homeCatalog, 'dono', next('Conto a Henrique: Amanhã talvez chova.'), async () => 'Henrique escuta.');
    await persistPilotTurn(db, homeCatalog, 'dono', next('Vou até a praça'), async () => 'Na praça, o sino toca.');
    const routineBeforeArrival = structuredClone(docs.get(statePath));
    const arrival = next('Vou até a casa');
    const arrived = await persistPilotTurn(db, homeCatalog, 'dono', arrival, async (campaign, intent, scene, relations, history, action) => {
      const context = buildNarratorContext({ campaign, inventory: [], npcs: scene.npcs, narrative: history,
        sceneKnowledge: scene.knowledge, npcMemories: scene.memories, npcActivities: scene.activities,
        npcRelationships: relations });
      const prompt = buildNarratorPrompt({ context, sceneIntent: intent, declaredAction: action });
      assert.deepEqual([...context.currentState.knownPresentNpcs].sort(), ['Henrique', 'Teresa']);
      assert.doesNotMatch(prompt, /Tenho medo de sair de casa|Talvez eu viaje|Amanhã talvez chova|Teresa escuta|Henrique escuta|privateNpcMemories|privateNpcRelationships/u);
      assert.match(prompt, /Contexto operacional de rotas/);
      assert.match(prompt, /Praça/);
      assert.match(prompt, /o sino toca/);
      return 'A luz entra pela janela.';
    });
    assert.deepEqual(docs.get(statePath), routineBeforeArrival);
    const afterArrival = [...docs];
    assert.equal((await persistPilotTurn(db, homeCatalog, 'dono', arrival, async () => assert.fail('renarrou'))).narration,
      arrived.narration);
    assert.deepEqual([...docs], afterArrival);
    await persistPilotTurn(db, homeCatalog, 'dono', next('Digo a Henrique: Bom dia.'), async (campaign, intent, scene, relations, history, action) => {
      assert.deepEqual(scene.npcs.map(({ id }) => id), [henrique.id]);
      const context = buildNarratorContext({ campaign, inventory: [], npcs: scene.npcs, narrative: history,
        sceneKnowledge: [...scene.knowledge, { source: 'public', fact: 'Freixo é uma vila.' }],
        npcMemories: scene.memories, npcActivities: scene.activities, npcRelationships: relations });
      const payload = buildNarratorPrompt({ context, sceneIntent: intent, declaredAction: action }) +
        JSON.stringify({ scene, relations, history });
      assert.doesNotMatch(payload, /Tenho medo de sair de casa|privateRecipientId.*Teresa escuta/);
      assert.match(payload, /Amanhã talvez chova/);
      assert.match(payload, /Freixo é uma vila/);
      assert.match(payload, /"source":"reported"/);
      return 'Henrique retribui.';
    });
    for (const invented of ['Samuel entrega uma ferramenta a Henrique.', 'Samuel decide abandonar Freixo.',
      'Samuel promete voltar amanhã e entrega sua espada.', 'Samuel pega o bloco de madeira.']) {
      const attempt = next('Digo a Henrique: Bom dia.');
      const result = await persistPilotTurn(db, homeCatalog, 'dono', attempt, async () => invented);
      assert.equal(result.narration, 'A conversa faz uma pausa.');
      assert.ok(!JSON.stringify([...docs]).includes(invented));
      const after = [...docs];
      assert.equal((await persistPilotTurn(db, homeCatalog, 'dono', attempt,
        async () => assert.fail('replay não renarra'))).narration, result.narration);
      assert.deepEqual([...docs], after);
    }
    const legitimate = 'Henrique pergunta: “Samuel, você prometeu voltar amanhã?”';
    assert.equal((await persistPilotTurn(db, homeCatalog, 'dono', next('Digo a Henrique: Bom dia.'),
      async () => legitimate)).narration, legitimate);
  } finally {
    docs.clear();
    for (const [key, value] of beforeScopedDialogue) docs.set(key, value);
  }
  const relationState = () => (docs.get(statePath) as { relationships: object[] }).relationships;
  const confirmed = relationState();
  assert.equal(confirmed.length, 1);
  await persistPilotTurn(db, homeCatalog, 'dono', next('Confidencio a Teresa: Sinto falta de casa.'), async () => 'Teresa escuta.');
  assert.deepEqual(relationState(), confirmed);
  await persistPilotTurn(db, homeCatalog, 'dono', next('Digo a Teresa: Até logo.'), async (_arrival, _intent, _present, relationships) => {
    assert.deepEqual(relationships, [{ character: 'Teresa', toward: 'protagonista', bond: 'family',
      familiarity: 'muito alta', trust: 'plena' }]);
    return 'Teresa retribui.';
  });
  await persistPilotTurn(db, { ...homeCatalog, routes: [...homeCatalog.routes, { from: home, to: workshop, minutes: 4 }] },
    'dono', next('Vou até a oficina'), async (_arrival, _intent, present) => {
      assert.equal(present.memories.length, 0);
      return 'Há tábuas junto à bancada.';
    });
  const lira = createWellEncounterNpc('dono', SERVER_PILOT_ID);
  docs.set(npcPath + lira.id, lira);
  const wellCatalog = {
    places: [...homeCatalog.places, { id: villageWell, aliases: ['poço'] },
      { id: familyKitchen, aliases: ['cozinha'] }, { id: familyYard, aliases: ['quintal'] }],
    routes: [...homeCatalog.routes, { from: workshop, to: villageWell, minutes: 4 },
      { from: villageWell, to: workshop, minutes: 4 },
      { from: villageWell, to: familyKitchen, minutes: 6 }, { from: villageWell, to: familyYard, minutes: 4 }],
  };
  const visit = next('Vou dar uma volta até o poço.');
  await assert.rejects(persistPilotTurn(db, wellCatalog, 'dono', visit, async () => { throw new Error('sem cena'); }), /sem cena/);
  const beforeConflict = [...docs];
  await assert.rejects(persistPilotTurn(db, wellCatalog, 'dono', visit,
    async () => 'Samuel abandona o poço e chega à cozinha.'), /PILOT_NARRATION_CONFLICT/);
  assert.deepEqual([...docs], beforeConflict);
  assert.deepEqual(relationState(), confirmed);
  const encounter = async (_arrival: unknown, _intent: unknown, present: { npcs: { name: string }[] },
    relationships: { character: string; familiarity: string }[]) => {
    assert.deepEqual(present.npcs.map(({ name }) => name), ['Lira']);
    assert.deepEqual(relationships, []);
    return 'Lira ajeita o balde.';
  };
  const arrival = await persistPilotTurn(db, wellCatalog, 'dono', visit, async (campaign, intent, present, relationships) => {
    await encounter(campaign, intent, present, relationships);
    assert.match(intent, /somente prosa narrativa, sem menus, listas ou cabeçalhos técnicos/);
    assert.doesNotMatch(intent, /Destinos disponíveis agora:/);
    return recordedGroqArrival;
  });
  assert.match(arrival.narration, /Lira/);
  assert.doesNotMatch(arrival.narration, /Após \d+ min|está à vista|Ali perto está Lira/);
  assert.ok(arrival.narration.endsWith(recordedGroqArrival.split('\n\n')[0].trim()));
  assert.doesNotMatch(arrival.narration, /Destinos disponíveis|^- /m);
  await persistPilotTurn(db, wellCatalog, 'dono', visit, async () => assert.fail('repetiu encontro'));
  const afterEncounter = relationState();
  assert.equal(afterEncounter.length, 2);
  await persistPilotTurn(db, wellCatalog, 'dono', next('Vou até a oficina'), async () => 'Há tábuas junto à bancada.');
  await assert.rejects(persistPilotTurn(db, wellCatalog, 'dono', next('Dou bom dia para ela'),
    async () => assert.fail('sem destinatária compatível')), /PILOT_SPEECH_UNAVAILABLE/);
  const revisit = await persistPilotTurn(db, wellCatalog, 'dono', next('Vou até o poço'), async () =>
    `Samuel chega ao poço. Há água perto de Samuel. O balde leva minutos para encher. A cozinha fica na casa da família. Uma placa diz: ${familyKitchen}.`);
  assert.match(revisit.narration, /A cozinha fica na casa da família/);
  assert.match(revisit.narration, new RegExp(familyKitchen));
  assert.doesNotMatch(revisit.narration, /Samuel chega ao poço\./);
  assert.deepEqual(relationState(), afterEncounter);
  const neighbor = { ...lira, id: 'outra-moradora', name: 'Outra moradora' };
  docs.set(npcPath + neighbor.id, neighbor);
  const beforeAmbiguity = [...docs];
  await assert.rejects(persistPilotTurn(db, wellCatalog, 'dono', next('Dou bom dia para ela'),
    async () => assert.fail('destinatária ambígua')), /PILOT_SPEECH_UNAVAILABLE/);
  assert.deepEqual([...docs], beforeAmbiguity);
  docs.delete(npcPath + neighbor.id);
  const beforeGreetingAtWell = docs.get(path) as typeof campaign;
  const indirect = next('dou bom dia para Lira');
  await persistPilotTurn(db, wellCatalog, 'dono', indirect, async (_scene, intent) => {
    assert.match(intent, /reação de Lira/);
    assert.match(intent, /discurso indireto/);
    return 'Lira retribui o cumprimento.';
  });
  const afterGreetingAtWell = docs.get(path) as typeof campaign;
  assert.equal(afterGreetingAtWell.currentLocation, villageWell);
  assert.deepEqual(afterGreetingAtWell.worldTime, beforeGreetingAtWell.worldTime);
  assert.deepEqual(relationState(), afterEncounter);
  docs.set(npcPath + neighbor.id, neighbor);
  for (const action of ['Cumprimento Lira', 'Bom dia, Lira!', 'Pergunto a ela como está',
    'Pergunto se ela está bem.', 'Como você está?', 'Queria saber como foi o dia dela.',
    'Lira, você está bem?', 'Até logo!', 'Quero conversar com ela']) {
    await persistPilotTurn(db, wellCatalog, 'dono', next(action), async (_scene, intent, _present, _relations, history) => {
      assert.match(intent, /reação de Lira/);
      if (action.startsWith('Quero')) assert.match(intent, /ainda não disse nada/);
      if (action === 'Cumprimento Lira') assert.ok(history.some(({ content }) => content === indirect.declaredAction));
      return 'Lira se volta para a conversa.';
    });
  }
  docs.delete(npcPath + neighbor.id);
  await t.test('contexto da primeira etapa resolve pessoa e ambiente na segunda', async () => {
    const original = [...docs] as const;
    const contextual = async (_scene: typeof campaign, intent: string) => {
      assert.match(intent, /Lira/);
      return 'Lira ajeita o balde.';
    };
    await persistPilotTurn(db, wellCatalog, 'dono', next('Observo Lira e observo o que ela está fazendo.'), contextual);
    await persistPilotTurn(db, wellCatalog, 'dono', next('Observo Lira.'), contextual);
    await persistPilotTurn(db, wellCatalog, 'dono', next('Observo o que ela está fazendo.'), contextual);
    const beforeTravel = [...docs];
    await assert.rejects(persistPilotTurn(db, wellCatalog, 'dono',
      next('Vou até o quintal e observo o que ela está fazendo.'), async () => assert.fail('sequência recusada não narra')),
      { code: 'PILOT_OBSERVATION_UNAVAILABLE', step: 2, absentNpcName: 'Lira' });
    assert.deepEqual([...docs], beforeTravel);
    await persistPilotTurn(db, wellCatalog, 'dono', next('Digo para ela: Bom dia.'), contextual);
    // Establish a place within the same bounded history window used by Firestore.
    await persistPilotTurn(db, wellCatalog, 'dono', next('Observo o poço.'), async () => 'A água reflete a luz.');
    await persistPilotTurn(db, wellCatalog, 'dono', next('Observo aquele lugar.'), async (_scene, intent) => {
      assert.ok(intent.includes(villageWell));
      return 'A água reflete a luz.';
    });
    docs.set(npcPath + lira.id, { ...lira, location: workshop });
    docs.set(npcPath + neighbor.id, neighbor);
    const before = [...docs];
    await assert.rejects(persistPilotTurn(db, wellCatalog, 'dono',
      next('Observo o que Lira está fazendo.'), async () => assert.fail('ausência não chama o narrador')), (error) => {
      if (!(error instanceof PilotTurnError) || error.code !== 'PILOT_OBSERVATION_UNAVAILABLE') return false;
      const message = describePilotFeedback(error, false);
      assert.equal(message, 'Samuel não consegue observar Lira daqui. Essa pessoa não está presente neste local.');
      return true;
    });
    await assert.rejects(persistPilotTurn(db, wellCatalog, 'dono',
      next('Observo o que uma pessoa desconhecida está fazendo.'), async () => assert.fail('alvo desconhecido não narra')),
    (error) => error instanceof PilotTurnError && describePilotFeedback(error, false) ===
      'Indique o ambiente atual ou uma pessoa presente que você possa observar.');
    await assert.rejects(persistPilotTurn(db, wellCatalog, 'dono',
      next('Observo o poço e observo ela.'), async () => assert.fail('sequência recusada não narra')),
      { code: 'PILOT_OBSERVATION_UNAVAILABLE', step: 2, absentNpcName: 'Lira' });
    assert.deepEqual([...docs], before);
    await persistPilotTurn(db, wellCatalog, 'dono', next('Observo Outra moradora.'),
      async () => 'A moradora ajeita o balde.');
    docs.clear();
    for (const [key, value] of original) docs.set(key, value);
  });
  await assert.rejects(persistPilotTurn(db, wellCatalog, 'dono', next('Teresa, precisa de ajuda?'),
    async () => assert.fail('destinatária ausente')), /PILOT_SPEECH_UNAVAILABLE/);
  await assert.rejects(persistPilotTurn(db, wellCatalog, 'dono', next('Vou até o poço ou o quintal.'),
    async () => assert.fail('deslocamento ambíguo')), /PILOT_TRAVEL_UNAVAILABLE/);
  await persistPilotTurn(db, wellCatalog, 'dono', next('Quero conversar com aquela garota.'), async (_scene, intent) => {
    assert.match(intent, /Lira/);
    assert.match(intent, /ainda não disse nada/);
    return 'Lira afasta o balde e aguarda.';
  });
  await persistPilotTurn(db, wellCatalog, 'dono', next('Conto a Lira: Volto amanhã.'), async () => 'Lira escuta.');
  await persistPilotTurn(db, wellCatalog, 'dono', next('Digo a Lira: Bom dia.'), async (campaign, intent, present, _relations, narrative) => {
    assert.deepEqual(present.memories, [{ name: 'Lira',
      memories: [{ source: 'reported', fact: 'Volto amanhã.', speaker: campaign.protagonist.name }] }]);
    const history = buildNarratorContext({ campaign, npcs: present.npcs, narrative, inventory: [] }).recentActiveHistory;
    assert.deepEqual(history.slice(-2).map(({ content }) => content), ['Conto a Lira: Volto amanhã.', 'Lira escuta.']);
    assert.ok(!history.some(({ content }) => content.includes('Tenho medo de sair de casa')));
    assert.match(intent, /Só indique como caminho confirmado uma rota deste contexto/);
    assert.match(intent, /Oficina de Madeira/);
    return 'Lira retribui.';
  });
  await persistPilotTurn(db, wellCatalog, 'dono', next('Conto para Lira que estou pensando em viajar.'),
    async (_scene, intent) => {
      assert.match(intent, /reação de Lira/);
      assert.match(intent, /discurso indireto/);
      return 'Lira escuta.';
    });
  const sequenceCatalog = {
    ...wellCatalog, routes: [...wellCatalog.routes, { from: villageWell, to: home, minutes: 6 },
      { from: home, to: villageWell, minutes: 6 }],
    objects: [{ id: 'bancada-teste', name: 'bancada', aliases: [], location: home, description: 'Bancada de madeira.' }],
  };
  const dispatch = (action: string, narrate: Parameters<typeof persistPilotTurn>[4]) =>
    persistPilotTurn(db, sequenceCatalog, 'dono', next(action), narrate);
  await t.test('B — recusa na segunda etapa preserva o estado e libera o próximo comando', async () => {
    const untouched = [...docs];
    for (const [declared, code, step] of [
      ['Vou até a casa e examino o jarro.', 'PILOT_OBJECT_UNREGISTERED', 2],
      ['Vou até a casa e examino aquele objeto.', 'PILOT_OBJECT_AMBIGUOUS', 2],
      ['Observo o poço e examino a bancada.', 'PILOT_OBJECT_OUT_OF_REACH', 2],
      ['Pergunto se ela está bem, depois vou até a casa.', 'PILOT_SEQUENCE_NEEDS_REPLY', 1],
      ['Observo o poço; examino o poço; observo o poço.', 'PILOT_SEQUENCE_LIMIT', 3],
    ] as const) {
      await assert.rejects(dispatch(declared, async () => assert.fail('planejamento inválido não narra')),
        { code, step }, declared);
      assert.deepEqual([...docs], untouched, 'Estado e documentos após a recusa de: ' + declared);
    }
    await dispatch('Observo o poço e examino o poço.', async () => 'O poço tem uma borda de pedra.');
  });
  await dispatch('Observo o poço; digo a Lira: Bom dia.', async (_scene, intent, present, _relations, _history, declared) => {
    assert.ok(present.npcs.some(({ name }) => name === 'Lira'));
    if (declared.startsWith('digo')) assert.match(intent, /reação de Lira/);
    return 'Lira está junto à borda.';
  });
  await dispatch('Vou até a casa e depois examino a bancada.',
    async (scene, intent, _present, _relations, _history, declared) => {
      assert.equal(scene.currentLocation, home);
      if (declared.startsWith('examino')) assert.match(intent, /Bancada de madeira/);
      return 'Há marcas na madeira.';
    });
  await t.test('A — deslocamento e observação em ordem, com evento e recibo', async (scenario) => {
    const beforeSequence = docs.get(path) as typeof campaign;
    const chain = next('Vou até o poço e observo o poço.');
    const actions: string[] = [];
    const chained = await persistPilotTurn(db, sequenceCatalog, 'dono', chain,
      async (scene, _intent, _present, _relations, _history, declared) => {
        assert.equal(scene.currentLocation, villageWell, 'Local projetado durante: ' + declared);
        actions.push(declared);
        return 'O poço tem uma borda de pedra.';
      });
    assert.deepEqual(actions, ['Vou até o poço', 'observo o poço.']);
    const afterSequence = docs.get(path) as typeof campaign;
    assert.equal(afterSequence.currentLocation, villageWell);
    assert.equal(afterSequence.revision, beforeSequence.revision + 1);
    assert.equal(afterSequence.lastSequence, beforeSequence.lastSequence + 3);
    assert.deepEqual(afterSequence.worldTime, advanceWorldTime(beforeSequence.worldTime, 6));
    const ids = await turnDocumentIds(chain);
    assert.partialDeepStrictEqual(docs.get(path + '/events/' + ids.event), {
      type: 'PLAYER_ACTION', sequence: afterSequence.lastSequence,
    });
    assert.partialDeepStrictEqual(docs.get(path + '/turnReceipts/' + chain.turnId), {
      turn: chain, playerEntryId: ids.player, outcome: { location: villageWell, elapsedMinutes: 6 },
      plan: { kind: 'sequence', steps: [{ intent: { kind: 'travel' } }, { kind: 'observation' }] },
    });

    await scenario.test('C — replay devolve a narração sem duplicar efeitos', async () => {
      const saved = [...docs];
      const replay = await persistPilotTurn(db, sequenceCatalog, 'dono', chain, async () => assert.fail('replay não narra'));
      assert.equal(replay.mode, 'replay');
      assert.equal(replay.narration, chained.narration);
      assert.deepEqual([...docs], saved);
    });
  });
});

test('avanço curto conserva o dia da semana e meia-noite avança o calendário', () => {
  const start = createEchoArcBundle('dono').campaign.worldTime;
  const sameDay = advanceWorldTime(start, 6);
  assert.deepEqual([sameDay.day, sameDay.weekday, sameDay.minute], [14, 'Lunis', 36]);
  const midnight = advanceWorldTime({ ...start, hour: 23, minute: 59 }, 1);
  assert.deepEqual([midnight.day, midnight.weekday, midnight.hour], [15, 'Terris', 0]);
});

test('contenção distingue afirmações de hipóteses, negações e fala atribuída', () => {
  for (const prose of [
    'Samuel, você prometeu voltar amanhã?',
    'Se Samuel entrega a ferramenta, Henrique pode guardá-la.',
    'Samuel não entrega a ferramenta.',
    'Henrique diz: “Eu pego a caixa.”',
    'Henrique lembra que Samuel entregou o bloco ontem.',
  ]) assert.equal(claimsUnconfirmedPlayerConsequence(prose), false, prose);
  assert.equal(claimsUnconfirmedPlayerConsequence('Henrique acena e Samuel entrega a espada.'), true);
  assert.equal(claimsUnconfirmedPlayerConsequence('Samuel se compromete a voltar.'), true);
});
