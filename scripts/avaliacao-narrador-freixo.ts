import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { buildNarratorContext } from '../server/narratorMemory';
import { generateCampaignNarration } from '../server/narratorService';
import { buildNarratorPrompt, describeNarratorFailure, narratorInstructions } from '../server/narratorProvider';
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
import { createFreixoGroqBudget } from './echoArcRateLimit';

const model = 'openai/gpt-oss-120b';
const maxCalls = 6;
const maxCompletionTokens = 1000;
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
const reviewFocus = [
  'A resposta soa como uma saudação em família e dá voz própria a Teresa?',
  'Teresa reage à confidência com naturalidade, sem decidir como Samuel se sente ou o que fará?',
  'A confirmação deixa claro que o armário abriu, sem acrescentar outra ação?',
  'A passagem de tempo é clara e o encontro seguinte combina com a nova rotina?',
  'A chegada apresenta o quintal e Henrique, sem voltar a narrar a ação de Samuel?',
  'Henrique responde com incerteza, sem alegar que Samuel já mencionou o assunto? Uma hipótese deve soar como hipótese.',
  'O retorno parece parte da mesma sessão? Confira local, horário, armário e referências à conversa privada.',
  'Teresa retoma o receio de Samuel de atravessar sozinho? Um comentário sobre o vento basta apenas se também responder à lembrança. Qualquer oferta de ajuda deixa a travessia em aberto?',
] as const;

