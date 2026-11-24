import assert from 'node:assert/strict';
import test from 'node:test';
import { freixoPlayableCatalog as legacyCatalog } from '../scripts/echoArcFreeTurn';
import { freixoWorldPack, familyRoom, familyYard, villageWell, freixoFamilyKitchen, freixoWoodWorkshop, freixoWoodland } from '../src/world/freixo';
import { defineWorldPack, type WorldPackV1 } from '../src/world/worldPack';
import { planPilotTravel, planTurn, resolvePlaceReference } from '../src/engine/turnPlanner';

test('Freixo preserva IDs persistidos, caminhos e referências no catálogo compartilhado', () => {
  const { catalog, npcs } = freixoWorldPack;
  assert.equal(catalog, legacyCatalog);
  assert.deepEqual(catalog.places.map(({ id }) => id), [
    'Cozinha da casa da família, Vila de Freixo', 'Quintal da casa da família, Vila de Freixo',
    'Poço da Vila de Freixo', 'Quarto de Samuel, casa da família, Vila de Freixo', freixoWoodWorkshop,
    'Bosque de Freixo',
  ]);
  assert.deepEqual(catalog.routes.map(({ from, to, minutes }) => [from, to, minutes]), [
    [freixoFamilyKitchen, familyYard, 2], [familyYard, freixoFamilyKitchen, 2],
    [familyYard, villageWell, 4], [villageWell, familyYard, 4],
    [freixoFamilyKitchen, villageWell, 6], [villageWell, freixoFamilyKitchen, 6],
    [freixoFamilyKitchen, familyRoom, 1], [familyRoom, freixoFamilyKitchen, 1],
    [familyYard, freixoWoodWorkshop, 4], [freixoWoodWorkshop, familyYard, 4],
    [villageWell, freixoWoodland, 5], [freixoWoodland, villageWell, 5],
  ]);
  assert.deepEqual(catalog.objects.map(({ id }) => id),
    ['demo-armario-cozinha', 'demo-bancada-cozinha', 'demo-bancada-oficina', 'freixo-bosque-marco-pedra', 'demo-bloco-madeira']);
  assert.equal(catalog.activities[0].id, 'demo-organizar-cozinha');
  assert.deepEqual(npcs.map(({ name, location }) => [name, location]),
    [['Teresa', freixoFamilyKitchen], ['Henrique', freixoWoodWorkshop], ['Lira', villageWell]]);
});

test('WorldPack rejeita duplicatas e referências quebradas antes de entregar o catálogo', () => {
  const { catalog, npcs } = freixoWorldPack;
  const validateCatalog = (change: Partial<WorldPackV1['catalog']>) =>
    defineWorldPack({ ...freixoWorldPack, catalog: { ...catalog, ...change } });
  assert.throws(() => validateCatalog({ places: [...catalog.places, catalog.places[0]] }), /duplicate place ID/);
  assert.throws(() => validateCatalog({ places: [
    ...catalog.places, { id: 'Outro local', stableId: 'freixo-bosque', aliases: [] },
  ] }), /duplicate stable place ID/);
  assert.throws(() => validateCatalog({ places: [
    ...catalog.places, { id: 'freixo-bosque', aliases: [] },
  ] }), /invalid stable place ID/);
  assert.throws(() => validateCatalog({ routes: [{ ...catalog.routes[0], to: 'missing' }] }), /route destination/);
  assert.throws(() => validateCatalog({ activities: [{ ...catalog.activities[0], location: villageWell }] }), /invalid activity/);
  assert.throws(() => validateCatalog({ objects: [{ ...catalog.objects[4], portable: { storageId: 'missing' } }] }), /invalid storage/);
  const teresa = npcs[0];
  assert.throws(() => defineWorldPack({ ...freixoWorldPack, npcs: [
    { ...teresa, identity: { ...teresa.identity!, routine: { ...teresa.identity!.routine!, location: 'missing' } } },
    ...npcs.slice(1),
  ] }), /routine of echo-arc:teresa/);
});

test('referências estáveis e legadas produzem o mesmo plano e preservam o formato de gravação', () => {
  const { catalog } = freixoWorldPack;
  const woodland = resolvePlaceReference(catalog, 'freixo-bosque');
  assert.ok(woodland);
  assert.equal(woodland.id, freixoWoodland);
  assert.equal(resolvePlaceReference(catalog, freixoWoodland), woodland);
  assert.equal(resolvePlaceReference(catalog, 'bosque'), undefined);
  assert.equal(resolvePlaceReference(catalog, 'freixo-inexistente'), undefined);
  const restored = { currentLocation: villageWell };
  const legacy = planTurn({ kind: 'travel', destination: freixoWoodland }, restored, catalog);
  assert.deepEqual(planTurn({ kind: 'travel', destination: 'freixo-bosque' }, restored, catalog), legacy);
  assert.deepEqual(planTurn({ kind: 'travel', destination: 'freixo-bosque' },
    { currentLocation: 'freixo-poco' }, catalog), legacy);
  assert.equal(legacy.status, 'planned');
  assert.equal(legacy.authorized.location, freixoWoodland);
  const renamed = { ...catalog, places: catalog.places.map((place) =>
    place.id === freixoWoodland ? { ...place, name: 'Mata de Freixo' } : place) };
  assert.deepEqual(planPilotTravel('Vou à Mata de Freixo.', restored, renamed),
    planPilotTravel('Vou ao bosque.', restored, catalog));
  assert.equal(restored.currentLocation, villageWell);
});
