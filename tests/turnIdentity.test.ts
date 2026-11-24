import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCommittedTurn } from '../server/campaignAccess';
import { checkTurnRevision, turnDocumentIds } from '../src/engine/turnIdentity';
import { selectOwnedCampaignId, SERVER_PILOT_ID } from '../src/engine/pilotCampaign';

test('piloto visual ignora campanhas comuns mesmo quando o nome ou a URL apontam para ECHO ARC', () => {
  const general = { id: 'echo_arc_comum', name: 'ECHO ARC' };
  const pilot = { id: SERVER_PILOT_ID, name: 'ECHO ARC' };
  assert.equal(selectOwnedCampaignId([general, pilot], general.id, true), pilot.id);
  assert.equal(selectOwnedCampaignId([general], general.id, true), null);
  assert.equal(selectOwnedCampaignId([], pilot.id, true), null);
  assert.equal(selectOwnedCampaignId([general, pilot], general.id, false), general.id);
  assert.equal(selectOwnedCampaignId([general, pilot], null, false), general.id);
});

const turn = {
  turnId: '00000000-0000-4000-8000-000000000001',
  campaignId: 'campanha', declaredAction: 'Olho ao redor', expectedRevision: 7,
  baseTimelineId: 'tl_root', advanceMinutes: 1,
};

test('identidade vincula intenção, campanha, duração, revisão e linha temporal', async () => {
  const ids = await turnDocumentIds(turn);
  assert.deepEqual(await turnDocumentIds({ ...turn, declaredAction: '  Olho ao redor ' }), ids);
  for (const input of [{ declaredAction: 'Corro' }, { expectedRevision: 8 }, { baseTimelineId: 'restaurada' },
    { advanceMinutes: 20 }, { campaignId: 'outra' }]) {
    const changed = await turnDocumentIds({ ...turn, ...input });
    assert.equal(changed.event, ids.event);
    assert.notEqual(changed.player, ids.player);
    assert.notEqual(changed.engine, ids.engine);
  }
  assert.equal(checkTurnRevision(turn, { revision: 7 }), true);
  assert.equal(checkTurnRevision(turn, { revision: 8 }), false);
  assert.equal(checkTurnRevision(turn, { revision: 7, activeTimelineId: 'restaurada' }), false);
});

test('reenvio recupera o resultado salvo, e conteúdo diferente conflita com o mesmo turno', async () => {
  const ids = await turnDocumentIds(turn);
  const common = { ownerId: 'dono', campaignId: turn.campaignId, timelineId: turn.baseTimelineId };
  const saved = new Map<string, Record<string, string | number>>([
    [ids.event, { ...common, type: 'PLAYER_ACTION', sequence: 13 }],
    [ids.player, { ...common, authorRole: 'player_action', sequence: 11, content: turn.declaredAction }],
    [ids.engine, { ...common, authorRole: 'engine_response', sequence: 12, content: 'Narração já registrada' }],
  ]);
  const read: typeof fetch = async (url) => {
    const entry = saved.get(String(url).split('/').at(-1)!);
    return entry ? Response.json({ fields: Object.fromEntries(Object.entries(entry).map(([key, value]) =>
      [key, typeof value === 'number' ? { integerValue: String(value) } : { stringValue: value }])) })
      : new Response(null, { status: 404 });
  };
  for (const receipt of await Promise.all([
    fetchCommittedTurn(turn, 'fake', 'dono', read),
    fetchCommittedTurn(turn, 'fake', 'dono', read),
  ])) {
    assert.equal(receipt.status, 'replayed');
    if (receipt.status === 'replayed') assert.equal(receipt.entry.content, 'Narração já registrada');
  }
  assert.equal((await fetchCommittedTurn({ ...turn, advanceMinutes: 2 }, 'fake', 'dono', read)).status, 'conflict');
  assert.equal((await fetchCommittedTurn(turn, 'fake', 'outro', read)).status, 'conflict');
  assert.equal(saved.size, 3);
  saved.clear();
  assert.equal((await fetchCommittedTurn(turn, 'fake', 'dono', read)).status, 'new');
});