async function run(live: boolean) {
  if (live) {
    dotenv.config({ quiet: true });
    assert.ok(process.env.GROQ_API_KEY?.trim(), 'Groq sem chave configurada.');
    assert.ok((process.env.GROQ_MODEL?.trim() || model) === model, 'Modelo Groq diferente do aprovado.');
    process.env.GROQ_MAX_OUTPUT_TOKENS = String(maxCompletionTokens);
  }
  const cache = resolve('node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const report = join(await mkdtemp(join(cache, 'echo-arc-playtest-v3-')), 'turnos.jsonl');
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
  const budget = createFreixoGroqBudget(maxCalls);
  let generated = 0;
  let accepted = 0;
  let replays = 0;
  let activeTurn = 0;
  let contextExposures = 0;
  await log({ type: 'run', mode: live ? 'groq' : 'fixed', model: live ? model : null,
    maxCalls: live ? maxCalls : 0, maxCompletionTokensPerCall: live ? maxCompletionTokens : null,
    plannedTurns: steps.length, initialTime: campaign.worldTime, systemInstructions: narratorInstructions });
  try {
    for (const [index, [command, recipient, location, minutes, needsNarrator]] of steps.entries()) {
      activeTurn = index + 1;
      const before = state();
      const expectedTime = advanceWorldTime(before.worldTime, minutes);
      const turn = { campaignId: campaign.id, turnId: randomUUID(), declaredAction: command,
        expectedRevision: before.revision, advanceMinutes: 10, baseTimelineId: timeline };
      let raw: string | undefined;
      const telemetry: object[] = [];
      const callsBefore = budget.calls;
      const generatedBefore = generated;
      const runtime = () => docs.get(path + '/npcRoutineState/' + timeline) as { openObjects?: string[] } | undefined;
      const routineBefore = index === 7 ? structuredClone(runtime()) : undefined;
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
          else {
            assert.equal(context.currentState.privateNpcMemories, undefined);
            assert.equal(context.currentState.privateNpcRelationships, undefined);
          }
          const exposure = recipient !== 'Teresa' && prompt.includes(continuitySecret);
          if (index === 1) {
            assert.ok(declaredAction.includes(continuitySecret));
            assert.ok(!JSON.stringify(context).includes(continuitySecret));
          }
          if (index === 5) {
            assert.deepEqual(context.recentActiveHistory, []);
            assert.equal(context.currentState.privateNpcMemories, undefined);
          }
          if (index === 7) assert.ok(present.memories.some(({ name, memories }) => name === 'Teresa' &&
            memories.some(({ source, speaker, fact }) =>
              source === 'reported' && speaker === 'Samuel' && fact === continuitySecret)));
          await log({ type: 'context', turn: activeTurn, recipient, context, prompt, exposure });
          if (exposure) {
            contextExposures++;
            await log({ type: 'context-exposure', turn: activeTurn, recipient,
              inPrivateMemories: JSON.stringify(context.currentState.privateNpcMemories ?? []).includes(continuitySecret),
              inHistory: JSON.stringify(context.recentActiveHistory).includes(continuitySecret) });
            if (live) throw new Error('Envio bloqueado: exposição de confidência no contexto.');
          }
          if (!live) {
            // Positive canary for the existing autonomy guard.
            raw = index === 5 ? 'Samuel decide abandonar Freixo.'
              : index === 7 ? 'Teresa baixa a voz. "Você me disse que a ideia de cruzar a ponte sem companhia te preocupa. Se quiser, posso ir com você."'
              : recipient ? 'A fala encontra uma pausa atenta.' : 'O movimento da vila segue ao redor.';
            return raw;
          }
          const info = console.info;
          const warn = console.warn;
          const capture = (message: unknown, data?: object) => {
            if (message === '[narrator/turn] generation' && data) telemetry.push(data);
          };
          console.info = capture;
          console.warn = capture;
          try {
            raw = await budget.generate(narratorInstructions + prompt, maxCompletionTokens,
              () => generateCampaignNarration(input, 'groq'));
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
      assert.deepEqual(state().protagonist, before.protagonist);
      if (index === 7) {
        assert.deepEqual(runtime(), routineBefore, 'A resposta de Teresa criou um efeito de rotina.');
        if (!live) assert.equal(result.narration, raw, 'A oferta condicional deveria permanecer na prosa.');
      }
      assert.equal(generated - generatedBefore, Number(needsNarrator));
      const attempts = budget.calls - callsBefore;
      if (live && needsNarrator) assert.ok(attempts >= 1 && attempts <= 2);
      else assert.equal(attempts, 0);
      assert.deepEqual(runtime()?.openObjects ?? [], index >= 2 ? [cabinet] : []);
      assert.equal(relevantState().henriqueLocation, index >= 3 ? familyYard : freixoWoodWorkshop);
      assert.ok(![...docs.keys()].some((key) => key.startsWith(path + '/inventory/')));
      const ids = await turnDocumentIds(turn);
      assert.ok(docs.has(path + '/events/' + ids.event));
      assert.ok(docs.has(path + '/turnReceipts/' + turn.turnId));
      if (!live && index === 5) assert.equal(result.narration, custody);
      const reviewFlags = raw ? reviewEchoArcNarration(raw) : [];
      const unconfirmedConsequence = raw ? claimsUnconfirmedPlayerConsequence(raw) : false;
      const possibleDisclosure = recipient !== 'Teresa' &&
        [raw, result.narration].some((text) => text?.includes(continuitySecret));
      await log({ type: 'result', turn: activeTurn, recipient, command, authoritativeAfter: relevantState(),
        provider: needsNarrator ? (live ? 'groq' : 'fixed') : 'engine', model: live && needsNarrator ? model : null,
        raw, narration: result.narration, telemetry: telemetry.at(-1), attempts: telemetry,
        automaticChecks: {
          authoritativeState: 'verified', authoritativeStateScope: 'persisted-state-only',
          literalDisclosure: possibleDisclosure, unconfirmedConsequence,
        },
        reviewFlags,
        fallback: Boolean(raw && (result.narration === custody || result.narration === 'Nada mais se destaca neste momento.')),
        humanReview: {
          status: 'pending',
          focus: reviewFocus[index],
          factualConsistency: live || !needsNarrator ? 'pending' : 'fixed-sample',
          naturalnessAndCoherence: live || !needsNarrator ? 'pending' : 'fixed-sample',
        } });
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
    const summary = { type: 'summary', accepted, calls: budget.calls, generated, replays, contextExposures,
      elapsedMs: Math.round(performance.now() - started) };
    await log(summary);
    console.info(JSON.stringify(summary));
  }
  return contextExposures;
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.length === 2 && args.includes('--groq-autorizado') &&
    args.includes('--cota-gratuita-confirmada');
  if (!live && args.length && !(args.length === 1 && args[0] === '--fixed')) {
    throw new Error('Use --fixed. A execução real exige --groq-autorizado --cota-gratuita-confirmada.');
  }
  const exposures = await run(false);
  if (exposures) {
    console.error('Fase determinística reprovada: exposição de contexto privado. Nenhuma rodada real iniciada.');
    process.exitCode = 1;
  } else if (live) {
    await run(true);
  }
}

await main().catch((error: unknown) => {
  const usage = error instanceof Error && error.message.startsWith('Use --fixed.') ? error.message : undefined;
  console.error(usage ?? 'Avaliação interrompida. Consulte o relatório local.');
  process.exitCode = 1;
});
