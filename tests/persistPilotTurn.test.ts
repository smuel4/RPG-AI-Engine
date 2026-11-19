import assert from 'node:assert/strict';
import test from 'node:test';
import type { Firestore } from 'firebase-admin/firestore';
import { persistPilotTurn, SERVER_PILOT_ID } from '../server/persistPilotTurn';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { advanceWorldTime } from '../src/engine/rulesEngine';
import { createWellEncounterNpc, villageWell } from '../src/engine/echoArcEncounters';
import { buildNarratorContext } from '../server/narratorMemory';
import { familyKitchen } from '../scripts/echoArcContinuityFixture';
import { familyYard } from '../scripts/echoArcFreeTurn';
import { requestNarratorTurn } from '../src/services/narratorClient';

const recordedGroqArrival = "O poço da Vila de Freixo surge como um círculo de pedra escura ladeado por trepadeiras de flores silvestres, onde a água reflete o céu matutino ainda levemente rosado. Ao redor, alguns aldeões carregam baldes de madeira; um velho pescador bate o pé na borda, enquanto duas crianças correm entre as sombras das casas, lançando risos que se perdem no canto do vento. Lira, de cabelos trançados e avental manchado de terra, está inclinada sobre o balde, enchendo‑o com cuidado antes de virar-se para conversar com quem se aproximar.  \n\n**Destinos disponíveis agora:**  \n- Quintal da casa da família, Vila de Freixo  \n- Cozinha da casa da família, Vila de Freixo";

