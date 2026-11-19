import assert from 'node:assert/strict';
import test from 'node:test';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { initialRelationship, recordPersonalDisclosure, relationshipsInScene } from '../src/engine/npcRelationship';

test('preserva vínculos iniciais e evolui relações direcionais conforme o contexto', () => {
  const [teresa, henrique] = createEchoArcBundle('dono').npcs;
  const origin = { timelineId: 'tl_root', turnId: 'turn-1', sequence: 4 };
  const family = initialRelationship(teresa, 'player', origin.timelineId);
  const stranger = { ...teresa, relationship: '' };
  assert.equal(family.bond, 'family');
  assert.equal(family.familiarity, 3);
  assert.equal(family.trust, 4);
  assert.equal(recordPersonalDisclosure([], teresa, 'player', origin)[0].familiarity, 4);
  assert.equal(recordPersonalDisclosure([], stranger, 'player', origin)[0].familiarity, 1);
  const betweenNpcs = recordPersonalDisclosure([], teresa, henrique.id, origin);
  assert.equal(betweenNpcs.length, 1);
  assert.equal(betweenNpcs[0].from, teresa.id);
  assert.equal(betweenNpcs[0].toward, henrique.id);
  assert.equal(recordPersonalDisclosure(betweenNpcs, teresa, henrique.id, { ...origin, turnId: 'turn-2' }), betweenNpcs);
  assert.ok(relationshipsInScene([teresa, henrique], 'tl_root', betweenNpcs)
    .some(({ character, toward }) => character === 'Teresa' && toward === 'Henrique'));
  assert.ok(!relationshipsInScene([teresa, henrique], 'tl_other', betweenNpcs).some(({ toward }) => toward === 'Henrique'));
  assert.ok(!relationshipsInScene([teresa], 'tl_root', betweenNpcs).some(({ toward }) => toward === 'Henrique'));
});
