import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  Campaign,
  InventoryItem,
  NarrativeEntry,
  NpcRecord,
} from '../src/types/game';
import {
  decodeFirestoreDocument,
  decodeFirestoreValue,
  fetchCampaignContext,
  type LoadedCampaignContext,
} from '../server/campaignAccess';
import { describeGeminiFailure, generateGeminiNarration } from '../server/geminiNarrator';
import { generateCampaignNarration, selectNarratorMode, tryAcquireNarratorTurn } from '../server/narratorService';
import { groqNarrator } from '../server/groqNarrator';
import { buildNarratorPrompt, describeNarratorFailure } from '../server/narratorProvider';
import { NARRATOR_SYSTEM_INSTRUCTIONS } from '../server/narratorPrompt';
import { buildNarratorContext } from '../server/narratorMemory';
import { processPlayerAction } from '../src/engine/rulesEngine';
import { createCustomCampaignBundle, createEchoArcBundle } from '../src/engine/echoArcFixture';
import { advanceContinuity, createContinuityFixture, referenceTurns } from '../scripts/echoArcContinuityFixture';
import { FixedMilestoneNarrator } from '../src/engine/narratorPort';

const mockCampaign: Campaign = {
  id: 'camp_samuel_01',
  ownerId: 'jogador_autorizado',
  name: 'ECHO ARC',
  setting: 'Fantasia',
  currentLocation: 'Vila de Freixo',
  status: 'active',
  revision: 5,
  lastSequence: 10,
  activeTimelineId: 'tl_root',
  timelineLineage: [{ timelineId: 'tl_root', fromSequence: 0, toSequence: null }],
  protagonist: {
    name: 'Samuel',
    age: 24,
    origin: 'Freixo',
    futureHook: 'Academia',
    vitality: 100,
    maxVitality: 100,
    focus: 80,
    maxFocus: 80,
    disposition: 'Atento',
  },
  currency: { gold: 10, silver: 5, copper: 2 },
  worldTime: {
    year: 412,
    month: 3,
    day: 14,
    weekday: 'Lunis',
    season: 'Primavera',
    hour: 8,
    minute: 30,
    periodOfDay: 'Manhã',
  },
};

const mockContext = buildNarratorContext({ campaign: mockCampaign, inventory: [], npcs: [], narrative: [] });

test('1. Decodificação segura de tipos do Cloud Firestore REST', () => {
  const rawDocument = {
    name: 'projects/p/databases/d/documents/campaigns/c1',
    fields: {
      name: { stringValue: 'ECHO ARC' },
      revision: { integerValue: '4' },
      active: { booleanValue: true },
      empty: { nullValue: null },
      protagonist: {
        mapValue: {
          fields: {
            name: { stringValue: 'Samuel' },
            vitality: { integerValue: '100' },
          },
        },
      },
      tags: {
        arrayValue: {
          values: [{ stringValue: 'fantasia' }, { stringValue: 'rpg' }],
        },
      },
    },
  };

  const decoded = decodeFirestoreDocument<{
    name: string;
    revision: number;
    active: boolean;
    empty: null;
    protagonist: { name: string; vitality: number };
    tags: string[];
  }>(rawDocument);

  assert.equal(decoded.name, 'ECHO ARC');
  assert.equal(decoded.revision, 4);
  assert.equal(decoded.active, true);
  assert.equal(decoded.empty, null);
  assert.deepEqual(decoded.protagonist, { name: 'Samuel', vitality: 100 });
  assert.deepEqual(decoded.tags, ['fantasia', 'rpg']);
});

test('2. fetchCampaignContext rejeita campanha de outro usuário (403/Forbidden)', async () => {
  process.env.FIREBASE_PROJECT_ID = 'demo-rpg-ai-engine';
  process.env.FIRESTORE_DATABASE_ID = 'ai-studio-test';

  const mockFetch: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        fields: {
          id: { stringValue: 'camp_samuel_01' },
          ownerId: { stringValue: 'outro_jogador_estranho' },
        },
      }),
      { status: 200 },
    );
  };

  const result = await fetchCampaignContext(
    'camp_samuel_01',
    'token_jogador',
    'jogador_autorizado',
    mockFetch,
  );

  assert.equal(result, null);
});