test('turno servidor aplica a rota e recupera o recibo sem narrar de novo', async (t) => {
  const campaign = { ...createEchoArcBundle('dono').campaign, id: SERVER_PILOT_ID, currentLocation: 'Porto' };
  const path = 'campaigns/' + SERVER_PILOT_ID;
  const docs = new Map<string, object>([[path, campaign]]);
  const collection = (parent: string) => ({
    doc: (id: string) => ({ path: parent + '/' + id, collection: (name: string) => collection(parent + '/' + id + '/' + name) }),
    where: () => ({ limit: () => ({ parent }) }),
    orderBy: () => ({ limit: () => ({ parent }) }),
  });
  const db = {
    collection,
    async runTransaction<T>(fn: (tx: object) => Promise<T>) {
      const writes = new Map<string, object>();
      const result = await fn({
        getAll: async (...refs: { path: string }[]) => refs.map(({ path }) =>
          ({ exists: docs.has(path), data: () => docs.get(path) })),
        get: async (ref: { path: string } | { parent: string }) => {
          if ('path' in ref) return { data: () => docs.get(ref.path) };
          const records = [...docs].filter(([path]) => path.startsWith(ref.parent + '/'));
          return { size: records.length, docs: records.map(([path, value]) =>
            ({ id: path.split('/').at(-1), data: () => value })) };
        },
        set: ({ path }: { path: string }, data: object) => writes.set(path, data),
        update: ({ path }: { path: string }, data: object) => writes.set(path, { ...docs.get(path), ...data }),
        create: ({ path }: { path: string }, data: object) => writes.set(path, data),
      });
      for (const [key, value] of writes) docs.set(key, value);
      return result;
    },
  } as unknown as Firestore;
  const turn = { turnId: crypto.randomUUID(), campaignId: SERVER_PILOT_ID, declaredAction: 'Vou até a praça',
    advanceMinutes: 720, expectedRevision: campaign.revision, baseTimelineId: campaign.activeTimelineId || 'tl_root' };
  const catalog = { places: [{ id: 'Porto', aliases: [] }, { id: 'Praça', aliases: [] }],
    routes: [{ from: 'Porto', to: 'Praça', minutes: 8 }] };
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
  await inspect('Examino a bancada.', 'Ainda por organizar.');
  const help = next('Ajudo Teresa a organizar a cozinha.');
  const helped = await persistPilotTurn(db, householdCatalog, 'dono', help, async () => 'Os utensílios ficam alinhados.');
  assert.match(helped.narration, /A bancada ficou organizada/);
  await persistPilotTurn(db, householdCatalog, 'dono', help, async () => assert.fail('atividade repetida'));
  assert.deepEqual((docs.get(path) as typeof campaign).worldTime, advanceWorldTime(observeBefore.worldTime, 5));
  await inspect('Observo aquela bancada.', 'A bancada ficou organizada.');
  await inspect('Quero olhar mais de perto a bancada.', 'A bancada ficou organizada.');
  const beforeInvalidObject = [...docs];
  for (const [action, code, catalog] of [
    ['Examino aquele objeto.', 'PILOT_OBJECT_AMBIGUOUS', householdCatalog],
    ['Examino o jarro.', 'PILOT_OBJECT_UNREGISTERED', householdCatalog],
    ['Examino a bancada.', 'PILOT_OBJECT_OUT_OF_REACH', { ...householdCatalog,
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
  await persistPilotTurn(db, homeCatalog, 'dono', report, async () => 'Teresa escuta com atenção.');
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
    assert.deepEqual(relationships, [{ character: 'Lira', toward: 'protagonista', bond: 'unspecified', familiarity: 'inicial' }]);
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
  const indirect = next('dou bom dia para ela');
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
      assert.ok(!history.some(({ content }) => content === indirect.declaredAction));
      return 'Lira se volta para a conversa.';
    });
  }
  docs.delete(npcPath + neighbor.id);
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
  const untouched = [...docs];
  for (const [declared, code, step] of [
    ['Vou até a casa e examino o jarro.', 'PILOT_OBJECT_UNREGISTERED', 2],
    ['Vou até a casa e examino aquele objeto.', 'PILOT_OBJECT_AMBIGUOUS', 2],
    ['Observo o poço e examino a bancada.', 'PILOT_OBJECT_OUT_OF_REACH', 2],
    ['Pergunto se ela está bem, depois vou até a casa.', 'PILOT_SEQUENCE_NEEDS_REPLY', 1],
    ['Observo o poço; examino o poço; observo o poço.', 'PILOT_SEQUENCE_LIMIT', 3],
  ] as const) {
    await assert.rejects(dispatch(declared, async () => assert.fail('planejamento inválido não narra')), { code, step });
    assert.deepEqual([...docs], untouched);
  }
  await dispatch('Observo o poço e examino o poço.', async () => 'O poço tem uma borda de pedra.');
  await dispatch('Observo o poço; digo a Lira: Bom dia.', async (_scene, intent, present, _relations, _history, declared) => {
    assert.ok(present.npcs.some(({ name }) => name === 'Lira'));
    if (declared.startsWith('digo')) assert.match(intent, /reação de Lira/);
    return 'Lira está junto à borda.';
  });
  const beforeSequence = docs.get(path) as typeof campaign;
  const chain = next('Vou até a casa e depois examino a bancada.');
  let count = 0;
  const chained = await persistPilotTurn(db, sequenceCatalog, 'dono', chain, async (scene, intent) => {
    count++;
    assert.equal(scene.currentLocation, home);
    if (count === 2) assert.match(intent, /Bancada de madeira/);
    return 'Há marcas na madeira.';
  });
  assert.equal(count, 2);
  const afterSequence = docs.get(path) as typeof campaign;
  assert.equal(afterSequence.currentLocation, home);
  assert.equal(afterSequence.revision, beforeSequence.revision + 1);
  assert.equal(afterSequence.lastSequence, beforeSequence.lastSequence + 3);
  assert.deepEqual(afterSequence.worldTime, advanceWorldTime(beforeSequence.worldTime, 6));
  const saved = [...docs];
  const replay = await persistPilotTurn(db, sequenceCatalog, 'dono', chain, async () => assert.fail('replay não narra'));
  assert.equal(replay.narration, chained.narration);
  assert.deepEqual([...docs], saved);
});

test('avanço curto conserva o dia da semana e meia-noite avança o calendário', () => {
  const start = createEchoArcBundle('dono').campaign.worldTime;
  const sameDay = advanceWorldTime(start, 6);
  assert.deepEqual([sameDay.day, sameDay.weekday, sameDay.minute], [14, 'Lunis', 36]);
  const midnight = advanceWorldTime({ ...start, hour: 23, minute: 59 }, 1);
  assert.deepEqual([midnight.day, midnight.weekday, midnight.hour], [15, 'Terris', 0]);
});
