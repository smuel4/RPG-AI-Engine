import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { requestNarratorTurn } from '../src/services/narratorClient';
import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyFirebasePlayer } from '../server/firebaseAuth';
import { groqNarrator } from '../server/groqNarrator';
import { buildNarratorContext } from '../server/narratorMemory';
import { buildNarratorPrompt, narratorInstructions } from '../server/narratorProvider';
import { persistPilotTurn, SERVER_PILOT_ID } from '../server/persistPilotTurn';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { createWellEncounterNpc } from '../src/engine/echoArcEncounters';
import { turnDocumentIds } from '../src/engine/turnIdentity';
import { getActiveTimelineId } from '../src/engine/rulesEngine';
import type { Campaign } from '../src/types/game';
import { familyKitchen } from './echoArcContinuityFixture';
import { freixoPlayableCatalog } from './echoArcFreeTurn';

const PROJECT = 'demo-rpg-ai-engine';
const DATABASE = 'ai-studio-31936b9f-7516-468c-9cf4-6dd4da7fb704';
const dialogueAcceptance = [
  'Bom dia, mãe!',
  'Vou até o poço',
  'Dou bom dia para ela',
  'Pergunto se ela está bem.',
  'Queria saber como foi o dia dela.',
] as const;
const liveActions = [
  'Vou até o poço',
  'Conto a Lira: Estou procurando um lugar tranquilo para ler.',
  'Digo a Lira: E aqui, perto do poço, costuma ficar mais tranquilo em algum horário?',
] as const;
const simulated = ['Teresa retribui o cumprimento.', 'Lira ajusta o balde na borda de pedra do poço.',
  'Lira retribui o cumprimento.', 'Lira responde que está bem.', 'Lira diz que a manhã foi tranquila.'];