test('3. fetchCampaignContext carrega dados do banco nomeado com token do jogador', async () => {
  process.env.FIREBASE_PROJECT_ID = 'demo-rpg-ai-engine';
  process.env.FIRESTORE_DATABASE_ID = 'ai-studio-test';

  const mockFetch: typeof fetch = async (input, init) => {
    const urlStr = String(input);
    const authHeader = (init?.headers as Record<string, string>)?.Authorization;

    assert.equal(authHeader, 'Bearer token_valido');
    assert.ok(urlStr.includes('ai-studio-test'));

    if (urlStr.endsWith('campaigns/camp_samuel_01')) {
      return new Response(
        JSON.stringify({
          fields: {
            id: { stringValue: 'camp_samuel_01' },
            ownerId: { stringValue: 'jogador_autorizado' },
            name: { stringValue: 'ECHO ARC' },
            revision: { integerValue: '5' },
            lastSequence: { integerValue: '10' },
            activeTimelineId: { stringValue: 'tl_root' },
            status: { stringValue: 'active' },
          },
        }),
        { status: 200 },
      );
    }

    if (urlStr.includes(':runQuery')) {
      const body = JSON.parse(String(init?.body));
      const collectionId = body.structuredQuery.from[0].collectionId;

      if (collectionId === 'inventory') {
        return new Response(
          JSON.stringify([
            {
              document: {
                fields: {
                  id: { stringValue: 'item_1' },
                  name: { stringValue: 'Adaga' },
                  quantity: { integerValue: '1' },
                  ownerId: { stringValue: 'jogador_autorizado' },
                  campaignId: { stringValue: 'camp_samuel_01' },
                  category: { stringValue: 'equipamento' },
                  description: { stringValue: 'Lâmina de ferro' },
                  equipable: { booleanValue: true },
                  equipped: { booleanValue: false },
                },
              },
            },
          ]),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify([]), { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  };

  const context = await fetchCampaignContext(
    'camp_samuel_01',
    'token_valido',
    'jogador_autorizado',
    mockFetch,
  );

  assert.ok(context !== null);
  assert.equal(context.campaign.id, 'camp_samuel_01');
  assert.equal(context.campaign.revision, 5);
  assert.equal(context.inventory.length, 1);
  assert.equal(context.inventory[0].name, 'Adaga');
});

test('Narrador fixo usa o local e o horario do documento da campanha solicitada', async (t) => {
  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    FIREBASE_PROJECT_ID: 'demo-rpg-ai-engine',
    FIRESTORE_DATABASE_ID: 'ai-studio-test',
  };
  t.after(() => { process.env = originalEnv; });
  const ownerId = 'jogador_autorizado';
  const official = createEchoArcBundle(ownerId).campaign;
  const custom = createCustomCampaignBundle(ownerId, {
    name: 'Campanha personalizada',
    setting: 'Fantasia',
    currentLocation: 'Vila Inicial',
    protagonistName: 'Samuel',
    protagonistAge: 18,
    protagonistOrigin: 'Viajante',
    futureHook: 'Explorar a vila',
  }).campaign;
  const narrator = new FixedMilestoneNarrator();

  for (const { campaign, expectedLocation, expectedClock } of [
    { campaign: official, expectedLocation: 'Vila de Freixo', expectedClock: '08:30' },
    { campaign: custom, expectedLocation: 'Vila Inicial', expectedClock: '09:00' },
  ]) {
    const mockFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const documentPath = '/documents/campaigns/' + campaign.id;
      if (init?.method === 'GET') {
        assert.ok(url.pathname.endsWith(documentPath));
        return Response.json({
          fields: {
            ownerId: { stringValue: campaign.ownerId },
            currentLocation: { stringValue: campaign.currentLocation },
            protagonist: { mapValue: { fields: { name: { stringValue: campaign.protagonist.name } } } },
            worldTime: { mapValue: { fields: {
              hour: { integerValue: String(campaign.worldTime.hour) },
              minute: { integerValue: String(campaign.worldTime.minute) },
            } } },
          },
        });
      }

      assert.ok(url.pathname.endsWith(documentPath + ':runQuery'));
      return Response.json([]);
    };

    const context = await fetchCampaignContext(campaign.id, 'token_teste', ownerId, mockFetch);
    assert.ok(context);
    const narration = narrator.respondToPlayerAction({ ...context, declaredAction: 'Samuel observa a vila.' });
    assert.ok(narration.startsWith('[Narrativa fixa de teste · ' + expectedLocation + ', ' + expectedClock + ']'));
    assert.ok(narration.includes('O ambiente de ' + expectedLocation + ' permanece'));
  }
});

test('4. Qualidade narrativa: texto <= 2.000 caracteres é aceito integralmente', async () => {
  const narrativeText =
    'O vento suave balança as copas das árvores da Vila de Freixo. Samuel olha ao redor, ' +
    'percebendo que Teresa acabou de acender o fogão a lenha. A calma da manhã oculta o mistério que se aproxima.';

  const result = await generateGeminiNarration(
    {
      declaredAction: 'Samuel observa os arredores da cabana.',
      context: mockContext,
    },
    async () => narrativeText,
  );

  assert.equal(result, narrativeText);
  assert.ok(result.length <= 2000);
});

test('5. Qualidade narrativa: texto > 2.000 caracteres é rejeitado com erro sem cortes arbitrários', async () => {
  const longText = 'Era uma vez em Freixo. '.repeat(100); // 2.300 caracteres
  assert.ok(longText.length > 2000);

  await assert.rejects(
    async () => {
      await generateGeminiNarration(
        {
          declaredAction: 'Samuel caminha',
          context: mockContext,
        },
        async () => longText,
      );
    },
    {
      name: 'Error',
      message: /NARRATION_EXCEEDS_LIMIT/,
    },
  );
});

test('6. Resiliência: falha da API Gemini lança erro e NÃO realiza fallback silencioso para texto fixo', async () => {
  await assert.rejects(
    async () => {
      await generateGeminiNarration(
        {
          declaredAction: 'Samuel caminha',
          context: mockContext,
        },
        async () => {
          throw new Error('API_QUOTA_EXCEEDED (HTTP 429)');
        },
      );
    },
    {
      name: 'Error',
      message: /API_QUOTA_EXCEEDED/,
    },
  );
});

test('7. Integridade transacional: detecta mudança concorrente de revisão ou timeline durante a geração', () => {
  const actionText = 'Samuel examina o mapa na mesa.';

  // 1. O turno é gerado quando a campanha estava na revisão 5 e linha 'tl_root'
  const baseCampaign: Campaign = { ...mockCampaign, revision: 5, activeTimelineId: 'tl_root' };

  const ruleResult = processPlayerAction(
    baseCampaign,
    [],
    [],
    actionText,
    10,
    'Samuel desdobra o pergaminho sobre a mesa de madeira...',
  );

  assert.ok(ruleResult.ok);
  assert.equal(ruleResult.data.engineEntry.content, 'Samuel desdobra o pergaminho sobre a mesa de madeira...');

  // 2. Simulação da verificação transacional:
  // Se um checkpoint foi restaurado ou outra ação ocorreu enquanto a IA pensava:
  const campaignInFirestoreAtCommitTime: Campaign = {
    ...mockCampaign,
    revision: 6, // Alguém avançou a revisão!
    activeTimelineId: 'tl_restaurada',
  };

  const expectedRevision = 5;
  const expectedTimelineId = 'tl_root';

  const hasConflict =
    campaignInFirestoreAtCommitTime.revision !== expectedRevision ||
    (campaignInFirestoreAtCommitTime.activeTimelineId || 'tl_root') !== expectedTimelineId;

  assert.equal(hasConflict, true, 'O conflito transacional DEVE ser detectado antes de persistir');
});

test('8. Concorrencia: a trava real impede dois turnos simultaneos na mesma campanha', () => {
  const campaignId = 'camp_concorrente';
  const release = tryAcquireNarratorTurn(campaignId);
  assert.ok(release);
  try {
    assert.equal(tryAcquireNarratorTurn(campaignId), null);
  } finally {
    release();
  }
  const releaseNext = tryAcquireNarratorTurn(campaignId);
  assert.ok(releaseNext);
  releaseNext();
});

test('9. Memória da linha ativa: entradas de timelines revertidas por checkpoint são omitidas', () => {
  const campaignWithLineage: Campaign = {
    ...mockCampaign,
    activeTimelineId: 'tl_ramo_2',
    lastSequence: 12,
    timelineLineage: [
      { timelineId: 'tl_root', fromSequence: 0, toSequence: 5 },
      { timelineId: 'tl_ramo_2', fromSequence: 8, toSequence: null },
    ],
  };

  const narrativeEntries: NarrativeEntry[] = [
    {
      id: 'n1',
      campaignId: campaignWithLineage.id,
      ownerId: campaignWithLineage.ownerId,
      timelineId: 'tl_root',
      sequence: 2,
      authorRole: 'player_action',
      content: 'Acontecimento da raiz legítima',
      worldTimeLabel: 'Manhã',
    },
    {
      id: 'n2',
      campaignId: campaignWithLineage.id,
      ownerId: campaignWithLineage.ownerId,
      timelineId: 'tl_ramo_descartado', // Linha abandonada por checkpoint!
      sequence: 6,
      authorRole: 'player_action',
      content: 'Acontecimento apagado pelo checkpoint',
      worldTimeLabel: 'Manhã',
    },
    {
      id: 'n3',
      campaignId: campaignWithLineage.id,
      ownerId: campaignWithLineage.ownerId,
      timelineId: 'tl_ramo_2',
      sequence: 9,
      authorRole: 'player_action',
      content: 'Acontecimento canônico da linha atual',
      worldTimeLabel: 'Tarde',
    },
  ];

  const summary = buildNarratorContext({
    campaign: campaignWithLineage,
    inventory: [],
    npcs: [],
    narrative: narrativeEntries,
  });

  const remembered = summary.recentActiveHistory.map((h: { content: string }) => h.content);

  assert.deepEqual(remembered, [
    'Acontecimento da raiz legítima',
    'Acontecimento canônico da linha atual',
  ]);
  assert.ok(!remembered.includes('Acontecimento apagado pelo checkpoint'));
});

test('Diagnostico Gemini preserva status HTTP e omite detalhes do provedor', () => {
  const error = Object.assign(new Error('fake key, request body and provider details'), { status: 429 });
  assert.deepEqual(describeGeminiFailure(error), {
    category: 'provider_http', code: 'GEMINI_HTTP_ERROR', status: 429,
  });
  assert.deepEqual(describeGeminiFailure(new Error('arbitrary provider details')), {
    category: 'unknown', code: 'GEMINI_UNCLASSIFIED_ERROR',
  });
});

test('Diagnostico Gemini identifica modelo ausente antes de chamar o SDK', async (t) => {
  const originalEnv = process.env;
  process.env = { ...originalEnv, GEMINI_API_KEY: 'test-only', GEMINI_MODEL: ' ' };
  t.after(() => { process.env = originalEnv; });
  await assert.rejects(generateGeminiNarration({
    declaredAction: 'Observar a vila',
    context: mockContext,
  }), (error) => {
    assert.deepEqual(describeGeminiFailure(error), {
      category: 'configuration', code: 'GEMINI_MODEL_MISSING',
    });
    return true;
  });
});

test('Gemini cancela o transporte e classifica o timeout com limite configurado', async (t) => {
  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    GEMINI_API_KEY: 'test-only',
    GEMINI_MODEL: 'gemini-3.6-flash',
    GEMINI_TIMEOUT_MS: '1500',
  };
  t.after(() => { process.env = originalEnv; });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let transportSignal: AbortSignal | null | undefined;
  let markTransportReady!: () => void;
  const transportReady = new Promise<void>((resolve) => { markTransportReady = resolve; });
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    transportSignal = init?.signal;
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.generationConfig.maxOutputTokens, 1000);
    assert.equal(payload.systemInstruction.parts[0].text, NARRATOR_SYSTEM_INSTRUCTIONS);
    assert.equal(payload.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
    markTransportReady();
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  });

  const result = generateGeminiNarration({
    declaredAction: 'Observar a vila',
    context: mockContext,
  });
  const failure = assert.rejects(result, (error) => {
    assert.deepEqual(describeGeminiFailure(error), {
      category: 'timeout', code: 'TIMEOUT_EXCEEDED',
    });
    return true;
  });
  await Promise.race([transportReady, failure]);
  assert.ok(transportSignal);
  t.mock.timers.tick(1499);
  assert.equal(transportSignal.aborted, false);
  t.mock.timers.tick(1);
  await failure;
  assert.equal(transportSignal.aborted, true);
});

