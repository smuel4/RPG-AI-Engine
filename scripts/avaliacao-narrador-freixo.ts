import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { buildNarratorContext } from '../server/narratorMemory';
import { generateCampaignNarration } from '../server/narratorService';
import { buildNarratorPrompt, describeNarratorFailure } from '../server/narratorProvider';
import { claimsUnconfirmedPlayerConsequence } from '../server/pilotNarrativeIntegrity';
import { persistPilotTurn, SERVER_PILOT_ID } from '../server/persistPilotTurn';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { createWellEncounterNpc } from '../src/engine/echoArcEncounters';
import { freixoWoodWorkshop } from '../src/engine/npcIdentity';
import { advanceWorldTime } from '../src/engine/rulesEngine';
import { turnDocumentIds } from '../src/engine/turnIdentity';
import { familyKitchen } from './echoArcContinuityFixture';
import { familyYard, freixoPlayableCatalog } from './echoArcFreeTurn';
import { continuitySecret } from './freixoContinuitySession';
import { memoryFirestore } from './freixoEvaluationStore';
import { reviewEchoArcNarration } from './narrativeReview';

const model = 'openai/gpt-oss-120b';
const maxCalls = 6;
const cabinet = 'demo-armario-cozinha';
const custody = 'A conversa faz uma pausa.';
const steps = [
  ['Digo a Teresa: Bom dia, mãe.', 'Teresa', familyKitchen, 0, true],
  ['Confidencio a Teresa: ' + continuitySecret, 'Teresa', familyKitchen, 0, true],
  ['Escancaro o armário.', null, familyKitchen, 0, false],
  ['Aguardo até as 11h34.', null, familyKitchen, 10, false],
  ['Vou ao quintal.', null, familyYard, 2, true],
  ['Digo a Henrique: Você sabe o que contei à Teresa em particular?', 'Henrique', familyYard, 0, true],
  ['Vou à cozinha.', null, familyKitchen, 2, true],
  ['Digo a Teresa: Você se lembra do que eu te contei sobre a ponte?', 'Teresa', familyKitchen, 0, true],
] as const;

