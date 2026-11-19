import assert from 'node:assert/strict';
import test from 'node:test';
import { createContinuityFixture, familyKitchen } from '../scripts/echoArcContinuityFixture';
import { familyRoom, familyYard, FreeTurnClarification, placeWellEncounter, planFreeTurn, runFreeTurn, shouldEndFreeSession, villageWell } from '../scripts/echoArcFreeTurn';
import { buildNarratorContext } from '../server/narratorMemory';
import { buildNarratorPrompt, describeNarratorFailure, NarratorFailure, validateNarration } from '../server/narratorProvider';

const action = 'Samuel pergunta como pode ajudar.';
const intent = 'Conversa cotidiana.';

test('Uma narrativa com 2000 caracteres avanca o turno uma vez', async () => {
  const state = createContinuityFixture();
  const initial = structuredClone(state);
  const text = 'x'.repeat(2000);
  let calls = 0;
  assert.equal(await runFreeTurn(state, action, intent, async () => {
    calls++;
    return validateNarration(' ' + text + ' ', 'groq');
  }), text);
  assert.equal(calls, 1);
  assert.equal(state.campaign.revision, initial.campaign.revision + 1);
  assert.equal(state.narrative.length, initial.narrative.length + 2);
});

test('A recuperacao conserva contexto e aplica somente a narrativa valida', async () => {
  for (const provider of ['groq', 'gemini'] as const) {
    const state = createContinuityFixture();
    const initial = structuredClone(state);
    const prompts: string[] = [];
    const result = await runFreeTurn(state, action, intent, async (input) => {
      assert.deepEqual(state, initial);
      prompts.push(buildNarratorPrompt({ ...input, context: buildNarratorContext(input) }));
      return validateNarration(input.compact ? 'Teresa pede uma tigela.' : 'x'.repeat(2001), provider);
    });
    assert.equal(prompts.length, 2);
    assert.ok(prompts[1].startsWith(prompts[0]));
    assert.match(prompts[1], /750 caracteres/);
    assert.equal(state.campaign.worldTime.minute, initial.campaign.worldTime.minute + 5);
    assert.equal(state.narrative.length, initial.narrative.length + 2);
    assert.equal(state.narrative.at(-1)?.content, result);
  }
});

test('Sair retira os NPCs da lista de presentes e a observacao conserva o local externo', async () => {
  const state = createContinuityFixture();
  const initialMinute = state.campaign.worldTime.minute;
  await runFreeTurn(state, 'sair', '', async (input) => {
    assert.equal(state.campaign.currentLocation, familyKitchen);
    const scene = buildNarratorContext(input).currentState;
    assert.equal(scene.location, familyYard);
    assert.deepEqual(scene.knownPresentNpcs, []);
    return 'Do quintal, vê-se a cerca e a rua.';
  });
  assert.equal(state.campaign.currentLocation, familyYard);
  await runFreeTurn(state, 'olho as casas em volta', '', async (input) => {
    assert.match(input.sceneIntent ?? '', /alvo indicado/);
    assert.equal(input.campaign.currentLocation, familyYard);
    assert.equal(input.declaredAction, 'olho as casas em volta');
    return 'As casas têm telhados baixos e portas azuis.';
  });
  assert.equal(state.campaign.currentLocation, familyYard);
  assert.equal(state.campaign.worldTime.minute, (initialMinute + 3) % 60);
});

test('Cortar lenha consome mais tempo e a prosa nao promove posses ou deslocamentos', async () => {
  const state = createContinuityFixture();
  const before = structuredClone(state);
  assert.equal(planFreeTurn(familyKitchen, 'olho em volta').minutes, 1);
  assert.equal(planFreeTurn(familyKitchen, 'eu não saio').location, familyKitchen);
  assert.equal(planFreeTurn(familyKitchen, 'pergunto se devo sair').location, familyKitchen);
  await runFreeTurn(state, 'vou cortar as madeiras, estão lá faz tempo', '', async (input) => {
    assert.match(input.sceneIntent ?? '', /restante da tarefa em aberto/);
    return 'Samuel recebe uma bolsa de moedas e vai ao mercado.';
  });
  assert.equal(state.campaign.worldTime.minute, before.campaign.worldTime.minute + 10);
  assert.equal(state.campaign.currentLocation, familyKitchen);
  assert.deepEqual(state.inventory, before.inventory);
  assert.deepEqual(state.npcs, before.npcs);
  assert.deepEqual(state.campaign.protagonist, before.campaign.protagonist);
});