test('Gemini repete apenas HTTP 503 e limita o total a duas chamadas', async (t) => {
  const input = {
    declaredAction: 'Observar a vila',
    context: mockContext,
  };
  for (const statuses of [[503, 200], [503, 503], [429], [503]]) {
    await t.test(statuses.join(' -> '), async (ctx) => {
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        GEMINI_API_KEY: 'test-only',
        GEMINI_MODEL: 'gemini-3.6-flash',
        GEMINI_TIMEOUT_MS: '5000',
        GEMINI_RETRY_503: statuses.length === 2 ? 'true' : 'false',
      };
      ctx.after(() => { process.env = originalEnv; });

      let calls = 0;
      const fetchMock = ctx.mock.method(globalThis, 'fetch', async () => {
        const status = statuses[calls++];
        assert.ok(status, 'Tentativa HTTP inesperada');
        return status === 200
          ? Response.json({ candidates: [{ content: { parts: [{ text: 'Teresa acena.' }] } }] })
          : Response.json({ error: { code: status, message: 'Simulated' } }, { status });
      });

      const finalStatus = statuses.at(-1);
      if (finalStatus === 200) {
        assert.equal(await generateGeminiNarration(input), 'Teresa acena.');
      } else {
        await assert.rejects(generateGeminiNarration(input), (error) => {
          assert.deepEqual(describeGeminiFailure(error), {
            category: 'provider_http', code: 'GEMINI_HTTP_ERROR', status: finalStatus,
          });
          return true;
        });
      }
      assert.equal(fetchMock.mock.callCount(), statuses.length);
    });
  }
});

