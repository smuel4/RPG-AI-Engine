import test from 'node:test';
import assert from 'node:assert/strict';
import type { Campaign, NarrativeEntry } from '../src/types/game';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { buildNarratorContext } from '../server/narratorMemory';
import { buildNarratorPrompt } from '../server/narratorProvider';

test('perfis presentes mantêm identidade, rotina local e conhecimento individual no prompt compartilhado', () => {
  const { campaign, npcs, narrative } = createEchoArcBundle('dono');
  const [teresa, henrique] = npcs;
  const contextAt = (location: string, hour: number, records = npcs, publicOnly = false) => buildNarratorContext({
    publicOnly,
    campaign: { ...campaign, currentLocation: location, worldTime: { ...campaign.worldTime, hour } },
    npcs: records, inventory: [], narrative: [],
    sceneKnowledge: [
      { source: 'public', fact: 'A feira é hoje.' },
      { source: 'observed', fact: 'A janela abriu.', knownBy: ['echo-arc:teresa'] },
      { source: 'conversation', fact: 'A porta range.', knownBy: ['echo-arc:henrique'] },
      { source: 'interpretation', fact: 'Talvez haja vento.', knownBy: ['echo-arc:teresa'] },
      { source: 'player-private', fact: 'Pensamento reservado.' },
    ],
  });
  const home = contextAt(teresa.location, 8);
  const shop = contextAt(henrique.location, 8);
  assert.deepEqual(home.currentState.knownPresentNpcs, ['Teresa']);
  assert.deepEqual(shop.currentState.knownPresentNpcs, ['Henrique']);
  const [mother] = home.currentState.npcSceneProfiles;
  const [father] = shop.currentState.npcSceneProfiles;
  assert.equal(mother.key, 'echo-arc:teresa');
  assert.equal(father.key, 'echo-arc:henrique');
  assert.notEqual(mother.voice, father.voice);
  assert.ok(mother.suggestedActivity);
  assert.ok(father.suggestedActivity);
  assert.equal(mother.appearance, undefined);
  assert.equal(father.appearance, undefined);
  const [later] = contextAt(teresa.location, 14, [{ ...teresa, id: 'outro_id' }]).currentState.npcSceneProfiles;
  assert.equal(later.key, mother.key);
  assert.equal(later.suggestedActivity, undefined);
  assert.deepEqual(contextAt('Vila de Freixo', 8).currentState.npcSceneProfiles, []);
  assert.deepEqual(contextAt(teresa.location, 8, [{ ...teresa, ownerId: 'outro' }]).currentState.npcSceneProfiles, []);
  const prompt = buildNarratorPrompt({ context: home, declaredAction: 'Observo a mesa.' });
  assert.match(prompt, /A feira é hoje/);
  assert.match(prompt, /A janela abriu/);
  assert.match(prompt, /Talvez haja vento/);
  assert.doesNotMatch(prompt, /A porta range|Pensamento reservado/);
  assert.ok(father.knowledge.some(({ source, fact }) => source === 'conversation' && fact === 'A porta range.'));
  const publicContext = contextAt(teresa.location, 8, npcs, true);
  assert.deepEqual(publicContext.currentState.npcSceneProfiles[0].knowledge,
    [{ source: 'public', fact: 'A feira é hoje.' }]);
  const seed = { ...narrative[0], createdAt: null };
  const general = buildNarratorContext({ campaign, npcs, inventory: [], publicOnly: true, narrative: [
    seed, { ...seed, id: 'private', privateRecipientId: teresa.id, content: 'Confidência de teste' },
  ] });
  assert.ok(general.recentActiveHistory.some(({ content }) => content === narrative[0].content));
  assert.doesNotMatch(JSON.stringify(general), /Confidência de teste/);
});

const campaign = {
  id: 'camp_teste',
  ownerId: 'jogador_teste',
  name: 'ECHO ARC',
  setting: 'Fantasia',
  currentLocation: 'Vila de Freixo',
  lastSequence: 8,
  activeTimelineId: 'linha_restaurada',
  timelineLineage: [
    { timelineId: 'linha_original', fromSequence: 0, toSequence: 2 },
    { timelineId: 'linha_restaurada', fromSequence: 6, toSequence: null },
  ],
  protagonist: { name: 'Samuel' },
  worldTime: { day: 1, hour: 8, minute: 0 },
} as Campaign;

function entry(
  id: string,
  timelineId: string,
  sequence: number,
  content: string,
): NarrativeEntry {
  return {
    id,
    ownerId: 'jogador_teste',
    campaignId: 'camp_teste',
    timelineId,
    sequence,
    authorRole: 'player_action',
    content,
    worldTimeLabel: 'Manha',
  };
}

