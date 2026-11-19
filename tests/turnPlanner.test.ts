import assert from 'node:assert/strict';
import test from 'node:test';
import { planTurn, resolvePlannedOutcome } from '../src/engine/turnPlanner';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { diagnoseCampaignTurn } from '../server/turnPlanDiagnostics';
import { evaluatePilotTurn, readTurnPlanPilot } from '../server/turnPlanPilot';

const state = { currentLocation: 'Porto' };
const catalog = {
  places: [{ id: 'Porto', aliases: [] }, { id: 'Torre do Norte', aliases: ['torre'] }],
  routes: [{ from: 'Porto', to: 'Torre do Norte', minutes: 8 }],
};

test('planeja deslocamento em catálogo genérico e preserva a origem se interrompido', () => {
  const plan = planTurn('Eu caminho até a torre e olho ao redor.', state, catalog);
  assert.equal(plan.status, 'planned');
  if (plan.status !== 'planned') return;
  assert.equal(plan.destination, 'Torre do Norte');
  assert.equal(plan.expectedMinutes, 8);
  assert.deepEqual(resolvePlannedOutcome(plan, { completed: false, elapsedMinutes: 3 }),
    { location: 'Porto', elapsedMinutes: 3 });
  assert.deepEqual(resolvePlannedOutcome(plan, { completed: true, elapsedMinutes: 8 }),
    { location: 'Torre do Norte', elapsedMinutes: 8 });
  assert.equal(resolvePlannedOutcome(plan, { completed: true, elapsedMinutes: 0 }), null);
  assert.equal(resolvePlannedOutcome(plan, { completed: false, elapsedMinutes: 9 }), null);
  assert.deepEqual(state, { currentLocation: 'Porto' });
});

test('observação e conversa não autorizam deslocamento', () => {
  for (const [action, kind, minutes] of [['Olho a torre', 'observe', 1], ['Converso com a vigia', 'talk', null]] as const) {
    const plan = planTurn(action, state, catalog);
    assert.equal(plan.status, 'planned');
    if (plan.status !== 'planned') continue;
    assert.equal(plan.intent.kind, kind);
    assert.equal(plan.expectedMinutes, minutes);
    assert.equal(plan.authorized.location, undefined);
  }
});

test('destino desconhecido, ambiguidade e condição não atendida exigem esclarecimento', () => {
  for (const [action, reason] of [['Vou até o castelo', 'unknown-destination'], ['Vou à torre ou ao porto', 'ambiguous-destination']] as const) {
    assert.deepEqual(planTurn(action, state, catalog), { status: 'clarification', origin: 'Porto', reason });
  }
  assert.deepEqual(planTurn('Vou à torre', state, catalog, [{ description: 'Acesso liberado', met: false }]),
    { status: 'clarification', origin: 'Porto', reason: 'unmet-conditions' });
});

test('diagnóstico usa registros da campanha, sem inferir conexões ou alterar o snapshot', () => {
  const bundle = createEchoArcBundle('dono-teste');
  const before = structuredClone(bundle);
  const npc = { ...bundle.npcs[0], location: 'Torre do Norte' };
  const foreign = { ...npc, ownerId: 'outro', location: 'Castelo' };
  const result = diagnoseCampaignTurn('Vou até a Torre do Norte', bundle.campaign, [npc, foreign]);
  assert.equal(result.mode, 'diagnostic');
  assert.deepEqual(result.result, { status: 'clarification', origin: bundle.campaign.currentLocation, reason: 'unknown-route' });
  assert.deepEqual(diagnoseCampaignTurn('Vou até o Castelo', bundle.campaign, [npc, foreign]).result,
    { status: 'clarification', origin: bundle.campaign.currentLocation, reason: 'unknown-destination' });
  assert.deepEqual(bundle, before);
});

test('piloto vincula plano ao turno e só calcula efeitos a partir de resultado confirmado', () => {
  const bundle = createEchoArcBundle('dono');
  const campaign = { ...bundle.campaign, currentLocation: 'Porto' };
  const turn = {
    turnId: 'a834b1ac-d3b4-4439-9f71-a135722ce71a',
    campaignId: campaign.id, declaredAction: 'Caminho até a torre',
    expectedRevision: campaign.revision, baseTimelineId: campaign.activeTimelineId || 'tl_root',
    advanceMinutes: 700,
  };
  const pilot = readTurnPlanPilot(JSON.stringify(catalog), campaign.id);
  const preview = evaluatePilotTurn(pilot, turn, 'dono', campaign);
  assert.equal(preview?.origin.turnId, turn.turnId);
  assert.equal(preview?.declaredAction, turn.declaredAction);
  assert.equal(preview?.plan.status === 'planned' && preview.plan.expectedMinutes, 8);
  assert.equal(preview?.allowedEffects, null);
  assert.equal(preview?.confirmed, null);
  assert.deepEqual(evaluatePilotTurn(pilot, turn, 'dono', campaign, { completed: true, elapsedMinutes: 8 })?.allowedEffects,
    { location: 'Torre do Norte', elapsedMinutes: 8 });
  assert.deepEqual(evaluatePilotTurn(pilot, turn, 'dono', campaign, { completed: false, elapsedMinutes: 3 })?.allowedEffects,
    { location: 'Porto', elapsedMinutes: 3 });
  assert.equal(evaluatePilotTurn(pilot, turn, 'dono', campaign, { completed: true, elapsedMinutes: 700 })?.allowedEffects, null);
  assert.equal(evaluatePilotTurn(undefined, turn, 'dono', campaign), undefined);
  assert.equal(evaluatePilotTurn(pilot, turn, 'outro', campaign), undefined);
  assert.equal(evaluatePilotTurn(pilot, turn, 'dono', { ...campaign, revision: campaign.revision + 1 }), undefined);
  assert.equal(evaluatePilotTurn(pilot, turn, 'dono', { ...campaign, activeTimelineId: 'ramo_restaurado' }), undefined);
  assert.equal(campaign.currentLocation, 'Porto');

  const blocked = readTurnPlanPilot(JSON.stringify({ ...catalog,
    routes: catalog.routes.map((route) => ({ ...route, blocked: true })),
  }), campaign.id);
  assert.deepEqual(evaluatePilotTurn(blocked, turn, 'dono', campaign)?.plan,
    { status: 'clarification', origin: 'Porto', reason: 'unmet-conditions' });
  assert.equal(evaluatePilotTurn(blocked, turn, 'dono', campaign, { completed: true, elapsedMinutes: 8 })?.allowedEffects, null);
});