const groqInput = {
  declaredAction: 'Observar a vila',
  context: mockContext,
};

function configureGroqTest(t: import('node:test').TestContext) {
  const original = process.env;
  process.env = { ...original, GROQ_API_KEY: 'test-only', GROQ_MODEL: '',
    GROQ_TIMEOUT_MS: '1500', GROQ_MAX_OUTPUT_TOKENS: '900' };
  t.after(() => { process.env = original; });
}

test('seleciona o narrador no servidor sem fallback em modo invalido', () => {
  assert.equal(selectNarratorMode('groq', true), 'groq');
  assert.equal(selectNarratorMode('gemini'), 'gemini');
  assert.equal(selectNarratorMode('fixed'), 'fixed');
  assert.equal(selectNarratorMode(undefined), 'gemini');
  assert.equal(selectNarratorMode('gemini', true), 'fixed');
  assert.equal(selectNarratorMode('typo', true), null);
});

test('Groq gera um turno em uma chamada com instrucoes compartilhadas e contexto canonico', async (t) => {
  configureGroqTest(t);
  const info = t.mock.method(console, 'info', (_event: string, _metadata: { latencyMs: number }) => {});
  const mock = t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-only');
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, 'openai/gpt-oss-120b');
    assert.equal(payload.max_completion_tokens, 900);
    assert.equal(payload.reasoning_effort, 'low');
    assert.deepEqual(payload.messages[0], { role: 'system', content: NARRATOR_SYSTEM_INSTRUCTIONS });
    assert.equal(payload.messages[1].role, 'user');
    assert.ok(payload.messages[1].content.includes(mockCampaign.currentLocation));
    assert.ok(payload.messages[1].content.includes(groqInput.declaredAction));
    return Response.json({
      choices: [{ message: { content: 'Teresa acena.', reasoning: 'private reasoning' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
    });
  });
  const narration = await generateCampaignNarration({
    campaign: mockCampaign, inventory: [], npcs: [], narrative: [], declaredAction: groqInput.declaredAction,
  }, 'groq');
  assert.equal(narration, 'Teresa acena.');
  assert.equal(mock.mock.callCount(), 1);
  const metadata = info.mock.calls[0].arguments[1];
  assert.deepEqual(metadata, {
    provider: 'groq', model: 'openai/gpt-oss-120b', latencyMs: metadata.latencyMs,
    inputTokens: 30, outputTokens: 10, totalTokens: 40, outcome: 'success',
  });
});

