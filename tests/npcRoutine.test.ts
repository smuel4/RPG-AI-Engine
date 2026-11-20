import assert from 'node:assert/strict';
import test from 'node:test';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { advanceNpcRoutines, routineScene } from '../src/engine/npcRoutine';
import { advanceWorldTime } from '../src/engine/rulesEngine';
import { familyYard, freixoPlayableCatalog } from '../scripts/echoArcFreeTurn';
import { planTurn } from '../src/engine/turnPlanner';

const bundle = createEchoArcBundle('dono');
const [teresa, henrique] = bundle.npcs;
const home = teresa.location;
const workshop = henrique.location;
const campaign = { ...bundle.campaign, currentLocation: 'Praça' };
const npcs = [teresa, { ...henrique, location: home }];
const catalog = {
  places: [{ id: home, aliases: [] }, { id: workshop, aliases: [] }, { id: 'Praça', aliases: [] }],
  routes: [{ from: home, to: workshop, minutes: 4 }],
};
const end = advanceWorldTime(campaign.worldTime, 8);

test('a ligação provisória serve ao jogador e à rotina de Henrique no piloto', () => {
  const atYard = { ...campaign, currentLocation: familyYard };
  const plan = planTurn('Vou até a oficina de Henrique.', atYard, freixoPlayableCatalog);
  assert.equal(plan.status, 'planned');
  if (plan.status !== 'planned') return;
  assert.equal(plan.destination, workshop);
  assert.equal(plan.expectedMinutes, 4);
  const records = [teresa, { ...henrique, location: familyYard }];
  const arrival = { ...atYard, currentLocation: workshop, worldTime: advanceWorldTime(atYard.worldTime, 4) };
  const routine = advanceNpcRoutines(atYard, arrival.worldTime, records, freixoPlayableCatalog);
  assert.equal(routine.moves[0]?.to, workshop);
  assert.deepEqual(routineScene(arrival, records, routine.state).npcs, []);
  assert.deepEqual(routineScene(arrival, [teresa, henrique], routine.state).activities.map(({ name }) => name), ['Henrique']);
  const late = { ...atYard, worldTime: { ...atYard.worldTime, hour: 11, minute: 0 } };
  assert.deepEqual(advanceNpcRoutines(late, advanceWorldTime(late.worldTime, 4), records, freixoPlayableCatalog).moves, []);
  const closed = routineScene({ ...late, currentLocation: workshop }, [teresa, henrique], routine.state);
  assert.deepEqual(closed.npcs.map(({ name }) => name), ['Henrique']);
  assert.deepEqual(closed.activities, []);
});

test('rotina fora da cena, atividade de Teresa e testemunho individual nos encontros', () => {
  const routine = advanceNpcRoutines(campaign, end, npcs, catalog, undefined,
    { turnId: 'turno-deslocamento', sequence: campaign.lastSequence });
  assert.deepEqual(routine.moves.map(({ from, to }) => [from, to]), [[home, workshop]]);
  assert.equal(npcs[1].location, home);
  const next = [teresa, { ...henrique, location: workshop }];
  assert.deepEqual(routineScene({ ...campaign, worldTime: end }, next, routine.state),
    { npcs: [], knowledge: [], activities: [], memories: [] });
  const homeScene = routineScene({ ...campaign, currentLocation: home, worldTime: end }, next, routine.state);
  assert.deepEqual(homeScene.npcs.map(({ name }) => name), ['Teresa']);
  assert.deepEqual(homeScene.memories, [{ name: 'Teresa', memories: [{ source: 'observed', fact: 'Viu Henrique sair.' }] }]);
  assert.equal(homeScene.activities[0].name, 'Teresa');
  const workScene = routineScene({ ...campaign, currentLocation: workshop, worldTime: end }, next, routine.state);
  assert.deepEqual(workScene.npcs.map(({ name }) => name), ['Henrique']);
  assert.equal(workScene.memories.length, 0);
  assert.equal(workScene.activities[0].name, 'Henrique');
  assert.equal(advanceNpcRoutines({ ...campaign, worldTime: end }, advanceWorldTime(end, 8), next, catalog,
    routine.state).state, routine.state);
});

