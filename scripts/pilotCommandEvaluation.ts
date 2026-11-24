import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { persistPilotTurn, PilotTurnError, SERVER_PILOT_ID } from '../server/persistPilotTurn';
import { describePilotFeedback } from '../server/pilotFeedback';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { createWellEncounterNpc } from '../src/engine/echoArcEncounters';
import { advanceWorldTime } from '../src/engine/rulesEngine';
import { planPilotTravelIntent, resolvePlaceReference, type TurnCatalog, type TurnPlan } from '../src/engine/turnPlanner';
import { freixoPlayableCatalog, freixoFamilyKitchen, freixoWoodWorkshop } from '../src/world/freixo';
import type { NarrativeEntry } from '../src/types/game';
import { memoryFirestore } from './freixoEvaluationStore';
import { commandCorpus, targets, type CommandCase, type CommandStep } from './pilotCommandCorpus';

// This version of the wire contract only proposes a single trip, a clarification, or an abstention.
type TravelIntent = Extract<TurnPlan['intent'], { kind: 'travel' }>;
export type SemanticProposal = TravelIntent | { kind: 'clarify' } | { kind: 'abstain' };

export function decodeSemanticProposal(input: unknown, allowedPlaceIds: ReadonlySet<string>): SemanticProposal | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return;
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if (!keys.includes('kind')) return;
  if ((value.kind === 'clarify' || value.kind === 'abstain') && keys.length === 1) return { kind: value.kind };
  if (value.kind === 'travel' && keys.includes('destination') && keys.length === 2 && typeof value.destination === 'string' &&
      allowedPlaceIds.has(value.destination)) return { kind: 'travel', destination: value.destination };
}

export function evaluateShadow(input: unknown, origin: string, catalog: TurnCatalog, allowedPlaceIds: ReadonlySet<string>) {
  const proposal = decodeSemanticProposal(input, allowedPlaceIds);
  if (!proposal) return { status: 'invalid' } as const;
  if (proposal.kind !== 'travel') return { status: proposal.kind } as const;
  const place = resolvePlaceReference(catalog, proposal.destination);
  if (place?.stableId !== proposal.destination) return { status: 'invalid' } as const;
  // Feed the resolved ID to the same bounded route planner used after deterministic recognition.
  const route = planPilotTravelIntent({ kind: 'travel', destination: place.id }, { currentLocation: origin }, catalog);
  if (route.status !== 'planned') return { status: 'blocked', reason: route.reason } as const;
  if (route.destination !== place.id || route.origin === route.destination) {
    return { status: 'blocked', reason: 'inconsistent-or-current-place' } as const;
  }
  return { status: 'route-valid', target: place.id, minutes: route.expectedMinutes } as const;
}

// Hand-authored to exercise the harness. No synthetic travel originates from the holdout.
const synthetic: Readonly<Record<string, unknown>> = {
  'original-17': { kind: 'travel', destination: 'freixo-poco' },
  'development-01': { kind: 'travel', destination: 'freixo-poco' },
  'development-02': { kind: 'travel', destination: 'freixo-oficina' },
  'development-03': { kind: 'abstain' },
  'development-06': { kind: 'abstain' },
  'development-07': { kind: 'abstain' },
};

// Audit of the whole utterance in its synthetic scene, independent of the destination key.
// Each entry authorizes a single affirmative trip using public place vocabulary only.
const auditedTrips: ReadonlyMap<string, string> = new Map([
  ['original-17', 'Bato perna rumo ao poço.'],
  ['development-01', 'Quero regressar ao poço.'],
  ['development-02', 'Vou dar uma passada na oficina.'],
  ['holdout-01', 'Tomo o rumo do bosque.'],
  ['holdout-02', 'Dou um pulo no quarto.'],
]);

const measurements = ['latencyMs', 'inputTokens', 'outputTokens', 'costUsd'] as const;
type Telemetry = Partial<Record<typeof measurements[number], number>>;
type ExternalResult = { proposal?: unknown; telemetry?: Telemetry };

export function readExternalResults(input: unknown, cases: readonly CommandCase[] = commandCorpus): ReadonlyMap<string, ExternalResult> {
  if (!Array.isArray(input)) throw new Error('As propostas devem ser uma lista JSON.');
  const knownCases = new Set(cases.map(({ id }) => id));
  const results = new Map<string, ExternalResult>();
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some((key) => !['id', 'proposal', 'telemetry'].includes(key)) ||
        !knownCases.has(item.id) || results.has(item.id)) {
      throw new Error('Entrada externa inválida, com ID de caso desconhecido ou duplicado.');
    }
    const row = item as ExternalResult & { id: string };
    if (row.telemetry !== undefined) {
      if (!row.telemetry || typeof row.telemetry !== 'object' || Array.isArray(row.telemetry) ||
          Object.entries(row.telemetry).some(([key, value]) =>
            !measurements.some((field) => field === key) || typeof value !== 'number' || !Number.isFinite(value) ||
            value < 0 || (key.endsWith('Tokens') && !Number.isSafeInteger(value)))) {
        throw new Error('Telemetria inválida para ' + row.id);
      }
    }
    results.set(row.id, { proposal: row.proposal, telemetry: row.telemetry });
  }
  return results;
}