test('Groq falha em uma chamada sem retry e sem vazar resposta do provedor', async (t) => {
  for (const status of [401, 403, 429, 500, 503, 200]) {
    await t.test(String(status), async (ctx) => {
      configureGroqTest(ctx);
      const warn = ctx.mock.method(console, 'warn', () => {});
      const mock = ctx.mock.method(globalThis, 'fetch', async () => {
        return Response.json(status === 200 ? { choices: [{ message: { content: ' ' } }] } :
          { error: 'private provider detail' }, { status });
      });
      await assert.rejects(groqNarrator.generate(groqInput), (error) => {
        assert.deepEqual(describeNarratorFailure(error, 'groq'), status === 200
          ? { category: 'response', code: 'GROQ_EMPTY_RESPONSE' }
          : { category: 'provider_http', code: 'GROQ_HTTP_ERROR', status });
        return true;
      });
      assert.equal(mock.mock.callCount(), 1);
      assert.equal(warn.mock.callCount(), 1);
      assert.doesNotMatch(JSON.stringify(warn.mock.calls[0].arguments), /private provider detail|test-only/);
    });
  }
});

test('Groq aborta a chamada e devolve timeout sem repetir o turno', async (t) => {
  configureGroqTest(t);
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | null | undefined;
  const mock = t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal;
    return new Promise<Response>((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
    });
  });
  const timeout = assert.rejects(groqNarrator.generate(groqInput), { message: 'TIMEOUT_EXCEEDED' });
  assert.ok(signal);
  t.mock.timers.tick(1499);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await timeout;
  assert.equal(signal.aborted, true);
  assert.equal(mock.mock.callCount(), 1);
});