test('rota bloqueada, falta de tempo, compromisso e universo diferente preservam posição', () => {
  assert.equal(advanceNpcRoutines(campaign, end, npcs, { ...catalog,
    routes: [{ ...catalog.routes[0], blocked: true }] }).moves.length, 0);
  assert.equal(advanceNpcRoutines(campaign, advanceWorldTime(campaign.worldTime, 3), npcs, catalog).moves.length, 0);
  assert.equal(advanceNpcRoutines(campaign, end, npcs, catalog, { activities: [], observations: [],
    holds: [{ npcId: henrique.id, until: end, reason: 'commitment' }] }).moves.length, 0);
  assert.equal(advanceNpcRoutines({ ...campaign, name: 'Outro universo' }, end, npcs, catalog).moves.length, 0);
});

test('espera respeita a ordem, o fim da janela e compromissos existentes', () => {
  const start = { ...campaign, worldTime: { ...campaign.worldTime, hour: 10, minute: 50 } };
  const finish = advanceWorldTime(start.worldTime, 30);
  const saved = { activities: [], observations: [], holds: [{ npcId: henrique.id,
    until: advanceWorldTime(start.worldTime, 3), reason: 'commitment' as const }] };
  const waited = advanceNpcRoutines(start, finish, [...npcs].reverse(), catalog, saved, undefined, true);
  assert.deepEqual(waited.state.activities.map(({ npcId }) => npcId), [teresa.id, henrique.id]);
  assert.equal(waited.moves[0].to, workshop);
  const beforeClose = { ...start, currentLocation: workshop, worldTime: advanceWorldTime(start.worldTime, 8) };
  assert.deepEqual(routineScene(beforeClose, [henrique], waited.state).activities.map(({ name }) => name), ['Henrique']);
  assert.deepEqual(routineScene({ ...beforeClose, worldTime: finish }, [henrique], waited.state).activities, []);
  assert.equal(advanceNpcRoutines(start, finish, npcs, { ...catalog,
    routes: [{ ...catalog.routes[0], blocked: true }] }, saved, undefined, true).moves.length, 0);
  assert.equal(advanceNpcRoutines(start, finish, npcs, catalog, { ...saved, holds: [{ ...saved.holds[0],
    until: advanceWorldTime(start.worldTime, 8) }] }, undefined, true).moves.length, 0);
});

test('Henrique encerra o trabalho e só inicia a pausa depois do percurso permitido', () => {
  const start = { ...campaign, currentLocation: workshop, worldTime: { ...campaign.worldTime, hour: 10, minute: 50 } };
  const records = [henrique];
  const endTime = advanceWorldTime(start.worldTime, 45);
  const result = advanceNpcRoutines(start, endTime, records, freixoPlayableCatalog, undefined, undefined, true);
  assert.deepEqual(advanceNpcRoutines(start, endTime, records, freixoPlayableCatalog), result);
  assert.deepEqual(result.state.activities.map(({ location, stage }) => ({ location, stage })),
    [{ location: workshop, stage: undefined }, { location: familyYard, stage: 'next' }]);
  assert.deepEqual(result.moves.map(({ from, to }) => [from, to]), [[workshop, familyYard]]);
  assert.equal(routineScene({ ...start, worldTime: advanceWorldTime(start.worldTime, 10) }, records, result.state).activities.length, 0);
  const arrival = { ...start, currentLocation: familyYard, worldTime: endTime };
  assert.match(routineScene(arrival, [{ ...henrique, location: familyYard }], result.state).activities[0].activity, /pausa no quintal/);
  assert.equal(advanceNpcRoutines(arrival, advanceWorldTime(endTime, 10), [{ ...henrique, location: familyYard }],
    freixoPlayableCatalog, result.state).state, result.state);
  assert.equal(advanceNpcRoutines(start, advanceWorldTime(start.worldTime, 42), records, freixoPlayableCatalog).moves.length, 0);
  const blocked = { ...freixoPlayableCatalog, routes: freixoPlayableCatalog.routes.map((route) =>
    route.from === workshop && route.to === familyYard ? { ...route, blocked: true } : route) };
  const refused = advanceNpcRoutines(start, endTime, records, blocked);
  assert.equal(refused.moves.length, 0);
  assert.equal(refused.state.activities.length, 1);
});
