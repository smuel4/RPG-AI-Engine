import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeSemanticProposal, evaluateCommand, evaluateCorpus, evaluateShadow, readExternalResults,
  summarizeShadow } from '../scripts/pilotCommandEvaluation';
import { commandCorpus, targets } from '../scripts/pilotCommandCorpus';
import { blindCorpus } from '../scripts/pilotBlindCorpus';
import { evaluateBlindBenchmark, exportBlindRequests } from '../scripts/pilotBlindBenchmark';
import { freixoPlayableCatalog, familyYard, villageWell } from '../src/world/freixo';

test('lote cego exporta somente campos públicos e separa sugestão do modelo da política', async () => {
  const requests = exportBlindRequests();
  assert.equal(requests.length, 24);
  assert.equal(new Set(requests.map(({ id }) => id)).size, 24);
  for (const request of requests) {
    assert.deepEqual(Object.keys(request), ['id', 'command', 'origin', 'destinations']);
    assert.ok(!commandCorpus.some(({ text }) => text === request.command));
  }
  const destinationsOf = (id: string) => requests.find((request) => request.id === id)!.destinations;
  assert.equal(destinationsOf('b12').some(({ id }) => id === 'freixo-oficina'), false);
  assert.ok(destinationsOf('b12').length > 0);
  assert.equal(destinationsOf('b24').some(({ id }) => id === 'freixo-quarto'), false);
  const travel = (id: string, destination: string) => ({ id, proposal: { kind: 'travel', destination } });
  const { summary, rows } = await evaluateBlindBenchmark([
    travel('b01', 'freixo-quintal'),
    travel('b02', 'freixo-quarto'), // Rota válida para uma pergunta.
    travel('b03', 'freixo-oficina'), // Rota válida para o destino errado.
    travel('b04', 'freixo-inexistente'),
    { id: 'b06', proposal: { kind: 'clarify' } },
    travel('b12', 'freixo-oficina'),
    travel('b21', 'freixo-cozinha'), // Reconhecida pelo baseline.
    { id: 'b24', proposal: { kind: 'abstain' } },
  ]);
  assert.equal(summary.eligible, 7);
  assert.equal(summary.recoveries, 1);
  assert.equal(summary.reserved.cases, 8);
  assert.equal(summary.reserved.eligible, 2);
  assert.equal(summary.reserved.wrongTargets, 1);
  assert.equal(summary.invalid, 2);
  assert.equal(summary.missing, 16);
  assert.equal(summary.byGroup['route-question'].inappropriateTravelSuggestions, 1);
  assert.equal(summary.byGroup.hypothesis.inappropriateTravelSuggestions, 1);
  assert.equal(summary.correctClarifications, 1);
  assert.equal(summary.correctAbstentions, 1);
  assert.equal(summary.policyRouteValidOutsideEligibility, 0);
  for (const id of ['b02', 'b21']) {
    assert.equal(rows.find((row) => row.id === id)?.diagnostic?.status, 'route-valid');
    assert.equal(rows.find((row) => row.id === id)?.policy?.status, 'ineligible');
  }
  assert.throws(() => readExternalResults([{ id: 'original-17' }], blindCorpus));
  assert.throws(() => readExternalResults([{ id: 'b01' }, { id: 'b01' }], blindCorpus));
});

test('contrato semântico restringe campos e referências permitidas', () => {
  const ids = new Set(['freixo-poco']);
  const travel = { kind: 'travel', destination: 'freixo-poco' };
  assert.deepEqual(decodeSemanticProposal(travel, ids), travel);
  assert.deepEqual(decodeSemanticProposal({ kind: 'clarify' }, ids), { kind: 'clarify' });
  assert.deepEqual(decodeSemanticProposal({ kind: 'abstain' }, ids), { kind: 'abstain' });
  for (const invalid of [
    null, [], 'travel', { kind: 'travel' }, { ...travel, destination: villageWell },
    { ...travel, destination: 'freixo-bosque' }, { ...travel, destination: 1 },
    { ...travel, elapsedMinutes: 4 }, { ...travel, effects: {} }, { ...travel, steps: [travel] },
    { kind: 'clarify', statement: 'Inventada' }, { kind: 'speech', statement: 'Inventada' },
    Object.assign(Object.create({ destination: 'freixo-poco' }), { kind: 'travel', extra: true }),
  ]) assert.equal(decodeSemanticProposal(invalid, ids), undefined);
});

test('proposta com ID válido continua sujeita às rotas do piloto', () => {
  const ids = new Set(['freixo-poco', 'inexistente']);
  const travel = { kind: 'travel', destination: 'freixo-poco' };
  assert.deepEqual(evaluateShadow(travel, familyYard, freixoPlayableCatalog, ids),
    { status: 'route-valid', target: villageWell, minutes: 4 });
  assert.deepEqual(evaluateShadow(travel, 'freixo-quintal', freixoPlayableCatalog, ids),
    evaluateShadow(travel, familyYard, freixoPlayableCatalog, ids));
  assert.equal(evaluateShadow({ ...travel, destination: villageWell }, familyYard, freixoPlayableCatalog,
    new Set([villageWell])).status, 'invalid');
  assert.deepEqual(evaluateShadow(travel, familyYard, { ...freixoPlayableCatalog, routes: [] }, ids),
    { status: 'blocked', reason: 'unknown-route' });
  assert.equal(evaluateShadow(travel, villageWell, freixoPlayableCatalog, ids).status, 'blocked');
  assert.equal(evaluateShadow({ ...travel, destination: 'inexistente' }, familyYard, freixoPlayableCatalog, ids).status, 'invalid');
});

