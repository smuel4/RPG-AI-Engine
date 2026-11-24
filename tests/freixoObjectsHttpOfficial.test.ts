import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { SERVER_PILOT_ID } from '../server/persistPilotTurn';
import { selectOwnedCampaignId } from '../src/engine/pilotCampaign';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import type { Campaign } from '../src/types/game';
import { villageWell } from '../src/engine/echoArcEncounters';
import { freixoWoodland } from '../src/world/freixo';
import { freixoWoodWorkshop } from '../src/engine/npcIdentity';
import { familyYard } from '../scripts/echoArcFreeTurn';
import { familyKitchen } from '../scripts/echoArcContinuityFixture';
import { advanceWorldTime } from '../src/engine/rulesEngine';
import { NarratorRequestError, requestNarratorTurn, requestPilotScene } from '../src/services/narratorClient';
import { freixoEmulatorPorts } from '../server/freixoEmulatorPorts.mjs';

test('exame e atividade da bancada pela API local com Auth e Firestore emulados', async (t) => {
  const ports = freixoEmulatorPorts(process.env.FREIXO_TEST_ALT_PORTS === '1');
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:' + ports.firestore);
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:' + ports.auth);
  const projectId = 'demo-rpg-ai-engine';
  const database = 'ai-studio-31936b9f-7516-468c-9cf4-6dd4da7fb704';
  const base = 'http://127.0.0.1:' + ports.http;
  const http = globalThis.fetch;
  const admin = initializeApp({ projectId }, 'object-http-test');
  const db = getFirestore(admin, database);
  const ref = db.collection('campaigns').doc(SERVER_PILOT_ID);
  const auth = getAuth(admin);
  const authRequest = async (operation: 'signUp' | 'signInWithPassword', credentials = {}) => {
    const response = await http(`http://127.0.0.1:${ports.auth}/identitytoolkit.googleapis.com/v1/accounts:${operation}?key=demo`, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...credentials, returnSecureToken: true }),
    });
    assert.equal(response.status, 200);
    const { idToken } = await response.json() as { idToken: string };
    return { idToken, claims: await auth.verifyIdToken(idToken) };
  };
  const temporaryAccount = async (emailVerified: boolean) => {
    const email = 'freixo-' + crypto.randomUUID() + '@example.test';
    const password = crypto.randomUUID();
    const user = await auth.createUser({ email, password, emailVerified });
    const account = await authRequest('signInWithPassword', { email, password });
    assert.equal(account.claims.uid, user.uid);
    assert.equal(account.claims.email_verified === true, emailVerified);
    return account;
  };
  try {
    assert.equal((await ref.get()).exists, false, 'Use um emulador descartável sem campanha piloto existente.');
    const prepare = async () => {
      await promisify(execFile)(process.execPath,
        ['--import', 'tsx', 'scripts/validacao-mundo-vivo.ts', '--preparar-site'],
        { env: { ...process.env, FIREBASE_PROJECT_ID: projectId }, windowsHide: true, timeout: 120_000 });
    };
    await prepare();
    const seed = (await ref.get()).data() as Campaign;
    const npcCollection = ref.collection('npcs');
    const npcs = await npcCollection.get();
    assert.deepEqual(npcs.docs.map((doc) => doc.data().name).sort(), ['Henrique', 'Lira', 'Teresa']);
    const originalHenrique = npcs.docs.find((doc) => doc.data().name === 'Henrique')!;
    assert.equal(originalHenrique.data().location, freixoWoodWorkshop);
    const checkpoint = ref.collection('checkpoints').doc('teste-preparacao');
    await checkpoint.create({ ownerId: seed.ownerId, revision: seed.revision });
    const savedCheckpoint = (await checkpoint.get()).data();
    await originalHenrique.ref.delete();
    const survivingNpcs = (await npcCollection.get()).docs.map((doc) => doc.data());
    await prepare();
    const repaired = (await npcCollection.get()).docs.map((doc) => doc.data());
    assert.deepEqual(repaired.map(({ name }) => name).sort(), ['Henrique', 'Lira', 'Teresa']);
    assert.deepEqual(repaired.filter(({ name }) => name !== 'Henrique'), survivingNpcs);
    const henrique = repaired.find(({ name }) => name === 'Henrique')!;
    // Place Henrique on the approach so the actual clock-driven trip is exercised.
    await npcCollection.doc(henrique.id).update({ location: familyYard });
    const beforeRepeat = (await npcCollection.get()).docs.map((doc) => doc.data());
    await prepare();
    assert.deepEqual((await npcCollection.get()).docs.map((doc) => doc.data()), beforeRepeat);
    assert.deepEqual((await ref.get()).data(), seed);
    assert.deepEqual((await checkpoint.get()).data(), savedCheckpoint);
    const morning = { ...seed.worldTime, hour: 10, minute: 37 };
    await ref.update({ worldTime: morning });
    const password = crypto.randomUUID();
    const { email } = await auth.updateUser(seed.ownerId, { password });
    const owner = await authRequest('signInWithPassword', { email, password });
    assert.equal(owner.claims.uid, seed.ownerId);
    const outsider = await temporaryAccount(true);
    const unverified = await temporaryAccount(false);
    const anonymous = await authRequest('signUp');
    assert.notEqual(anonymous.claims.email_verified, true);
    const startServer = async () => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { windowsHide: true, stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'development', VITE_FREIXO_LOCAL: 'true', TURN_PLAN_SERVER_COMMIT: 'true',
          NARRATOR_MODE: 'fixed', DISABLE_HMR: 'true', FIREBASE_PROJECT_ID: projectId,
          FIRESTORE_DATABASE_ID: database, PORT: String(ports.http) } });
      t.after(() => { child.kill(); });
      for (let attempt = 0; attempt < 120 && child.exitCode === null; attempt++) {
        const health = await http(base + '/api/health').catch(() => null);
        if (health?.ok && (await health.json()).narratorMode === 'fixed') return child;
        await delay(500);
      }
      assert.fail('Servidor HTTP do piloto não iniciou.');
    };
    const server = await startServer();
    let loseConfirmation = false;
    let lostNarration: string | undefined;
    t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
      const response = await http(base + url, options);
      if (loseConfirmation && response.ok) {
        loseConfirmation = false;
        lostNarration = (await response.json()).narration;
        throw new TypeError('Confirmação perdida pelo cliente');
      }
      return response;
    });
    const state = async () => (await ref.get()).data()!;
    const submit = async (declaredAction: string, idToken = owner.idToken) => {
      const { revision, activeTimelineId } = await state();
      const send = () => requestNarratorTurn(idToken, { campaignId: ref.id, declaredAction, advanceMinutes: 10,
        turn: { turnId, expectedRevision: revision, baseTimelineId: activeTimelineId ?? 'tl_root' } });
      const turnId = crypto.randomUUID();
      return { result: await send(), send };
    };
    const snapshot = async () => Promise.all([state(), ...['npcs', 'npcRoutineState', 'narrative', 'events', 'turnReceipts',
      'inventory', 'pilotObjectLocations']
      .map(async (collection) => (await ref.collection(collection).get()).docs.map((doc) => [doc.id, doc.data()]))]);
    const initial = await snapshot();
    const ordinary = createEchoArcBundle(owner.claims.uid).campaign;
    const ordinaryRef = ref.parent.doc(ordinary.id);
    await ordinaryRef.create(ordinary);
    assert.equal(selectOwnedCampaignId([ordinary, seed], ordinary.id, true), ref.id);
    await assert.rejects(requestNarratorTurn(owner.idToken, {
      campaignId: ordinary.id, declaredAction: 'Vou ao quintal.', advanceMinutes: 10,
      turn: { turnId: crypto.randomUUID(), expectedRevision: ordinary.revision,
        baseTimelineId: ordinary.activeTimelineId ?? 'tl_root' },
    }), { code: 'DEMO_CAMPAIGN_REQUIRED', status: 400 });
    assert.deepEqual((await ordinaryRef.get()).data(), ordinary);
    assert.deepEqual(await snapshot(), initial);
    const readScene = () => requestPilotScene(owner.idToken, new AbortController().signal);
    const kitchen = await readScene();
    assert.equal(kitchen.location, familyKitchen);
    assert.equal(kitchen.revision, seed.revision);
    assert.equal(kitchen.timelineId, seed.activeTimelineId ?? 'tl_root');
    assert.deepEqual(kitchen.people.map(({ name, available }) => [name, available]), [['Teresa', true]]);
    assert.deepEqual(kitchen.landmarks.map(({ name }) => name), ['armário', 'bancada']);
    assert.ok(kitchen.exits.some(({ id }) => id === villageWell));
    assert.ok(!kitchen.exits.some(({ id }) => id === freixoWoodWorkshop));
    assert.equal((await http(base + '/api/freixo/scene')).status, 401);
    assert.equal((await http(base + '/api/freixo/scene', {
      headers: { Authorization: 'Bearer ' + outsider.idToken },
    })).status, 403);
    await assert.rejects(submit('Observo o que ele está fazendo.'), {
      code: 'PILOT_OBSERVATION_UNAVAILABLE',
      message: 'Indique o ambiente atual ou uma pessoa presente que você possa observar.',
    });
    await assert.rejects(submit('Examino a bancada.', anonymous.idToken), { code: 'AUTH_REQUIRED' });
    await assert.rejects(submit('Examino a bancada.', unverified.idToken), { code: 'AUTH_REQUIRED' });
    await assert.rejects(submit('Examino a bancada.', outsider.idToken), { code: 'CAMPAIGN_ACCESS_DENIED' });
    assert.deepEqual(await snapshot(), initial);
    assert.match((await submit('Examino a bancada.')).result.narration, /ainda está por organizar/);
    assert.deepEqual((await state()).worldTime, morning);
    const henriqueRef = npcCollection.doc(henrique.id);
    assert.equal((await henriqueRef.get()).data()?.location, familyYard);
    const organized = await submit('Organizo a bancada da cozinha.');
    const routineRef = ref.collection('npcRoutineState').doc(seed.activeTimelineId ?? 'tl_root');
    const activity = /trabalhar a madeira na oficina/i;
    assert.equal((await state()).currentLocation, familyKitchen);
    assert.deepEqual((await state()).worldTime, advanceWorldTime(morning, 5));
    assert.equal((await henriqueRef.get()).data()?.location, freixoWoodWorkshop);
    assert.match((await routineRef.get()).data()?.activities
      .find(({ npcId }: { npcId: string }) => npcId === henrique.id)?.activity ?? '', activity);
    assert.ok((await routineRef.get()).data()?.activities.some(({ npcId, location }: { npcId: string; location: string }) =>
      npcId === kitchen.people[0].id && location === familyKitchen));
    const afterMove = await snapshot();
    assert.match(organized.result.narration, /ficou organizada/);
    assert.equal((await organized.send()).narration, organized.result.narration);
    await assert.rejects(submit('Organizo a bancada novamente.'), { code: 'PILOT_ENVIRONMENT_ALREADY_ORGANIZED' });
    assert.deepEqual(await snapshot(), afterMove);
    const examined = await submit('Examino aquele objeto.');
    assert.match(examined.result.narration, /A bancada está organizada/);
    const confirmed = await snapshot();
    assert.equal((await examined.send()).mode, 'replay');
    assert.deepEqual(await snapshot(), confirmed);
    await submit('Bom dia, mãe!');
    await submit('Observo a cozinha.');
    assert.equal((await state()).currentLocation, familyKitchen);
    assert.deepEqual((await state()).worldTime, advanceWorldTime(morning, 5));
    const beforeInvalidSequence = await snapshot();
    await assert.rejects(submit('Vou até o poço e examino a bancada da cozinha.'),
      { code: 'PILOT_OBJECT_OUT_OF_REACH', message: /^Etapa 2\..*“bancada da cozinha”.*local previsto \(poço\)/,
        gameplayFeedback: true },
      'B — a segunda etapa deve indicar por que o objeto está fora de alcance e como prosseguir');
    await assert.rejects(submit('Vou até o poço e examino aquele objeto.'),
      { code: 'PILOT_OBJECT_OUT_OF_REACH', message: /^Etapa 2\./ },
      'B — a referência à bancada da cozinha não atravessa o deslocamento');
    assert.deepEqual(await snapshot(), beforeInvalidSequence, 'B — a recusa deve preservar a campanha e seus documentos');
    const journey = await submit('Vou até o poço e observo o poço.');
    const afterJourney = await snapshot();
    assert.equal((await journey.send()).narration, journey.result.narration, 'C — o reenvio deve retornar a narração anterior');
    assert.deepEqual(await snapshot(), afterJourney, 'C — o reenvio deve preservar a campanha e seus documentos');
    assert.equal((await state()).currentLocation, villageWell, 'A — o turno deve terminar no poço');
    assert.deepEqual((await state()).worldTime, advanceWorldTime(morning, 11), 'A — o deslocamento deve levar seis minutos');
    const before = await snapshot();
    const well = await readScene();
    assert.equal(well.location, villageWell);
    assert.ok(well.revision > kitchen.revision);
    assert.deepEqual(well.people.map(({ name }) => name), ['Lira']);
    assert.ok(well.exits.some(({ id }) => id === familyYard));
    assert.deepEqual(well.landmarks, []);
    assert.ok(well.exits.some(({ id, label }) => id === freixoWoodland && label === 'bosque'));
    await assert.rejects(submit('Vou ao castelo.'), (error) =>
      error instanceof NarratorRequestError && error.gameplayFeedback &&
      error.code === 'PILOT_TRAVEL_UNAVAILABLE' && /não reconhece esse destino/.test(error.message));
    for (const [action, code] of [['Examino a bancada.', 'PILOT_OBJECT_OUT_OF_REACH'],
      ['Examino aquele objeto.', 'PILOT_OBJECT_OUT_OF_REACH'], ['Examino o jarro.', 'PILOT_OBJECT_UNREGISTERED']]) {
      await assert.rejects(submit(action), { code });
      assert.deepEqual(await snapshot(), before);
    }
    assert.equal((await ref.collection('events').get()).size, 6);
    assert.equal((await ref.collection('narrative').get()).size, 12);
    assert.equal((await ref.collection('turnReceipts').get()).size, 6);
    await assert.rejects(submit('Vou até um castelo.'), { code: 'PILOT_TRAVEL_UNAVAILABLE' });
    await assert.rejects(submit('Examino a bancada da oficina.'), { code: 'PILOT_OBJECT_OUT_OF_REACH' });
    await assert.rejects(submit('Bom dia, Henrique!'), { code: 'PILOT_SPEECH_UNAVAILABLE' });
    await assert.rejects(submit('Observo o que Henrique está fazendo.'), { code: 'PILOT_OBSERVATION_UNAVAILABLE' });
    assert.deepEqual(await snapshot(), before);
    await submit('Observo Lira.');
    await submit('Observo o que ela está fazendo.');
    const beforeContextualTravel = await snapshot();
    await assert.rejects(submit('Vou até o quintal e observo o que ela está fazendo.'), {
      code: 'PILOT_OBSERVATION_UNAVAILABLE',
      message: 'Etapa 2. Samuel não consegue observar Lira daqui. Essa pessoa não está presente neste local.',
      gameplayFeedback: true,
    });
    assert.deepEqual(await snapshot(), beforeContextualTravel);
    await submit('Vou ao quintal.');
    assert.equal((await state()).currentLocation, familyYard);
    assert.deepEqual((await state()).worldTime, advanceWorldTime(morning, 15));
    assert.match((await submit('Vou até a oficina de Henrique.')).result.narration, /Henrique está em atividade/);
    assert.equal((await state()).currentLocation, freixoWoodWorkshop);
    assert.deepEqual((await state()).worldTime, advanceWorldTime(morning, 19));
    assert.equal((await ref.collection('npcs').doc(henrique.id).get()).data()?.location, freixoWoodWorkshop);
    await submit('Observo a oficina.');
    const beforeDistantOrganization = await snapshot();
    await assert.rejects(submit('Organizo a bancada da cozinha.'), { code: 'PILOT_OBJECT_OUT_OF_REACH' });
    await assert.rejects(submit('Arrumo a bancada da oficina.'), { code: 'PILOT_ENVIRONMENT_UNAVAILABLE' });
    assert.deepEqual(await snapshot(), beforeDistantOrganization);
    assert.match((await submit('Observo o que Henrique está fazendo.')).result.narration, activity);
    const factual = await submit('Henrique, no que você está trabalhando?');
    assert.match(factual.result.narration, /Estou trabalhando a madeira na oficina/);
    const afterFactual = await snapshot();
    assert.equal((await factual.send()).narration, factual.result.narration);
    assert.deepEqual(await snapshot(), afterFactual);
    assert.match((await submit('Henrique, como está a bancada da cozinha?')).result.narration, /Não sei te dizer/);
    assert.match((await submit('Examino a bancada.')).result.narration, /bancada de trabalho na oficina/);
    await submit('Bom dia, Henrique!');
    const workshop = await snapshot();
    await assert.rejects(submit('Examino a bancada da cozinha.'), { code: 'PILOT_OBJECT_OUT_OF_REACH' });
    assert.deepEqual(await snapshot(), workshop);
    assert.deepEqual((await state()).worldTime, advanceWorldTime(morning, 19));
    await submit('Vou ao quintal.');
    assert.deepEqual((await state()).worldTime, advanceWorldTime(morning, 23));
    assert.equal((await henriqueRef.get()).data()?.location, freixoWoodWorkshop);
    assert.doesNotMatch((await submit('Vou até a oficina de Henrique.')).result.narration, /Henrique está em atividade/);
    assert.doesNotMatch((await submit('Observo o que Henrique está fazendo.')).result.narration, activity);
    assert.match((await submit('Henrique, você ainda está trabalhando?')).result.narration, /Já não estou/);
    assert.match((await submit('Henrique, o que você estava fazendo antes?')).result.narration, /Eu estava trabalhando a madeira na oficina/);
    const askObject = async () => {
      const { revision, activeTimelineId } = await state();
      const turn = { turnId: crypto.randomUUID(), expectedRevision: revision, baseTimelineId: activeTimelineId ?? 'tl_root' };
      const send = (declaredAction: string, clarificationToken?: string) =>
        requestNarratorTurn(owner.idToken, { campaignId: ref.id, declaredAction, advanceMinutes: 10, turn, clarificationToken });
      let token: string | undefined;
      await assert.rejects(send('Examino.'), (error) => {
        if (!(error instanceof NarratorRequestError)) return false;
        assert.equal(error.message, 'Qual objeto você deseja examinar?');
        assert.equal(error.code, 'PILOT_OBJECT_AMBIGUOUS');
        token = error.clarificationToken;
        return Boolean(token);
      });
      const respond = (answer: string, options?: { idToken?: string; timeline?: string }) =>
        requestNarratorTurn(options?.idToken ?? owner.idToken, { campaignId: ref.id, declaredAction: answer,
          advanceMinutes: 10, turn: { ...turn, baseTimelineId: options?.timeline ?? turn.baseTimelineId },
          clarificationToken: token });
      return Object.assign(respond, { turnId: turn.turnId });
    };
    const beforeQuestion = await snapshot();
    const abandoned = await askObject();
    await assert.rejects(abandoned('A bancada da cozinha.'), { code: 'PILOT_OBJECT_OUT_OF_REACH' });
    await assert.rejects(abandoned('O jarro.'), { code: 'PILOT_OBJECT_UNREGISTERED' });
    assert.deepEqual(await snapshot(), beforeQuestion);
    await submit('Observo a oficina.');
    const afterReplacement = await snapshot();
    await assert.rejects(abandoned('A bancada da oficina.'), { code: 'CONCURRENT_STATE_CONFLICT' });
    assert.deepEqual(await snapshot(), afterReplacement);
    const answer = await askObject();
    assert.deepEqual(await snapshot(), afterReplacement);
    const clarified = await answer('A bancada da oficina.');
    assert.match(clarified.narration, /bancada de trabalho na oficina/);
    const afterClarification = await snapshot();
    assert.equal((await answer('A bancada da oficina.')).narration, clarified.narration);
    assert.deepEqual(await snapshot(), afterClarification);
    const interrupted = await askObject();
    const unconfirmed = await askObject();
    const beforeLostRevision = (await state()).revision;
    loseConfirmation = true;
    await assert.rejects(interrupted('A bancada da oficina.'), /Confirmação perdida pelo cliente/);
    assert.match(lostNarration ?? '', /bancada de trabalho na oficina/);
    const afterLostConfirmation = await snapshot();
    assert.equal((await state()).revision, beforeLostRevision + 1);
    const exited = once(server, 'exit');
    server.kill();
    await exited;
    const restarted = await startServer();
    assert.notEqual(restarted.pid, server.pid);
    const attempts = await Promise.allSettled([interrupted('A bancada da oficina.'), interrupted('A bancada da oficina.')]);
    assert.ok(attempts.some((result) => result.status === 'fulfilled'));
    for (const attempt of attempts) {
      if (attempt.status === 'fulfilled') assert.equal(attempt.value.narration, lostNarration);
      else assert.equal(attempt.reason.code, 'ACTION_IN_PROGRESS');
    }
    assert.equal((await interrupted('A bancada da oficina')).narration, lostNarration);
    await assert.rejects(interrupted('A bancada da cozinha.'), { code: 'TURN_ID_CONFLICT' });
    await assert.rejects(interrupted('A bancada da oficina.', { idToken: outsider.idToken }), { code: 'CAMPAIGN_ACCESS_DENIED' });
    await assert.rejects(interrupted('A bancada da oficina.', { timeline: 'outra' }), { code: 'CONCURRENT_STATE_CONFLICT' });
    await assert.rejects(unconfirmed('A bancada da oficina.'), { code: 'PILOT_CLARIFICATION_EXPIRED' });
    assert.deepEqual(await snapshot(), afterLostConfirmation);
    const interruptedReceipt = ref.collection('turnReceipts').doc(interrupted.turnId);
    const binding = (await interruptedReceipt.get()).data()?.clarificationBinding;
    assert.match(binding, /^[a-f0-9]{64}$/);
    await interruptedReceipt.update({ clarificationBinding: FieldValue.delete() });
    await assert.rejects(interrupted('A bancada da oficina.'), { code: 'PILOT_CLARIFICATION_EXPIRED' });
    await interruptedReceipt.update({ clarificationBinding: binding });
    assert.deepEqual(await snapshot(), afterLostConfirmation);
    const beforeDirectTravel = await state();
    const directTravel = await submit('Vou da oficina para a cozinha.');
    assert.equal((await state()).currentLocation, familyKitchen);
    assert.deepEqual((await state()).worldTime, advanceWorldTime(beforeDirectTravel.worldTime, 6));
    const afterDirectTravel = await snapshot();
    assert.equal((await directTravel.send()).narration, directTravel.result.narration);
    assert.deepEqual(await snapshot(), afterDirectTravel);
    const block = 'demo-bloco-madeira';
    const item = ref.collection('inventory').doc(block);
    const ground = ref.collection('pilotObjectLocations').doc(block);
    const beforePickup = await snapshot();
    await assert.rejects(submit('Pego o bloco.', outsider.idToken), { code: 'CAMPAIGN_ACCESS_DENIED' });
    assert.deepEqual(await snapshot(), beforePickup);
    const taken = await submit('Pego o bloco.');
    assert.match(taken.result.narration, /recolheu.*bloco/);
    assert.equal((await item.get()).data()?.quantity, 1);
    assert.equal((await ground.get()).exists, false);
    const afterPickup = await snapshot();
    assert.equal((await taken.send()).narration, taken.result.narration);
    await assert.rejects(submit('Pego o bloco.'), { code: 'PILOT_OBJECT_ALREADY_HELD' });
    assert.deepEqual(await snapshot(), afterPickup);
    const storeBlock = 'Tento guardar o bloco de madeira dentro do armário.';
    await assert.rejects(submit(storeBlock), { code: 'PILOT_STORAGE_CLOSED', message: /armário está fechado/ });
    assert.deepEqual(await snapshot(), afterPickup);
    const openedCabinet = await submit('Escancaro o armário.');
    assert.equal(openedCabinet.result.narration, 'O armário está aberto.');
    const afterOpening = await snapshot();
    assert.equal((await openedCabinet.send()).narration, openedCabinet.result.narration);
    await assert.rejects(submit('Escancaro o armário novamente.'), {
      code: 'PILOT_OPEN_CLOSE_ALREADY_SET',
    });
    assert.deepEqual(await snapshot(), afterOpening);
    const baseStorage = await state();
    const storeAtRevision = (turnId: string) => requestNarratorTurn(owner.idToken, {
      campaignId: ref.id, declaredAction: storeBlock, advanceMinutes: 10,
      turn: { turnId, expectedRevision: baseStorage.revision, baseTimelineId: baseStorage.activeTimelineId ?? 'tl_root' },
    });
    const requests = [crypto.randomUUID(), crypto.randomUUID()];
    const race = await Promise.allSettled(requests.map(storeAtRevision));
    assert.equal(race.filter((entry) => entry.status === 'fulfilled').length, 1);
    const winner = requests[race.findIndex((entry) => entry.status === 'fulfilled')];
    for (const entry of race) {
      if (entry.status === 'fulfilled') assert.match(entry.value.narration, /guardou.*bloco de madeira.*armário/);
      else assert.ok(['CONCURRENT_STATE_CONFLICT', 'ACTION_IN_PROGRESS'].includes(entry.reason.code));
    }
    assert.equal((await item.get()).exists, false);
    assert.deepEqual((await ground.get()).data(), { ownerId: seed.ownerId, campaignId: ref.id,
      timelineId: baseStorage.activeTimelineId ?? 'tl_root', containerId: 'demo-armario-cozinha' });
    const afterStorage = await snapshot();
    assert.match((await storeAtRevision(winner)).narration, /guardou/);
    await assert.rejects(storeAtRevision(crypto.randomUUID()), { code: 'CONCURRENT_STATE_CONFLICT' });
    await assert.rejects(submit('Coloco o bloco no armário.'), { code: 'PILOT_OBJECT_NOT_HELD' });
    assert.deepEqual(await snapshot(), afterStorage);
    await submit('Fecho o armário.');
    await assert.rejects(submit('Tiro o bloco do armário.'), { code: 'PILOT_STORAGE_CLOSED' });
    await submit('Abro o armário.');
    const retrieved = await submit('Retiro o bloco do armário da cozinha.');
    assert.match(retrieved.result.narration, /retirou.*bloco de madeira.*armário/);
    assert.equal((await ground.get()).exists, false);
    assert.equal((await item.get()).data()?.quantity, 1);
    await submit('Fecho o armário.');
    await submit('Vou ao quintal.');
    assert.equal((await item.get()).exists, true);
    await submit('Deixo o bloco.');
    assert.equal((await item.get()).exists, false);
    assert.equal((await ground.get()).data()?.location, familyYard);
    const reopened = initializeApp({ projectId }, 'object-http-reopen');
    try {
      const reopenedRef = getFirestore(reopened, database).collection('campaigns').doc(ref.id);
      assert.deepEqual((await reopenedRef.get()).data(), await state());
      assert.equal((await reopenedRef.collection('inventory').doc(block).get()).exists, false);
      assert.equal((await reopenedRef.collection('pilotObjectLocations').doc(block).get()).data()?.location, familyYard);
      assert.deepEqual((await reopenedRef.collection('npcs').doc(henrique.id).get()).data(), (await henriqueRef.get()).data());
      assert.deepEqual((await reopenedRef.collection('npcRoutineState').doc(routineRef.id).get()).data(), (await routineRef.get()).data());
      assert.ok((await reopenedRef.collection('npcRoutineState').doc(routineRef.id).get()).data()
        ?.completedActivities.includes('demo-organizar-cozinha'));
      await submit('Recolho o bloco.');
      assert.equal((await reopenedRef.collection('inventory').doc(block).get()).data()?.quantity, 1);
      assert.equal((await reopenedRef.collection('pilotObjectLocations').doc(block).get()).exists, false);
      await assert.rejects(submit('Entrego o bloco para Henrique.'), { code: 'PILOT_DELIVERY_RECIPIENT' });
      await submit('Vou até a oficina.');
      const beforeDelivery = await snapshot();
      await assert.rejects(submit('Entrego o bloco para Henrique.', outsider.idToken), { code: 'CAMPAIGN_ACCESS_DENIED' });
      await assert.rejects(submit('Ofereço o bloco para Henrique.'), { code: 'PILOT_DELIVERY_OFFER' });
      assert.deepEqual(await snapshot(), beforeDelivery);
      const delivered = await submit('Dou o bloco de madeira ao Henrique.');
      assert.match(delivered.result.narration, /entregou.*bloco.*Henrique/);
      const afterDelivery = await snapshot();
      assert.equal((await delivered.send()).narration, delivered.result.narration);
      await assert.rejects(submit('Dou o bloco ao Henrique.'), { code: 'PILOT_OBJECT_NOT_HELD' });
      assert.deepEqual(await snapshot(), afterDelivery);
      const memory = await submit('Henrique, lembra do bloco que te entreguei?');
      assert.match(memory.result.narration, /Você me entregou o bloco de madeira/);
      const afterMemory = await snapshot();
      assert.equal((await memory.send()).narration, memory.result.narration);
      assert.deepEqual(await snapshot(), afterMemory);
      await submit('Vou ao quintal.');
      assert.equal((await reopenedRef.collection('inventory').doc(block).get()).exists, false);
      const ownership = (await reopenedRef.collection('pilotObjectLocations').doc(block).get()).data();
      assert.equal(ownership?.npcId, henrique.id);
      assert.equal(ownership?.location, undefined);
      const beforeWait = await state();
      const wait = await submit('Fico aqui esperando meia hora.');
      assert.match(wait.result.narration, /^Samuel aguardou 30 minutos\./);
      const waited = await snapshot();
      assert.equal((await wait.send()).narration, wait.result.narration);
      assert.deepEqual(await snapshot(), waited);
      const afterWait = (await reopenedRef.get()).data();
      assert.deepEqual(afterWait?.worldTime, advanceWorldTime(beforeWait.worldTime, 30));
      assert.equal(afterWait?.currentLocation, beforeWait.currentLocation);
      if (afterWait && afterWait.worldTime.hour * 60 + afterWait.worldTime.minute < 11 * 60 + 34) {
        await submit('Aguardo até as 11h40.');
      }
      assert.equal((await reopenedRef.collection('npcs').doc(henrique.id).get()).data()?.location, familyYard);
      assert.match((await submit('Henrique, no que você está trabalhando?')).result.narration,
        /Agora não estou trabalhando\. Estou fazendo uma pausa no quintal\./);
      assert.deepEqual((await reopenedRef.collection('pilotObjectLocations').doc(block).get()).data(), ownership);
      assert.equal((await reopenedRef.collection('inventory').doc(block).get()).exists, false);
      const beforeRefusals = await snapshot();
      await assert.rejects(submit('Escancaro o armário da cozinha.'), { code: 'PILOT_OBJECT_OUT_OF_REACH' });
      await assert.rejects(submit('Deixo o bloco.'), { code: 'PILOT_OBJECT_NOT_HELD' });
      await assert.rejects(submit('Deixo duas horas passarem.'), { code: 'PILOT_WAIT_UNAVAILABLE' });
      assert.deepEqual(await snapshot(), beforeRefusals);
      for (const [command, minutes] of [
        ['Aguardo cinco minutos.', 5], ['Deixo dois minutos passarem.', 2],
      ] as const) {
        const before = await state();
        const waited = await submit(command);
        assert.deepEqual((await state()).worldTime, advanceWorldTime(before.worldTime, minutes));
        assert.equal((await state()).currentLocation, before.currentLocation);
        assert.deepEqual((await ground.get()).data(), ownership);
        assert.equal((await item.get()).exists, false);
        const after = await snapshot();
        assert.equal((await waited.send()).narration, waited.result.narration);
        assert.deepEqual(await snapshot(), after);
      }
      await submit('Vou à cozinha.');
      assert.match((await submit('Examino o armário.')).result.narration, /O armário está fechado/);
      const open = await submit('Abro aquele objeto.');
      assert.equal(open.result.narration, 'O armário está aberto.');
      assert.deepEqual((await reopenedRef.collection('npcRoutineState').doc(routineRef.id).get()).data()?.openObjects,
        ['demo-armario-cozinha']);
      assert.match((await submit('Examino o armário.')).result.narration, /O armário está aberto/);
      await submit('Fecho o armário.');
      const closed = await snapshot();
      assert.equal((await open.send()).narration, 'O armário está aberto.');
      assert.deepEqual(await snapshot(), closed);
      assert.deepEqual((await reopenedRef.collection('npcRoutineState').doc(routineRef.id).get()).data()?.openObjects, []);
      await submit('Vou ao poço.');
      const beforeWoodland = await state();
      const journey = await submit('Vou ao Bosque de Freixo.');
      assert.match(journey.result.narration, /folhas secas/);
      const woodland = await readScene();
      assert.equal(woodland.location, freixoWoodland);
      assert.equal(woodland.revision, beforeWoodland.revision + 1);
      assert.equal(woodland.timelineId, well.timelineId);
      assert.deepEqual(woodland.people, []);
      assert.deepEqual(woodland.exits.map(({ id }) => id), [villageWell]);
      assert.deepEqual(woodland.landmarks.map(({ name }) => name), ['marco de pedra']);
      assert.deepEqual((await state()).worldTime, advanceWorldTime(beforeWoodland.worldTime, 5));
      const afterArrival = await snapshot();
      assert.equal((await journey.send()).narration, journey.result.narration);
      assert.deepEqual(await snapshot(), afterArrival);
      assert.match((await submit('Examino a pedra da trilha.')).result.narration, /marco de pedra coberto de musgo/);
      assert.deepEqual((await state()).worldTime, advanceWorldTime(beforeWoodland.worldTime, 5));
      await submit('Vou ao poço.');
      assert.equal((await readScene()).location, villageWell);
      assert.deepEqual((await state()).worldTime, advanceWorldTime(beforeWoodland.worldTime, 10));
    } finally {
      await deleteApp(reopened);
    }
  } finally {
    await deleteApp(admin);
  }
});