function missedTravel(error?: { code: string; reason?: string; step?: number }) {
  return error?.step === undefined && (error?.code === 'PILOT_ACTION_UNSUPPORTED' ||
    (error?.code === 'PILOT_TRAVEL_UNAVAILABLE' && error.reason === 'unknown-destination'));
}

interface ReceiptStep extends Partial<TurnPlan> {
  kind?: string;
  focus?: string;
  statement?: string;
  recipientId?: string;
  objectId?: string;
  containerId?: string;
  to?: string;
}
type ReceiptPlan = ReceiptStep & { steps?: ReceiptStep[] };
const normalize = (value: string | undefined) => value?.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^a-z0-9 ]/gu, '').replace(/\s+/gu, ' ').trim();

export function evaluationCatalog(scene: CommandCase['scene']) {
  const routes = scene.withoutRoutes ? [] : freixoPlayableCatalog.routes.filter(({ to }) => to !== scene.blockedDestination);
  return { ...freixoPlayableCatalog, routes };
}

export function publicTravelRequest(id: string, command: string, location: string, catalog: TurnCatalog) {
  const origin = resolvePlaceReference(catalog, location);
  if (!origin?.stableId) return;
  const destinations = catalog.places.flatMap(({ id, stableId }) => stableId && origin.id !== id &&
    planPilotTravelIntent({ kind: 'travel', destination: stableId }, { currentLocation: location }, catalog).status === 'planned'
    ? [{ id: stableId, name: id }] : []);
  return { id, command, origin: { id: origin.stableId, name: origin.id }, destinations };
}