test('Deslocamento rejeitado duas vezes nao altera nem posicao nem relogio', async () => {
  const state = createContinuityFixture();
  const before = structuredClone(state);
  let attempts = 0;
  await assert.rejects(runFreeTurn(state, 'sair', '', async (input) => {
    attempts++;
    assert.equal(input.campaign.currentLocation, familyYard);
    return validateNarration('x'.repeat(2001), 'groq');
  }), /NARRATION_EXCEEDS_LIMIT/);
  assert.equal(attempts, 2);
  assert.deepEqual(state, before);
});

test('Uma recuperacao sem sucesso preserva o estado e permite outro turno', async () => {
  for (const secondFailure of ['NARRATION_EXCEEDS_LIMIT', 'TIMEOUT_EXCEEDED']) {
    const state = createContinuityFixture();
    const initial = structuredClone(state);
    let calls = 0;
    await assert.rejects(runFreeTurn(state, action, intent, async (input) => {
      calls++;
      if (input.compact && secondFailure === 'TIMEOUT_EXCEEDED') {
        throw new NarratorFailure(secondFailure, 'timeout');
      }
      return validateNarration('x'.repeat(2031), 'groq');
    }), (error: unknown) => {
      const failure = describeNarratorFailure(error, 'groq');
      assert.equal(failure.code, secondFailure);
      if (secondFailure === 'NARRATION_EXCEEDS_LIMIT') assert.equal('narrationLength' in failure && failure.narrationLength, 2031);
      return true;
    });
    assert.equal(calls, 2);
    assert.deepEqual(state, initial);
    await runFreeTurn(state, action, intent, async () => 'Henrique fecha o armário.');
    assert.equal(state.narrative.length, initial.narrative.length + 2);
  }
});

test('Falha de provedor na primeira tentativa nao gera retry', async () => {
  const state = createContinuityFixture();
  const initial = structuredClone(state);
  let calls = 0;
  await assert.rejects(runFreeTurn(state, action, intent, async () => {
    calls++;
    throw new NarratorFailure('GROQ_HTTP_ERROR', 'provider_http', 429);
  }), /GROQ_HTTP_ERROR/);
  assert.equal(calls, 1);
  assert.deepEqual(state, initial);
});

test('Percurso confirmado com linguagem natural preserva presenca, tempo e inventario', async () => {
  const state = createContinuityFixture();
  placeWellEncounter(state);
  const initial = structuredClone(state);
  const steps = [
    ['vou la fora e olho ao redor', familyYard, 2, []],
    ['observo as casas ao redor', familyYard, 1, []],
    ['caminho até o poço', villageWell, 4, ['Lira']],
    ['vou ao poço', villageWell, 0, ['Lira']],
    ['pergunto a Lira se está esperando alguém', villageWell, 5, ['Lira']],
  ] as const;
  let elapsed = 0;
  for (const [action, destination, minutes, present] of steps) {
    const previousLocation = state.campaign.currentLocation;
    await runFreeTurn(state, action, '', async (input) => {
      const context = buildNarratorContext(input);
      assert.equal(input.declaredAction, action);
      assert.equal(context.currentState.location, destination);
      assert.deepEqual(context.currentState.knownPresentNpcs, [...present]);
      return present.length ? 'Lira ergue os olhos e torna a olhar para o poço.' : 'As casas têm telhados baixos.';
    }, async (plan) => {
      assert.equal(state.campaign.currentLocation, previousLocation);
      assert.equal(plan.minutes, minutes);
      return true;
    });
    elapsed += minutes;
    assert.equal(state.campaign.currentLocation, destination);
    assert.equal(state.campaign.worldTime.minute, (initial.campaign.worldTime.minute + elapsed) % 60);
    assert.deepEqual(state.inventory, initial.inventory);
    assert.deepEqual(state.npcs, initial.npcs);
  }
});

test('Interrupcao e transferencia inventada podem ser recusadas antes de qualquer atualizacao', async () => {
  const state = createContinuityFixture();
  const initial = structuredClone(state);
  for (const draft of ['A passagem está bloqueada.', 'Samuel entrega o cantil e promete voltar.']) {
    await assert.rejects(runFreeTurn(state, 'sigo para o quintal', '', async () => draft,
      async (plan, preview) => {
        assert.equal(plan.location, familyYard);
        assert.equal(preview, draft);
        return false;
      }), /TURN_NOT_CONFIRMED/);
    assert.deepEqual(state, initial);
  }
  for (const action of ['vou ao poço ou ao quintal', 'vou ao poço se puder', 'saio pela janela']) {
    const plan = planFreeTurn(familyKitchen, action);
    assert.equal(plan.location, familyKitchen);
    assert.equal(plan.minutes, 0);
    assert.ok(plan.decision);
  }
});