test('Memoria ignora acontecimentos desfeitos pelo checkpoint', () => {
  const narrative = [
    entry('a', 'linha_original', 1, 'Samuel conversa com Teresa'),
    entry('b', 'linha_original', 4, 'Samuel discute com Henrique'),
    entry('c', 'linha_restaurada', 6, 'Samuel retorna a cozinha'),
    entry('d', 'linha_restaurada', 7, 'Samuel cumprimenta Henrique'),
  ];

  const result = buildNarratorContext({
    campaign,
    inventory: [],
    npcs: [],
    narrative,
  });

  const remembered = result.recentActiveHistory.map(
    (item: { content: string }) => item.content,
  );

  assert.equal(result.currentState.location, 'Vila de Freixo');
  assert.equal(result.currentState.activeTimelineId, 'linha_restaurada');
  assert.deepEqual(remembered, [
    'Samuel conversa com Teresa',
    'Samuel retorna a cozinha',
    'Samuel cumprimenta Henrique',
  ]);
});

test('Memoria ignora entradas de outra campanha', () => {
  const foreignEntry = {
    ...entry('x', 'linha_restaurada', 7, 'Segredo de outra campanha'),
    campaignId: 'outra_campanha',
  };

  const result = buildNarratorContext({
    campaign,
    inventory: [],
    npcs: [],
    narrative: [foreignEntry],
  });

  assert.equal(result.recentActiveHistory.length, 0);
});
test('Memoria seleciona os 16 acontecimentos mais recentes em ordem', () => {
  const longCampaign: Campaign = {
    ...campaign,
    lastSequence: 40,
  };

  const entries = Array.from({ length: 20 }, (_, index) =>
    entry(
      `hist_${index}`,
      'linha_restaurada',
      index + 6,
      `Acontecimento ${index + 1}`,
    ),
  ).reverse();

  const result = buildNarratorContext({
    campaign: longCampaign,
    inventory: [],
    npcs: [],
    narrative: entries,
  });

  const history = result.recentActiveHistory;

  assert.equal(history.length, 16);
  assert.equal(history[0].content, 'Acontecimento 5');
  assert.equal(history[15].content, 'Acontecimento 20');
});

test('Memoria preserva os registros confiaveis dos pais adotivos e separa suas localizacoes', () => {
  const bundle = createEchoArcBundle('dono');
  const alternateNpc = {
    ...bundle.npcs[0],
    ownerId: 'outro_dono',
    notes: 'Uma biografia de outra campanha.',
  };
  const result = buildNarratorContext({
    ...bundle,
    npcs: [alternateNpc, ...bundle.npcs],
  });

  assert.deepEqual(result.establishedRecords.npcs, bundle.npcs.map((npc) => ({
    name: npc.name, role: npc.role, relationship: npc.relationship, notes: npc.notes,
  })));
  assert.deepEqual(result.establishedRecords.npcs.map((npc: { role: string }) => npc.role),
    ['Mãe adotiva', 'Pai adotivo']);
  assert.deepEqual(result.currentState.npcLocations, bundle.npcs.map((npc) => ({
    name: npc.name, location: npc.location,
  })));
  assert.equal(result.currentState.location, bundle.campaign.currentLocation);
  assert.equal(result.currentState.worldTime.hour, bundle.campaign.worldTime.hour);
});

test('Memoria usa os registros da campanha atual sem presumir parentesco a partir de nomes', () => {
  const bundle = createEchoArcBundle('dono');
  const npc = { ...bundle.npcs[0], role: 'Vizinha', relationship: 'Conhecida', notes: 'Vende farinha.' };
  const result = buildNarratorContext({
    ...bundle,
    campaign: { ...bundle.campaign, name: 'Outra hist?ria' },
    npcs: [npc],
  });
  assert.deepEqual(result.establishedRecords.npcs, [{
    name: 'Teresa', role: 'Vizinha', relationship: 'Conhecida', notes: 'Vende farinha.',
  }]);
});

test('Memoria preserva desfechos inteiros e descarta turnos antigos em pares dentro do orcamento', () => {
  const turns = Array.from({ length: 4 }, (_, index) => {
    const sequence = 6 + 2 * index;
    return [
      entry('a' + index, 'linha_restaurada', sequence, ('Samuel pergunta. ').repeat(40)),
      {
        ...entry('n' + index, 'linha_restaurada', sequence + 1,
          'x'.repeat(1650) + ' Henrique confirma o combinado ' + index + '.'),
        authorRole: 'engine_response' as const,
      },
    ];
  });
  const result = buildNarratorContext({
    campaign: { ...campaign, lastSequence: 13 },
    inventory: [],
    npcs: [],
    narrative: turns.flat(),
  });
  assert.deepEqual(result.recentActiveHistory.map(({ content }) => content),
    turns.slice(1).flat().map(({ content }) => content));
});