export async function evaluateCommand(sample: CommandCase, external?: ReadonlyMap<string, ExternalResult>,
  auditedTrip = auditedTrips.get(sample.id) === sample.text) {
  const owner = 'semantic-fixture';
  const { campaign: seed, npcs: [teresa, henrique] } = createEchoArcBundle(owner);
  const [hour, minute] = sample.scene.clock ?? [seed.worldTime.hour, seed.worldTime.minute];
  const campaign = { ...seed, id: SERVER_PILOT_ID, currentLocation: sample.scene.location,
    worldTime: advanceWorldTime({ ...seed.worldTime, hour, minute }, 0) };
  const path = 'campaigns/' + campaign.id;
  const original = sample.split === 'original';
  const npcs = [createWellEncounterNpc(owner, campaign.id), ...original ? [] : [
    { ...teresa, id: targets.teresa, campaignId: campaign.id, location: freixoFamilyKitchen },
    { ...henrique, id: targets.henrique, campaignId: campaign.id, location: freixoWoodWorkshop },
  ]];
  const docs = new Map<string, object>([[path, campaign], ...npcs.map((npc) => [path + '/npcs/' + npc.id, npc] as const)]);
  const db = memoryFirestore(docs);
  const catalog = evaluationCatalog(sample.scene);
  const state = () => docs.get(path) as typeof campaign;
  const evaluationId = crypto.randomUUID();
  const send = (turnId: string, declaredAction: string) => persistPilotTurn(db, catalog, owner, {
    campaignId: campaign.id, turnId, baseTimelineId: state().activeTimelineId ?? 'tl_root',
    expectedRevision: state().revision, advanceMinutes: 10, declaredAction,
  }, async () => 'A luz ilumina as pedras.');
  for (const setup of sample.scene.setup ?? []) await send(crypto.randomUUID(), setup);
  const snapshot = structuredClone([...docs]);
  const start = state();
  let actual;
  try {
    const { narration } = await send(evaluationId, sample.text);
    const receipt = docs.get(path + '/turnReceipts/' + evaluationId) as { plan: ReceiptPlan; playerEntryId: string };
    const entry = docs.get(path + '/narrative/' + receipt.playerEntryId) as NarrativeEntry | undefined;
    const planned = receipt.plan.steps ?? [receipt.plan];
    const steps: CommandStep[] = planned.map((plan, i) => {
      const kind = plan.intent?.kind ?? plan.kind ?? 'unknown';
      const target = plan.destination ?? plan.objectId ?? plan.recipientId ??
        (kind === 'observation' ? entry?.pilotFocus?.[i]?.id ?? plan.focus : undefined);
      return { kind, target, statement: plan.statement, to: plan.to, containerId: plan.containerId,
        recipientId: kind === 'delivery' ? plan.recipientId : undefined };
    });
    const expectedEnd = sample.steps.slice().reverse().find(({ kind }) => kind === 'travel')?.target ?? start.currentLocation;
    const noWorldEffect = state().currentLocation === start.currentLocation &&
      JSON.stringify(state().worldTime) === JSON.stringify(start.worldTime);
    const query = sample.expected === 'consultar' && planned.length === 1 && planned[0].kind === 'observation' &&
      noWorldEffect && narration.includes(sample.answer ?? '') &&
      (sample.steps[0].kind !== 'npc-query' || normalize(planned[0].focus) ===
        normalize(npcs.find(({ id }) => id === sample.steps[0].target)?.name));
    const matches = planned.length === sample.steps.length && sample.steps.every((expected, i) =>
      Object.entries(expected).every(([key, value]) => steps[i][key as keyof CommandStep] === value));
    const worldMatches = sample.minutes !== undefined && state().currentLocation === expectedEnd &&
      JSON.stringify(state().worldTime) === JSON.stringify(advanceWorldTime(start.worldTime, sample.minutes));
    const unsafe = sample.expected !== 'executar' && (!noWorldEffect || steps.some(({ kind }) => kind !== 'observation'));
    actual = { category: query || (sample.expected === 'executar' && matches && worldMatches) ? 'correct'
      : unsafe ? 'unsafe' : 'wrong', steps, narration };
  } catch (error) {
    if (!(error instanceof PilotTurnError) || !error.code.startsWith('PILOT_')) throw error;
    assert.deepEqual(structuredClone([...docs]), snapshot, sample.id + ' gravou mudanças durante uma recusa');
    const { code, reason, step, absentNpcName, feedback } = error;
    const expectedRefusal = sample.refusal;
    const observed = { code, reason, step, absentNpcName, objectName: feedback?.objectName };
    const matches = expectedRefusal?.code && Object.entries(expectedRefusal).every(([key, value]) =>
      key === 'group' || value === undefined || observed[key as keyof typeof observed] === value);
    const unrecognized = !expectedRefusal && (code === 'PILOT_ACTION_UNSUPPORTED' ||
      (code === 'PILOT_TRAVEL_UNAVAILABLE' && reason === 'unknown-destination' &&
        sample.expected === 'executar' && sample.steps[0]?.kind === 'travel'));
    actual = { category: matches ? expectedRefusal.group
      : unrecognized ? 'unrecognized' : 'wrong', error: observed,
      feedback: describePilotFeedback(error, Boolean(error.clarificationPrefix)) };
  }
  const publicRequest = publicTravelRequest(sample.id, sample.text, start.currentLocation, catalog);
  const allowedIds = new Set(publicRequest?.destinations.map(({ id }) => id));
  const eligible = Boolean(allowedIds.size && auditedTrip &&
    !sample.scene.setup?.length && !sample.scene.withoutRoutes && !sample.scene.blockedDestination && missedTravel(actual.error));
  const cohort = eligible ? 'eligible-travel'
    : sample.refusal?.group === 'missing' ? sample.steps[0]?.kind === 'travel' ? 'missing-destination' : 'missing-content'
    : sample.refusal?.group === 'blocked' ? 'rule-blocked'
    : sample.refusal?.reason === 'ambiguous-destination' ? 'ambiguous-destination'
    : sample.expected === 'esclarecer' ? 'clarification-required'
    : sample.expected === 'consultar' || sample.expected === 'abster-se' ? 'query-or-nonaffirmative'
    : actual.category === 'correct' && sample.steps.length === 1 && sample.steps[0].kind === 'travel' ? 'recognized-travel'
    : 'other';
  const request = eligible ? publicRequest : undefined;
  const received = external?.get(sample.id);
  const offered = external ? received?.proposal : synthetic[sample.id];
  const proposal = decodeSemanticProposal(offered, new Set(catalog.places.map(({ stableId }) => stableId)));
  const shadow = offered === undefined ? undefined
    : !eligible && proposal?.kind === 'travel' ? { status: 'ineligible' } as const
    : evaluateShadow(offered, start.currentLocation, catalog, allowedIds);
  const shadowRecovery = eligible && sample.expected === 'executar' &&
    sample.steps.length === 1 && sample.steps[0].kind === 'travel' &&
    shadow?.status === 'route-valid' && shadow.target === sample.steps[0].target && shadow.minutes === sample.minutes;
  return { id: sample.id, split: sample.split, text: sample.text, scene: sample.scene, expected: sample.expected,
    expectedSteps: sample.steps, reason: sample.reason, ...actual, cohort, request, shadow, shadowRecovery,
    received: external ? external.has(sample.id) : offered !== undefined,
    proposedTravel: offered !== null && typeof offered === 'object' && 'kind' in offered && offered.kind === 'travel',
    telemetry: received?.telemetry };
}