test('Resolve as nove entradas e pede esclarecimento antes de chamar o narrador quando falta o local', async () => {
  const cases = [
    ['faço o que a mãe pediu', familyKitchen, villageWell],
    ['vou la fora e olho ao redor', familyKitchen, familyYard],
    ['subo e arrumo meu quarto', familyKitchen, familyRoom],
    ['vou arrumar meu quarto', familyKitchen, familyRoom],
    ['vou apenas la fora', familyKitchen, familyYard],
    ['vou pegar agua', familyKitchen, null],
    ['vou ao poço pego agua e ja chego em casa', familyKitchen, familyKitchen],
    ['vou la fora apenas', familyKitchen, familyYard],
    ['chego em casa', familyYard, familyKitchen],
  ] as const;
  for (const [action, origin, destination] of cases) {
    const state = createContinuityFixture();
    state.campaign.currentLocation = origin;
    state.narrative.push({ ...state.narrative[0], authorRole: 'engine_response',
      content: 'Teresa pousa a colher. — Se puder levar o balde até o poço e encher o cantil, seria de grande ajuda.' });
    const before = structuredClone(state);
    let calls = 0;
    const result = runFreeTurn(state, action, '', async (input) => {
      calls++;
      assert.equal(input.campaign.currentLocation, destination);
      assert.equal(state.campaign.currentLocation, origin);
      return 'O ar fresco circula de leve.';
    }, undefined, true);
    if (!destination) {
      await assert.rejects(result, FreeTurnClarification);
      assert.deepEqual(state, before);
      assert.equal(calls, 0);
      continue;
    }
    const text = await result;
    assert.equal(calls, 1);
    assert.equal(state.campaign.currentLocation, destination);
    assert.equal(state.narrative.length, before.narrative.length + 2);
    assert.deepEqual(state.inventory, before.inventory);
    assert.doesNotMatch(text, /Lira|missão|promete/i);
    if (destination === familyYard) assert.doesNotMatch(text, /poço/i);
  }
});

test('Recusa em depuracao nao aplica rotina e :sair e um comando exato', async () => {
  const state = createContinuityFixture();
  const before = structuredClone(state);
  await assert.rejects(runFreeTurn(state, 'vou lá fora', '', async () => 'A porta range sob a brisa.',
    async () => false, true), /TURN_NOT_CONFIRMED/);
  assert.deepEqual(state, before);
  assert.equal(shouldEndFreeSession(' :SAIR '), true);
  assert.equal(shouldEndFreeSession('sair'), false);
});

test('Cumprimento e chegadas recebem narração literária com o contexto planejado', async () => {
  const state = createContinuityFixture();
  placeWellEncounter(state);
  const initialInventory = structuredClone(state.inventory);
  const steps = [
    ['BOM dia', familyKitchen, 'Teresa afasta uma caneca da borda. — Bom dia, filho. Quer sentar?'],
    ['vou la fora', familyYard, 'No quintal, a sombra da cerca divide o chão de terra.'],
    ['vou ao poço', villageWell, 'Lira aperta o nó da corda no balde. — Bom dia!'],
  ] as const;
  let calls = 0;
  for (const [action, destination, draft] of steps) {
    const before = state.campaign.currentLocation;
    const text = await runFreeTurn(state, action, '', async (input) => {
      calls++;
      assert.equal(state.campaign.currentLocation, before);
      assert.equal(input.campaign.currentLocation, destination);
      if (destination === villageWell) {
        assert.deepEqual(buildNarratorContext(input).currentState.knownPresentNpcs, ['Lira']);
      }
      return draft;
    }, async (_plan, _narration, source) => {
      assert.equal(source, 'narrated-plan');
      return true;
    }, true);
    assert.equal(text, draft);
    assert.equal(state.campaign.currentLocation, destination);
    assert.deepEqual(state.inventory, initialInventory);
  }
  assert.equal(calls, 3);
});

test('Deslocamento alheio ao plano, presença indevida e compromisso cadeado nao chegam ao historico', async () => {
  for (const draft of [
    'Samuel segue até o poço e conversa com Lira.',
    'Lira está no quintal.',
    'Samuel entrega o cantil e promete voltar.',
    'Samuel diz que ficará até o anoitecer.',
  ]) {
    const state = createContinuityFixture();
    placeWellEncounter(state);
    const inventory = structuredClone(state.inventory);
    let calls = 0;
    const text = await runFreeTurn(state, 'vou lá fora', '', async () => { calls++; return draft; },
      async (_plan, preview, source) => {
        assert.equal(source, 'plan-fallback');
        assert.notEqual(preview, draft);
        return true;
      }, true);
    assert.equal(calls, 1);
    assert.equal(state.campaign.currentLocation, familyYard);
    assert.deepEqual(state.inventory, inventory);
    assert.equal(state.narrative.at(-1)?.content, text);
    assert.equal(state.narrative.some(({ content }) => content === draft), false);
  }
});
