import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { SERVER_PILOT_ID } from '../server/persistPilotTurn';
import type { Campaign } from '../src/types/game';
import { villageWell } from '../src/engine/echoArcEncounters';
import { freixoWoodWorkshop } from '../src/engine/npcIdentity';
import { familyYard } from '../scripts/echoArcFreeTurn';
import { familyKitchen } from '../scripts/echoArcContinuityFixture';
import { advanceWorldTime } from '../src/engine/rulesEngine';
import { requestNarratorTurn } from '../src/services/narratorClient';

test('exame e atividade da bancada pela API local com Auth e Firestore emulados', async (t) => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080');
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9099');
  const projectId = 'demo-rpg-ai-engine';
  const database = 'ai-studio-31936b9f-7516-468c-9cf4-6dd4da7fb704';
  const base = 'http://127.0.0.1:3219';
  const http = globalThis.fetch;
  const admin = initializeApp({ projectId }, 'object-http-test');
  const db = getFirestore(admin, database);
  const ref = db.collection('campaigns').doc(SERVER_PILOT_ID);
  const auth = getAuth(admin);
  const authRequest = async (operation: 'signUp' | 'signInWithPassword', credentials = {}) => {
    const response = await http('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:' + operation + '?key=demo', {
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
    const server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { windowsHide: true, stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'development', VITE_FREIXO_LOCAL: 'true', TURN_PLAN_SERVER_COMMIT: 'true',
        NARRATOR_MODE: 'fixed', FIREBASE_PROJECT_ID: projectId, FIRESTORE_DATABASE_ID: database, PORT: '3219' } });
    t.after(() => { server.kill(); });
    let ready = false;
    for (let attempt = 0; attempt < 120 && server.exitCode === null; attempt++) {
      const health = await http(base + '/api/health').catch(() => null);
      if (health?.ok && (await health.json()).narratorMode === 'fixed') { ready = true; break; }
      await delay(500);
    }
    assert.ok(ready, 'Servidor HTTP do piloto não iniciou.');
    t.mock.method(globalThis, 'fetch', (url: string, options: RequestInit) => http(base + url, options));
    const state = async () => (await ref.get()).data()!;
    const submit = async (declaredAction: string, idToken = owner.idToken) => {
      const { revision, activeTimelineId } = await state();
      const send = () => requestNarratorTurn(idToken, { campaignId: ref.id, declaredAction, advanceMinutes: 10,
        turn: { turnId, expectedRevision: revision, baseTimelineId: activeTimelineId ?? 'tl_root' } });
      const turnId = crypto.randomUUID();
      return { result: await send(), send };
    };
    const snapshot = async () => Promise.all([state(), ...['npcs', 'npcRoutineState', 'narrative', 'events', 'turnReceipts']
      .map(async (collection) => (await ref.collection(collection).get()).docs.map((doc) => [doc.id, doc.data()]))]);
    const initial = await snapshot();
    await assert.rejects(submit('Examino a bancada.', anonymous.idToken), { code: 'AUTH_REQUIRED' });
    await assert.rejects(submit('Examino a bancada.', unverified.idToken), { code: 'AUTH_REQUIRED' });
    await assert.rejects(submit('Examino a bancada.', outsider.idToken), { code: 'CAMPAIGN_ACCESS_DENIED' });
    assert.deepEqual(await snapshot(), initial);
    assert.match((await submit('Examino a bancada.')).result.narration, /ainda está por organizar/);
    assert.deepEqual((await state()).worldTime, morning);
    const henriqueRef = npcCollection.doc(henrique.id);
    assert.equal((await henriqueRef.get()).data()?.location, familyYard);
    const helped = await submit('Ajudo Teresa a organizar a cozinha.');
    const routineRef = ref.collection('npcRoutineState').doc(seed.activeTimelineId ?? 'tl_root');
    const activity = /trabalhar a madeira na oficina/i;
    assert.equal((await state()).currentLocation, familyKitchen);
    assert.deepEqual((await state()).worldTime, advanceWorldTime(morning, 5));
    assert.equal((await henriqueRef.get()).data()?.location, freixoWoodWorkshop);
    assert.match((await routineRef.get()).data()?.activities
      .find(({ npcId }: { npcId: string }) => npcId === henrique.id)?.activity ?? '', activity);
    const afterMove = await snapshot();
    assert.equal((await helped.send()).narration, helped.result.narration);
    assert.deepEqual(await snapshot(), afterMove);
    const examined = await submit('Quero olhar mais de perto a bancada.');
    assert.match(examined.result.narration, /ficou organizada/);
    const confirmed = await snapshot();
    assert.equal((await examined.send()).mode, 'replay');
    assert.deepEqual(await snapshot(), confirmed);
    await submit('Bom dia, mãe!');
    await submit('Observo a cozinha.');
    assert.equal((await state()).currentLocation, familyKitchen);
    assert.deepEqual((await state()).worldTime, advanceWorldTime(morning, 5));
    const beforeInvalidSequence = await snapshot();
    await assert.rejects(submit('Vou até o poço e examino a bancada da cozinha.'),
      { code: 'PILOT_OBJECT_OUT_OF_REACH', message: /^Etapa 2/ });
    assert.deepEqual(await snapshot(), beforeInvalidSequence);
    const journey = await submit('Vou até o poço e observo o poço.');
    const afterJourney = await snapshot();
    assert.equal((await journey.send()).narration, journey.result.narration);
    assert.deepEqual(await snapshot(), afterJourney);
    assert.equal((await state()).currentLocation, villageWell);
    assert.deepEqual((await state()).worldTime, advanceWorldTime(morning, 11));
    const before = await snapshot();
    for (const [action, code] of [['Examino a bancada.', 'PILOT_OBJECT_OUT_OF_REACH'],
      ['Examino aquele objeto.', 'PILOT_OBJECT_AMBIGUOUS'], ['Examino o jarro.', 'PILOT_OBJECT_UNREGISTERED']]) {
      await assert.rejects(submit(action), { code });
      assert.deepEqual(await snapshot(), before);
    }
    assert.equal((await ref.collection('events').get()).size, 6);
    assert.equal((await ref.collection('narrative').get()).size, 12);
    assert.equal((await ref.collection('turnReceipts').get()).size, 6);
    await assert.rejects(submit('Vou à oficina.'), { code: 'PILOT_TRAVEL_UNAVAILABLE' });
    await assert.rejects(submit('Examino a bancada da oficina.'), { code: 'PILOT_OBJECT_OUT_OF_REACH' });
    await assert.rejects(submit('Bom dia, Henrique!'), { code: 'PILOT_SPEECH_UNAVAILABLE' });
    await assert.rejects(submit('Observo o que Henrique está fazendo.'), { code: 'PILOT_OBSERVATION_UNAVAILABLE' });
    assert.deepEqual(await snapshot(), before);
    await submit('Vou ao quintal.');
    assert.equal((await state()).currentLocation, familyYard);
    assert.deepEqual((await state()).worldTime, advanceWorldTime(morning, 15));
    assert.match((await submit('Vou até a oficina de Henrique.')).result.narration, /Henrique está em atividade/);
    assert.equal((await state()).currentLocation, freixoWoodWorkshop);
    assert.deepEqual((await state()).worldTime, advanceWorldTime(morning, 19));
    assert.equal((await ref.collection('npcs').doc(henrique.id).get()).data()?.location, freixoWoodWorkshop);
    await submit('Observo a oficina.');
    assert.match((await submit('Observo o que Henrique está fazendo.')).result.narration, activity);
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
    const reopened = initializeApp({ projectId }, 'object-http-reopen');
    try {
      const reopenedRef = getFirestore(reopened, database).collection('campaigns').doc(ref.id);
      assert.deepEqual((await reopenedRef.get()).data(), await state());
      assert.deepEqual((await reopenedRef.collection('npcs').doc(henrique.id).get()).data(), (await henriqueRef.get()).data());
      assert.deepEqual((await reopenedRef.collection('npcRoutineState').doc(routineRef.id).get()).data(), (await routineRef.get()).data());
    } finally {
      await deleteApp(reopened);
    }
  } finally {
    await deleteApp(admin);
  }
});