export async function evaluateCorpus(external?: ReadonlyMap<string, ExternalResult>) {
  const results = [];
  for (const sample of commandCorpus) results.push(await evaluateCommand(sample, external));
  return results;
}

export function summarizeShadow(results: Awaited<ReturnType<typeof evaluateCorpus>>) {
  const eligible = results.filter(({ cohort }) => cohort === 'eligible-travel');
  const count = (rows: typeof results) => ({
    cases: rows.length,
    received: rows.filter(({ received }) => received).length,
    travelProposals: rows.filter(({ proposedTravel }) => proposedTravel).length,
    routeValid: rows.filter(({ shadow }) => shadow?.status === 'route-valid').length,
    wrongTarget: rows.filter(({ shadow, expectedSteps }) =>
      shadow?.status === 'route-valid' && shadow.target !== expectedSteps[0]?.target).length,
    recoveries: rows.filter(({ shadowRecovery }) => shadowRecovery).length,
    clarifications: rows.filter(({ shadow }) => shadow?.status === 'clarify').length,
    abstentions: rows.filter(({ shadow }) => shadow?.status === 'abstain').length,
    invalid: rows.filter(({ shadow }) => shadow?.status === 'invalid').length,
    blocked: rows.filter(({ shadow }) => shadow?.status === 'blocked').length,
    ineligibleTravel: rows.filter(({ shadow }) => shadow?.status === 'ineligible').length,
    missingProposal: rows.filter(({ shadow }) => !shadow).length,
  });
  const eligibleSummary = count(eligible);
  const values = (key: keyof Telemetry) => eligible.flatMap(({ telemetry }) =>
    telemetry?.[key] === undefined ? [] : [telemetry[key]]);
  const latencies = values('latencyMs').sort((a, b) => a - b);
  const percentile = (p: number) => latencies[Math.ceil(p * latencies.length) - 1] ?? null;
  const sum = (key: Exclude<keyof Telemetry, 'latencyMs'>) => {
    const samples = values(key);
    return { samples: samples.length, total: samples.length ? samples.reduce((total, n) => total + n, 0) : null };
  };
  const cost = sum('costUsd');
  return {
    eligible: eligibleSummary,
    byCohort: Object.fromEntries([...new Set(results.map(({ cohort }) => cohort))].map((cohort) =>
      [cohort, count(results.filter((row) => row.cohort === cohort))])),
    bySplit: Object.fromEntries(['original', 'development', 'holdout'].map((split) =>
      [split, count(eligible.filter((row) => row.split === split))])),
    inappropriateTravelAccepted: results.filter(({ cohort, shadow }) =>
      cohort !== 'eligible-travel' && shadow?.status === 'route-valid').length + eligibleSummary.wrongTarget,
    telemetry: { latencyMs: { samples: latencies.length, p50: percentile(0.50), p95: percentile(0.95) },
      inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), costUsd: cost,
      costUsdPerRecovery: cost.total !== null && cost.samples === eligible.length && eligibleSummary.recoveries
        ? cost.total / eligibleSummary.recoveries : null },
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const details = args.at(-1) === '--details';
  if (details) args.pop();
  if (args.length && !(args.length === 1 && args[0] === '--requests') &&
      !(args.length === 2 && args[0] === '--proposals')) {
    throw new Error('Use [--requests | --proposals arquivo.json] [--details]. A execução com provedor está desabilitada.');
  }
  const external = args[0] === '--proposals'
    ? readExternalResults(JSON.parse((await readFile(args[1], 'utf8')).replace(/^\uFEFF/u, ''))) : undefined;
  const results = await evaluateCorpus(external);
  if (args[0] === '--requests') {
    console.log(JSON.stringify(results.flatMap(({ request }) => request ? [request] : []), null, 2));
  } else {
    const count = (field: 'category' | 'expected', subset = results) => Object.fromEntries(
      [...new Set(subset.map((row) => row[field]))].map((value) => [value, subset.filter((row) => row[field] === value).length]));
    const splits = Object.fromEntries(['original', 'development', 'holdout'].map((split) => {
      const subset = results.filter((row) => row.split === split);
      return [split, { total: subset.length, expected: count('expected', subset), results: count('category', subset) }];
    }));
    console.log(JSON.stringify({ total: results.length, expected: count('expected'), results: count('category'), splits,
      shadow: summarizeShadow(results),
    }, null, 2));
    if (details) for (const row of results) console.log(JSON.stringify(row));
  }
}