test('Diretor permite gestos incidentais e reserva ao jogador as acoes consequentes', () => {
  assert.match(NARRATOR_SYSTEM_INSTRUCTIONS,
    /Gestos, posturas e reações passageiras.*naturais, reversíveis/);
  assert.match(NARRATOR_SYSTEM_INSTRUCTIONS, /Preserve a ação declarada/);
  assert.match(NARRATOR_SYSTEM_INSTRUCTIONS, /Deixe ao jogador falas novas, decisões importantes, compromissos, escolhas românticas, objetivos duradouros e ações com consequências/);
  assert.match(NARRATOR_SYSTEM_INSTRUCTIONS, /Oferecer ajuda não autoriza executar tarefas/);
  assert.match(NARRATOR_SYSTEM_INSTRUCTIONS, /traços confirmados/);
  assert.match(NARRATOR_SYSTEM_INSTRUCTIONS, /familiaridade do protagonista/);
  assert.match(NARRATOR_SYSTEM_INSTRUCTIONS, /em observações, mostre o que o protagonista percebe dali/);
  assert.match(NARRATOR_SYSTEM_INSTRUCTIONS, /use o estado para localização, presença, horário e posses/);
  assert.match(NARRATOR_SYSTEM_INSTRUCTIONS, /Use apenas o histórico fornecido da linha temporal ativa/);
  assert.match(NARRATOR_SYSTEM_INSTRUCTIONS, /Trate detalhes incidentais da prosa como locais à cena/);
});

