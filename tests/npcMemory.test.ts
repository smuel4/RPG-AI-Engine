import assert from 'node:assert/strict';
import test from 'node:test';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { recallNpcMemories, recordNpcMemories, type NpcMemory } from '../src/engine/npcMemory';
import { buildNarratorContext } from '../server/narratorMemory';
import { buildNarratorPrompt } from '../server/narratorProvider';

test('relato estruturado chega somente ao destinatário presente na linha temporal autorizada', () => {
  const bundle = createEchoArcBundle('dono');
  const [teresa, henrique] = bundle.npcs;
  const campaign = { ...bundle.campaign, currentLocation: teresa.location, lastSequence: 8 };
  const report: NpcMemory = {
    npcId: teresa.id, timelineId: 'tl_root', turnId: 'turno-relato', sequence: 8,
    origin: { kind: 'reported', reporterId: henrique.id }, fact: 'Henrique contou que o portão estava aberto.',
  };
  const saved = recordNpcMemories([], [report, report]);
  assert.equal(saved.length, 1);
  const memory = recallNpcMemories(campaign, bundle.npcs, saved);
  assert.deepEqual(memory, [{ name: 'Teresa', memories: [{ source: 'reported', fact: report.fact }] }]);
  assert.deepEqual(recallNpcMemories({ ...campaign, currentLocation: henrique.location }, bundle.npcs, saved), []);
  assert.deepEqual(recallNpcMemories({ ...campaign, activeTimelineId: 'tl_restored' }, bundle.npcs, saved), []);
  assert.deepEqual(recallNpcMemories({ ...campaign, lastSequence: 7 }, bundle.npcs, saved), []);
  assert.deepEqual(recallNpcMemories({ ...campaign, ownerId: 'outro' }, bundle.npcs, saved), []);
  const input = { campaign, npcs: bundle.npcs, inventory: [], narrative: [] };
  assert.match(buildNarratorPrompt({ declaredAction: 'Observo a mesa.',
    context: buildNarratorContext({ ...input, npcMemories: memory }) }), /privateNpcMemories/);
  assert.doesNotMatch(buildNarratorPrompt({ declaredAction: 'Observo a mesa.',
    context: buildNarratorContext(input) }), /privateNpcMemories/);
  const history = recordNpcMemories([], Array.from({ length: 20 }, (_, i) =>
    ({ ...report, turnId: String(i), sequence: i, fact: 'Relato ' + i })));
  assert.equal(history.length, 12);
  assert.equal(recallNpcMemories({ ...campaign, lastSequence: 20 }, bundle.npcs, history)[0].memories.length, 3);
  assert.equal(recordNpcMemories([], [{ ...report, fact: 'x'.repeat(181) }]).length, 0);
});