async function run(live: boolean) {
  if (live) {
    dotenv.config({ quiet: true });
    assert.ok(process.env.GROQ_API_KEY?.trim(), 'Groq sem chave configurada.');
    assert.ok((process.env.GROQ_MODEL?.trim() || model) === model, 'Modelo Groq diferente do aprovado.');
    process.env.GROQ_MAX_OUTPUT_TOKENS = '1000';
  }
  const cache = resolve('node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const report = join(await mkdtemp(join(cache, 'echo-arc-narrador-v2-')), 'turnos.jsonl');
  const log = (entry: object) => appendFile(report, JSON.stringify(entry) + '\n');
  console.info('Relatório:', report);

  const ownerId = 'freixo-avaliacao-sintetica';
  const bundle = createEchoArcBundle(ownerId);
  const campaign = { ...bundle.campaign, id: SERVER_PILOT_ID, currentLocation: familyKitchen,
    worldTime: { ...bundle.campaign.worldTime, hour: 11, minute: 24 } };
  const [teresa, henrique] = bundle.npcs;
  const lira = createWellEncounterNpc(ownerId, campaign.id);
  const path = 'campaigns/' + campaign.id;
  const docs = new Map<string, object>([[path, campaign]]);
  for (const npc of [{ ...teresa, location: familyKitchen }, henrique, lira]) {
    docs.set(path + '/npcs/' + npc.id, { ...npc, campaignId: campaign.id });
  }
  const db = memoryFirestore(docs);
  const state = () => docs.get(path) as typeof campaign;
  const timeline = campaign.activeTimelineId ?? 'tl_root';
  const started = performance.now();
  let calls = 0;
  let generated = 0;
  let accepted = 0;
  let replays = 0;
  let activeTurn = 0;
  let contextExposures = 0;
  await log({ type: 'run', mode: live ? 'groq' : 'fixed', model: live ? model : null,
    maxCalls: live ? maxCalls : 0, plannedTurns: steps.length, initialTime: campaign.worldTime });
  try {
    for (const [index, [command, recipient, location, minutes, needsNarrator]] of steps.entries()) {
      activeTurn = index + 1;
      const before = state();
      const expectedTime = advanceWorldTime(before.worldTime, minutes);
      const turn = { campaignId: campaign.id, turnId: randomUUID(), declaredAction: command,
        expectedRevision: before.revision, advanceMinutes: 10, baseTimelineId: timeline };
      let raw: string | undefined;
      let telemetry: object | undefined;
      const callsBefore = calls;
      const generatedBefore = generated;
      const runtime = () => docs.get(path + '/npcRoutineState/' + timeline) as { openObjects?: string[] } | undefined;
      const relevantState = () => ({ location: state().currentLocation, worldTime: state().worldTime,
        henriqueLocation: (docs.get(path + '/npcs/' + henrique.id) as typeof henrique).location,
        openObjects: runtime()?.openObjects ?? [], inventory: [], revision: state().revision });
      await log({ type: 'attempt', turn: activeTurn, recipient, command, authoritativeBefore: relevantState(),
        expectedLocation: location, expectedTime, needsNarrator });
      const result = await persistPilotTurn(db, freixoPlayableCatalog, ownerId, turn,
        async (arrival, sceneIntent, present, relationships, narrative, declaredAction) => {
          generated++;
          const input = { campaign: arrival, inventory: [], npcs: present.npcs, narrative, sceneIntent, declaredAction,
            sceneKnowledge: present.knowledge, npcActivities: present.activities,
            npcMemories: present.memories, npcRelationships: relationships };
          const context = buildNarratorContext(input);
          const prompt = buildNarratorPrompt({ context, sceneIntent, declaredAction });
          assert.equal(context.currentState.location, location);
          assert.deepEqual(context.currentState.worldTime, expectedTime);
          if (recipient) assert.deepEqual(context.currentState.knownPresentNpcs, [recipient]);
          const exposure = recipient !== 'Teresa' && prompt.includes(continuitySecret);
          if (index === 7) assert.ok(present.memories.some(({ name, memories }) => name === 'Teresa' &&
            memories.some(({ source, fact }) => source === 'reported' && fact === continuitySecret)));
          await log({ type: 'context', turn: activeTurn, recipient, context, sceneIntent, declaredAction, exposure });
          if (exposure) {
            contextExposures++;
            await log({ type: 'context-exposure', turn: activeTurn, recipient,
              inPrivateMemories: JSON.stringify(context.currentState.privateNpcMemories ?? []).includes(continuitySecret),
              inHistory: JSON.stringify(context.recentActiveHistory).includes(continuitySecret) });
            if (live) throw new Error('Envio bloqueado: exposição de confidência no contexto.');
          }
          if (!live) {
            // Positive canary for the existing autonomy guard.
            raw = index === 5 ? 'Samuel decide abandonar Freixo.' : recipient
              ? 'A fala encontra uma pausa atenta.' : 'O movimento da vila segue ao redor.';
            return raw;
          }
          assert.ok(calls < maxCalls, 'Limite de chamadas atingido.');
          calls++;
          const info = console.info;
          const warn = console.warn;
          const capture = (message: unknown, data?: object) => {
            if (message === '[narrator/turn] generation') telemetry = data;
          };
          console.info = capture;
          console.warn = capture;
          try {
            raw = await generateCampaignNarration(input, 'groq');
            return raw;
          } catch (error) {
            await log({ type: 'provider-error', turn: activeTurn, telemetry,
              failure: describeNarratorFailure(error, 'groq') });
            throw error;
          } finally {
            console.info = info;
            console.warn = warn;
          }
        });
      accepted++;
      assert.equal(state().revision, before.revision + 1);
      assert.equal(state().currentLocation, location);
      assert.deepEqual(state().worldTime, expectedTime);
      assert.equal(generated - generatedBefore, Number(needsNarrator));
      assert.equal(calls - callsBefore, live ? Number(needsNarrator) : 0);
      assert.deepEqual(runtime()?.openObjects ?? [], index >= 2 ? [cabinet] : []);
      assert.equal(relevantState().henriqueLocation, index >= 3 ? familyYard : freixoWoodWorkshop);
      assert.ok(![...docs.keys()].some((key) => key.startsWith(path + '/inventory/')));
      const ids = await turnDocumentIds(turn);
      assert.ok(docs.has(path + '/events/' + ids.event));
      assert.ok(docs.has(path + '/turnReceipts/' + turn.turnId));
      if (!live && index === 5) assert.equal(result.narration, custody);
      const contradictionFlags = raw ? reviewEchoArcNarration(raw) : [];
      const unconfirmedConsequence = raw ? claimsUnconfirmedPlayerConsequence(raw) : false;
      const possibleDisclosure = recipient !== 'Teresa' &&
        [raw, result.narration].some((text) => text?.includes(continuitySecret));
      await log({ type: 'result', turn: activeTurn, recipient, command, authoritativeAfter: relevantState(),
        provider: needsNarrator ? (live ? 'groq' : 'fixed') : 'engine', model: live && needsNarrator ? model : null,
        raw, narration: result.narration, telemetry, contradictionFlags, possibleDisclosure, unconfirmedConsequence,
        fallback: Boolean(raw && (result.narration === custody || result.narration === 'Nada mais se destaca neste momento.')),
        humanReview: live && needsNarrator });
      if (possibleDisclosure) throw new Error('Texto contém a confidência fora da conversa autorizada.');
      if (index === steps.length - 1) {
        const snapshot = [...docs];
        const replay = await persistPilotTurn(db, freixoPlayableCatalog, ownerId, turn,
          async () => assert.fail('Replay tentou gerar nova narração.'));
        assert.equal(replay.narration, result.narration);
        assert.deepEqual([...docs], snapshot);
        replays++;
        await log({ type: 'replay', turn: activeTurn, narrationPreserved: true, statePreserved: true });
      }
    }
  } catch (error) {
    const failure = error instanceof Error && 'code' in error ? error.code : undefined;
    await log({ type: 'failure', turn: activeTurn, failure, message: live ? undefined : String(error) });
    if (!live) console.error('Turno', activeTurn, String(error));
    throw error;
  } finally {
    const summary = { type: 'summary', accepted, calls, generated, replays, contextExposures,
      elapsedMs: Math.round(performance.now() - started) };
    await log(summary);
    console.info(JSON.stringify(summary));
  }
  return contextExposures;
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.length === 1 && args[0] === '--groq-autorizado';
  assert.ok(live || !args.length || (args.length === 1 && args[0] === '--fixed'),
    'Use --fixed ou --groq-autorizado após autorização explícita.');
  const exposures = await run(false);
  if (exposures) {
    console.error('Fase determinística reprovada: exposição de contexto privado. Nenhuma rodada real iniciada.');
    process.exitCode = 1;
  } else if (live) {
    await run(true);
  }
}

await main().catch(() => {
  console.error('Avaliação interrompida. Consulte o relatório local.');
  process.exitCode = 1;
});