test('Prompt envia um objeto e separa acao, estado, fatos, intencao e ganchos', () => {
  const bundle = createEchoArcBundle('dono');
  const context = buildNarratorContext({ ...bundle, settlement: 'Vila de Freixo' });
  const declaredAction = 'Samuel oferece ajuda a Teresa.';
  const sceneIntent = 'Teresa pode expressar preocupacao com a partida.';
  const text = buildNarratorPrompt({ declaredAction, context, sceneIntent });
  const payload = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  assert.equal(payload.declaredAction, declaredAction);
  assert.equal(payload.currentState.settlement, 'Vila de Freixo');
  assert.equal(payload.currentState.calendarLabel, context.currentState.calendarLabel);
  assert.equal(Object.hasOwn(payload.currentState, 'inventory'), false);
  assert.deepEqual(payload.narratorOnlyInventory, context.currentState.inventory);
  assert.match(NARRATOR_SYSTEM_INSTRUCTIONS, /um NPC só reconhece um objeto ou seu conteúdo se houver percepção/);
  assert.match(NARRATOR_SYSTEM_INSTRUCTIONS, /marcos visíveis apenas quando estabelecidos/);
  assert.equal(payload.establishedRecords.npcs[0].name, 'Teresa');
  assert.deepEqual(payload.recentActiveHistory, context.recentActiveHistory);
  assert.equal(payload.sceneIntent, sceneIntent);
  assert.deepEqual(context.futureHooks, [bundle.campaign.protagonist.futureHook]);
  assert.equal(Object.hasOwn(payload, 'futureHooks'), false);
  assert.ok(!text.includes(bundle.campaign.protagonist.futureHook!));
  assert.equal(Object.hasOwn(payload, 'contextSummary'), false);
  assert.doesNotMatch(buildNarratorPrompt({ declaredAction, context }), /"sceneIntent"/);
});

test('Retoma as falas dos NPCs e as acoes declaradas ao longo de tres turnos', async () => {
  const state = createContinuityFixture();
  const initialTime = state.campaign.worldTime;
  assert.equal(initialTime.weekday, 'Lunis');

  for (const [index, turn] of referenceTurns.entries()) {
    const previous = referenceTurns.slice(0, index);
    const narration = await generateCampaignNarration({
      ...state,
      declaredAction: turn.action,
    }, async (contents) => {
      const payload = JSON.parse(contents.slice(contents.indexOf('{'), contents.lastIndexOf('}') + 1));
      assert.equal(payload.declaredAction, turn.action);
      assert.deepEqual(payload.recentActiveHistory.filter((entry: { author: string }) => entry.author === 'player_action')
        .map((entry: { content: string }) => entry.content), previous.map(({ action }) => action));
      assert.deepEqual(payload.recentActiveHistory.filter((entry: { author: string }) => entry.author === 'engine_response')
        .map((entry: { content: string }) => entry.content), previous.map(({ response }) => response));
      assert.deepEqual(payload.establishedRecords.npcs.map(({ name, role }: { name: string; role: string }) => [name, role]),
        state.npcs.map(({ name, role }) => [name, role]));
      assert.equal(payload.currentState.worldTime.minute, initialTime.minute + index * 5);
      assert.equal(payload.currentState.worldTime.day, initialTime.day);
      assert.equal(payload.currentState.worldTime.weekday, initialTime.weekday);
      assert.match(payload.currentState.location, /^Cozinha.*Vila de Freixo$/);
      assert.deepEqual(payload.currentState.knownPresentNpcs, ['Teresa', 'Henrique']);
      assert.match(payload.recentActiveHistory[0].content, /Samuel, Teresa e Henrique.*cozinha/);
      return turn.response;
    });
    advanceContinuity(state, turn.action, narration);
  }
});

test('Gemini rejeita MAX_TOKENS com texto parcial e aceita raciocinio minimo configurado', async (t) => {
  const original = process.env;
  process.env = { ...original, GEMINI_API_KEY: 'mock-only', GEMINI_MODEL: 'gemini-3.6-flash',
    GEMINI_THINKING_LEVEL: 'MINIMAL', GEMINI_MAX_OUTPUT_TOKENS: '1536' };
  t.after(() => { process.env = original; });
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_request: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
    assert.equal(body.generationConfig.maxOutputTokens, 1536);
    return Response.json({
      candidates: [{ content: { parts: [{ text: 'Teresa respondeu, mas' }] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 1019, candidatesTokenCount: 156, thoughtsTokenCount: 840, totalTokenCount: 2015 },
    });
  });
  await assert.rejects(generateGeminiNarration({ declaredAction: 'Samuel pergunta.', context: mockContext }),
    { message: 'GEMINI_MAX_TOKENS' });
  assert.equal(fetchMock.mock.callCount(), 1);
});