async function run() {
  const args = process.argv.slice(2);
  const live = args.length === 1 && args[0] === '--autorizar-groq';
  const actions = live ? liveActions : dialogueAcceptance;
  const prepareSite = args.length === 1 && args[0] === '--preparar-site';
  const interactions = args.length === 1 && args[0] === '--interacoes-http';
  if (args.length && !live && !prepareSite && !interactions) throw new Error('Opção desconhecida.');
  const database = interactions ? 'freixo-interacoes-' + randomUUID() : DATABASE;
  if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080' ||
      process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9099' ||
      process.env.FIREBASE_PROJECT_ID !== PROJECT) throw new Error('Exige os dois emuladores em loopback e o projeto demo.');
  if (live && !process.env.GROQ_API_KEY?.trim()) throw new Error('GROQ_API_KEY precisa estar disponível no ambiente do processo.');

  const logPath = join(await mkdtemp(join(tmpdir(), 'echo-arc-mundo-vivo-')), 'sessao.jsonl');
  console.info('Registro:', logPath);
  const log = (record: object) => appendFile(logPath, JSON.stringify(record) + '\n', 'utf8');
  let generations = 0;
  let turnId: string | undefined;
  let stage = 'setup';
  const app = initializeApp({ projectId: PROJECT }, 'echo-arc-narrative-review');
  try {
    const db = getFirestore(app, database);
    const campaignRef = db.collection('campaigns').doc(SERVER_PILOT_ID);
    const existing = (await campaignRef.get()).data() as Campaign | undefined;
    const pilotNpcs = (bundle: ReturnType<typeof createEchoArcBundle>, lira: ReturnType<typeof createWellEncounterNpc>) => [
      ...bundle.npcs.map((npc) => ({
        ...npc, campaignId: SERVER_PILOT_ID, location: npc.name === 'Teresa' ? familyKitchen : npc.location,
      })),
      lira,
    ];
    const npcCollection = campaignRef.collection('npcs');
    if (existing) {
      if (!prepareSite) throw new Error('O piloto já existe no emulador. Use uma sessão nova sem importação.');
      if (existing.id !== SERVER_PILOT_ID || existing.name !== 'ECHO ARC' || !existing.ownerId) {
        throw new Error('A campanha existente não é um piloto local válido.');
      }
      const owner = await getAuth(app).getUser(existing.ownerId);
      if (!owner.emailVerified || owner.disabled) throw new Error('O proprietário do piloto local não está disponível.');
      const seeds = pilotNpcs(createEchoArcBundle(owner.uid), createWellEncounterNpc(owner.uid, SERVER_PILOT_ID));
      const added = await db.runTransaction(async (tx) => {
        const current = (await tx.get(campaignRef)).data() as Campaign | undefined;
        if (!current || current.id !== existing.id || current.ownerId !== owner.uid || current.name !== existing.name) {
          throw new Error('O piloto mudou durante a preparação. Execute o comando novamente.');
        }
        const records = await tx.get(npcCollection);
        const known = new Set(records.docs.filter((doc) => {
          const npc = doc.data();
          return doc.id === npc.id && npc.ownerId === owner.uid && npc.campaignId === current.id;
        }).map((doc) => doc.data().name));
        const missing = seeds.filter(({ name }) => !known.has(name));
        for (const npc of missing) tx.create(npcCollection.doc(npc.id), npc);
        return missing.map(({ name }) => name);
      });
      console.info(added.length ? 'NPCs cadastrados: ' + added.join(', ') : 'NPCs do piloto já cadastrados.');
      console.info('Use a mesma conta local da preparação anterior.');
      return;
    }
    const email = `samuel-${randomUUID()}@example.test`;
    const password = randomUUID();
    const user = await getAuth(app).createUser({ email, password, emailVerified: true });
    const response = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo', {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    if (!response.ok) throw new Error('Falha no login do Auth Emulator.');
    const { idToken } = await response.json() as { idToken?: string };
    const ownerId = idToken && await verifyFirebasePlayer('Bearer ' + idToken, true);
    if (!ownerId || ownerId !== user.uid) throw new Error('Identidade local não confirmada.');

    const bundle = createEchoArcBundle(ownerId);
    const campaign = { ...bundle.campaign, id: SERVER_PILOT_ID, currentLocation: familyKitchen };
    const lira = createWellEncounterNpc(ownerId, SERVER_PILOT_ID);
    const npcs = pilotNpcs(bundle, lira);
    const catalog = freixoPlayableCatalog;
    const batch = db.batch();
    batch.create(campaignRef, campaign);
    for (const npc of npcs) batch.create(npcCollection.doc(npc.id), npc);
    await batch.commit();
    if (interactions) {
      const base = 'http://127.0.0.1:3199';
      const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
        env: { ...process.env, VITE_FREIXO_LOCAL: 'true', TURN_PLAN_SERVER_COMMIT: 'true',
          FIRESTORE_DATABASE_ID: database, NARRATOR_MODE: 'fixed', PORT: '3199', DISABLE_HMR: 'true' },
        stdio: 'inherit',
      });
      const network = globalThis.fetch;
      try {
        const startupDeadline = Date.now() + 60_000;
        for (;;) {
          const health = await network(base + '/api/health', { signal: AbortSignal.timeout(1000) }).catch(() => null);
          if (health?.ok) {
            assert.equal((await health.json()).narratorMode, 'fixed');
            break;
          }
          if (child.exitCode !== null || Date.now() >= startupDeadline) {
            throw new Error('Servidor local de teste indisponível.');
          }
          await delay(250);
        }
        globalThis.fetch = (url, options) => network(url === '/api/narrator/turn' ? base + url : url, options);
        const read = async () => (await campaignRef.get()).data() as Campaign;
        for (const [action, minute, location] of [
          ['Observo a cozinha.', 30, familyKitchen],
          ['Ajudo Teresa a organizar a cozinha.', 35, familyKitchen],
          ['Vou até o poço', 41, lira.location],
          ['Examino o poço.', 41, lira.location],
          ['Digo a Lira: Bom dia.', 41, lira.location],
        ] as const) {
          const before = await read();
          const request = { campaignId: SERVER_PILOT_ID, declaredAction: action, advanceMinutes: 10,
            turn: { turnId: randomUUID(), expectedRevision: before.revision, baseTimelineId: getActiveTimelineId(before) } };
          const reply = await requestNarratorTurn(idToken!, request);
          const replay = await requestNarratorTurn(idToken!, request);
          assert.equal(replay.narration, reply.narration);
          const after = await read();
          assert.equal(after.revision, before.revision + 1);
          assert.equal(after.currentLocation, location);
          assert.equal(after.worldTime.minute, minute);
          assert.equal((await campaignRef.collection('narrative').where('content', '==', action).get()).size, 1);
          if (minute === 35) {
            assert.match(reply.narration, /bancada da cozinha ficou organizada/);
            const receipt = (await campaignRef.collection('turnReceipts').doc(request.turn.turnId).get()).data();
            assert.equal(receipt?.resolution.completed, true);
            assert.equal(receipt?.outcome.elapsedMinutes, 5);
            const state = (await campaignRef.collection('npcRoutineState').doc(request.turn.baseTimelineId).get()).data();
            assert.deepEqual(state?.completedActivities, ['demo-organizar-cozinha']);
            assert.equal(state?.relationships?.length ?? 0, 0);
          }
        }
        const after = await read();
        await assert.rejects(requestNarratorTurn(idToken!, { campaignId: SERVER_PILOT_ID,
          declaredAction: 'Examino a cozinha.', turn: { turnId: randomUUID(), expectedRevision: after.revision,
            baseTimelineId: getActiveTimelineId(after) } }), { code: 'PILOT_OBSERVATION_UNAVAILABLE' });
        assert.equal((await read()).revision, after.revision);
        assert.equal((await campaignRef.collection('inventory').get()).size, 0);
        console.info('API HTTP: cinco ações confirmadas, reenvios idempotentes e exame remoto recusado.');
      } finally {
        globalThis.fetch = network;
        child.kill();
      }
      return;
    }
    if (prepareSite) {
      console.info('Conta exclusiva do Auth Emulator:', email, password);
      return;
    }
    await log({ type: 'session', mode: live ? 'groq' : 'simulado', project: PROJECT, database: DATABASE,
      catalog, initialCampaign: campaign, npcs });

    for (const declaredAction of actions) {
      const before = (await campaignRef.get()).data() as Campaign;
      const turn = { campaignId: SERVER_PILOT_ID, turnId: randomUUID(), declaredAction, advanceMinutes: 0,
        expectedRevision: before.revision, baseTimelineId: getActiveTimelineId(before) };
      turnId = turn.turnId;
      stage = 'resolve';
      await log({ type: 'input', turn, before });
      const result = await persistPilotTurn(db, catalog, ownerId, turn, async (arrival, sceneIntent, present, npcRelationships, narrative) => {
        if (generations >= actions.length) throw new Error('Limite de gerações atingido.');
        const input = { declaredAction, sceneIntent, context: buildNarratorContext({
          campaign: arrival, npcs: present.npcs, narrative, inventory: [], sceneKnowledge: present.knowledge,
          npcActivities: present.activities, npcMemories: present.memories, npcRelationships,
        }) };
        await log({ type: 'narrator_input', turnId: turn.turnId, system: narratorInstructions,
          prompt: buildNarratorPrompt(input), context: input.context });
        const index = generations++;
        stage = 'generate';
        const text = live ? await groqNarrator.generate(input) : simulated[index];
        stage = 'validate_and_commit';
        await log({ type: 'narrator_output', turnId: turn.turnId, text });
        return text;
      });
      stage = 'read_committed';
      const ids = await turnDocumentIds(turn);
      const confirmed = await db.getAll(campaignRef, campaignRef.collection('turnReceipts').doc(turn.turnId),
        campaignRef.collection('events').doc(ids.event),
        campaignRef.collection('npcRoutineState').doc(turn.baseTimelineId),
        campaignRef.collection('narrative').doc(ids.player), campaignRef.collection('narrative').doc(ids.engine));
      const [after, receipt, event, npcState, playerEntry, narrationEntry] = confirmed.map((doc) => doc.data());
      await log({ type: 'confirmed', turnId: turn.turnId, result, after, receipt, event, npcState, playerEntry, narrationEntry });
      if (!live) {
        assert.equal(after?.revision, before.revision + 1);
        assert.equal(playerEntry?.content, declaredAction);
        assert.ok(narrationEntry?.content);
        if (declaredAction === dialogueAcceptance[0]) {
          assert.equal(playerEntry?.privateRecipientId, npcs.find(({ name }) => name === 'Teresa')!.id);
          assert.deepEqual(after?.worldTime, before.worldTime);
        } else {
          assert.equal(after?.currentLocation, lira.location);
          assert.equal(after?.worldTime.hour, 8);
          assert.equal(after?.worldTime.minute, 36);
          if (declaredAction !== dialogueAcceptance[1]) {
            assert.equal(playerEntry?.privateRecipientId, lira.id);
            assert.deepEqual(after?.worldTime, before.worldTime);
            assert.equal(npcState?.relationships?.[0]?.familiarity, 1);
          }
        }
      }
    }
  } catch (error) {
    await log({ type: 'failure', turnId, stage, generations,
      code: error instanceof Error && 'code' in error ? error.code : 'SESSION_FAILED' });
    throw error;
  } finally {
    await Promise.all(getApps().map(deleteApp));
  }
  console.info('Sessão concluída. Gerações:', generations);
}

await run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Falha na sessão.');
  process.exitCode = 1;
});