test('lote externo fica restrito à elegibilidade auditada e compara o destino real', async () => {
  const travel = { kind: 'travel', destination: 'freixo-poco' };
  const controls = ['original-01', 'original-05', 'original-13', 'original-15', 'original-18', 'original-19',
    'development-12', 'holdout-08'];
  const external = readExternalResults([
    ...controls.map((id) => ({ id, proposal: travel })),
    { id: 'original-17', proposal: travel, telemetry: { latencyMs: 20, inputTokens: 8, costUsd: 0 } },
    { id: 'development-01', proposal: { ...travel, destination: 'freixo-oficina' } },
    { id: 'development-02', proposal: { ...travel, destination: 'freixo-quintal' } },
    { id: 'holdout-01', proposal: { kind: 'clarify' } },
    { id: 'holdout-02', telemetry: { latencyMs: 40 } },
  ]);
  const results = await evaluateCorpus(external);
  const byId = new Map(results.map((result) => [result.id, result]));
  const requests = results.flatMap(({ request }) => request ? [request] : []);
  assert.equal(requests.length, 5);
  assert.deepEqual(requests.map(({ id }) => id), ['original-17', 'development-01', 'development-02', 'holdout-01', 'holdout-02']);
  for (const request of requests) {
    assert.deepEqual(Object.keys(request), ['id', 'command', 'origin', 'destinations']);
    assert.equal(request.destinations.length, 5);
    assert.ok(request.destinations.every(({ id }) => id !== request.origin.id));
  }
  for (const id of controls) assert.equal(byId.get(id)?.shadow?.status, 'ineligible', id);
  assert.equal(byId.get('development-02')?.shadow?.status, 'invalid');
  assert.equal(byId.get('holdout-02')?.received, true);
  assert.equal(byId.get('original-01')?.category, 'correct');
  const summary = summarizeShadow(results);
  assert.equal(summary.eligible.recoveries, 1);
  assert.equal(summary.eligible.wrongTarget, 1);
  assert.equal(summary.eligible.clarifications, 1);
  assert.equal(summary.eligible.missingProposal, 1);
  assert.equal(summary.inappropriateTravelAccepted, 1);
  assert.deepEqual(summary.telemetry.latencyMs, { samples: 2, p50: 20, p95: 40 });
  assert.deepEqual(summary.telemetry.costUsd, { samples: 1, total: 0 });
  assert.equal(summary.telemetry.costUsdPerRecovery, null);
  assert.equal(summarizeShadow(await evaluateCorpus(new Map())).eligible.recoveries, 0);

  const original = commandCorpus.find(({ id }) => id === 'original-17')!;
  const modified = await evaluateCommand({ ...original, text: 'Talvez eu vá ao poço.' }, external);
  assert.equal(modified.request, undefined);
  assert.equal(modified.shadow?.status, 'ineligible');
});

test('importação rejeita envelopes ambíguos e telemetria malformada', () => {
  const row = { id: 'original-17', proposal: { kind: 'abstain' } };
  for (const invalid of [
    {}, [row, row], [{ ...row, id: 'desconhecido' }], [{ ...row, state: {} }],
    [{ ...row, telemetry: { latencyMs: -1 } }], [{ ...row, telemetry: { costUsd: Infinity } }],
    [{ ...row, telemetry: { inputTokens: 2.5 } }], [{ ...row, telemetry: { privateNotes: 'texto' } }],
  ]) assert.throws(() => readExternalResults(invalid));
});

test('avaliador lê recibos, preserva recusas e mantém o holdout livre de propostas sintéticas', async () => {
  const results = await evaluateCorpus();
  assert.equal(new Set(results.map(({ id }) => id)).size, commandCorpus.length);
  assert.equal(results.filter(({ split }) => split === 'original').length, 19);
  const byId = new Map(results.map((result) => [result.id, result]));
  assert.equal(byId.get('original-05')?.category, 'correct');
  assert.equal(byId.get('original-09')?.category, 'correct');
  assert.equal(byId.get('original-12')?.category, 'blocked');
  assert.equal(byId.get('original-13')?.category, 'missing');
  assert.equal(byId.get('original-15')?.category, 'clarify');
  assert.equal(byId.get('original-18')?.category, 'abstain');
  assert.equal(byId.get('development-03')?.category, 'correct');
  assert.equal(byId.get('development-08')?.category, 'correct');
  assert.equal(byId.get('development-15')?.category, 'correct');
  assert.equal(byId.get('development-23')?.category, 'correct');
  for (const id of ['holdout-07', 'holdout-08', 'holdout-09']) {
    assert.equal(byId.get(id)?.category, 'clarify');
  }
  assert.ok(results.filter(({ split }) => split === 'holdout').every(({ shadow }) => shadow === undefined));

  const pickup = commandCorpus.find(({ id }) => id === 'development-19')!;
  const forbidden = await evaluateCommand({ ...pickup, expected: 'esclarecer' });
  assert.equal(forbidden.category, 'unsafe');
  const mismatch = await evaluateCommand({ ...pickup, steps: [{ kind: 'pickup', target: targets.marker }] });
  assert.equal(mismatch.category, 'wrong');
});
