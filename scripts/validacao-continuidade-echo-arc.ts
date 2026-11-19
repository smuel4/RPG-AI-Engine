import dotenv from 'dotenv';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildNarratorContext } from '../server/narratorMemory';
import { generateCampaignNarration } from '../server/narratorService';
import { boundedInteger, buildNarratorPrompt, describeNarratorFailure, NarratorFailure, narratorInstructions, validateNarration, withNarratorDeadline, type NarratorProviderName } from '../server/narratorProvider';
import { advanceContinuity, createContinuityFixture, independentActions, referenceTurns } from './echoArcContinuityFixture';
import { nextGroqAttempt } from './echoArcRateLimit';
import { reviewEchoArcNarration } from './narrativeReview';

type Suite = 'controlled' | 'independent';
type Attempt = {
  status?: number;
  signalAttached?: boolean;
  headersElapsedMs?: number;
  bodyDecodedElapsedMs?: number;
  abortElapsedMs?: number;
  transportFailure?: ReturnType<typeof describeNarratorFailure>;
  parameters: object;
  usage?: Record<string, number>;
  finishReason?: string;
  reportedModel?: string;
  text?: string;
};

const GROQ_MODEL = 'openai/gpt-oss-120b';
const PROBE_SCENE_INTENT = "Nesta conversa cotidiana sobre farinha, responda de forma breve e completa. Dê espaço a Teresa e Henrique para reagirem diretamente um ao outro, com poucos parágrafos e só os detalhes necessários.";
const GEMINI_PROBE_SETTINGS = { GEMINI_RETRY_503: 'false', GEMINI_THINKING_LEVEL: 'MINIMAL', GEMINI_MAX_OUTPUT_TOKENS: '1536' };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const reviewCriteria = ['playerAutonomy', 'storyContinuity', 'dialogueNaturalness', 'npcPersonalityAndInitiative',
  'timeAndEnvironment', 'pacingAndProgression', 'performance'];

async function main() {
  dotenv.config({ quiet: true });
  const args = process.argv.slice(2);
  const option = (name: string) => args.find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1);
  const dryRun = args.includes('--dry-run');
  const geminiMinimal = args.includes('--gemini-minimal');
  const geminiProbe = args.includes('--gemini-probe') || geminiMinimal;
  const groqProbe = args.includes('--groq-probe');
  const probeProvider = geminiProbe ? 'gemini' : groqProbe ? 'groq' : undefined;
  const requestedProvider = option('--provider') ?? probeProvider ?? 'auto';
  const requestedSuite = option('--suite') ?? (probeProvider ? 'controlled' : 'all');
  if (!['auto', 'groq', 'gemini'].includes(requestedProvider) ||
      !['all', 'controlled', 'independent'].includes(requestedSuite) ||
      (geminiProbe && groqProbe) || (geminiMinimal && args.includes('--gemini-probe')) ||
      (probeProvider && (requestedProvider !== probeProvider || requestedSuite !== 'controlled')) ||
      args.some((arg) => !['--dry-run', '--gemini-probe', '--gemini-minimal', '--groq-probe'].includes(arg) && !/^--(provider|suite|output)=.+$/.test(arg))) {
    throw new Error('Use --provider=auto|groq|gemini --suite=all|controlled|independent [--dry-run] [--gemini-probe|--gemini-minimal|--groq-probe] [--output=arquivo.jsonl].');
  }
  const configuredGroq = process.env.GROQ_MODEL?.trim() || GROQ_MODEL;
  const geminiModel = process.env.GEMINI_MODEL?.trim();
  const configured = {
    groq: Boolean(process.env.GROQ_API_KEY?.trim()) && configuredGroq === GROQ_MODEL,
    gemini: Boolean(process.env.GEMINI_API_KEY?.trim() && geminiModel),
  };
  const candidates: NarratorProviderName[] = requestedProvider === 'gemini' ? ['gemini']
    : requestedProvider === 'groq' ? ['groq'] : ['groq', 'gemini'];
  const providers = candidates.filter((name) => configured[name]);
  for (const provider of candidates.filter((name) => !configured[name])) {
    console.log(JSON.stringify({ provider, status: 'skipped', reason: 'Provider or requested model not configured' }));
  }
  if (!dryRun && providers.length === 0) throw new Error('Nenhum provedor elegível com a configuração atual.');
  const suites: Suite[] = requestedSuite === 'all' ? ['controlled', 'independent'] : [requestedSuite as Suite];
  const plannedTurns = providers.length * suites.reduce((sum, suite) => sum +
    (probeProvider ? 1 : suite === 'controlled' ? referenceTurns.length : independentActions.length), 0);
  const promptSha256 = hash(narratorInstructions);
  const retryGemini = !geminiProbe && process.env.GEMINI_RETRY_503 === 'true';
  const output = resolve(option('--output') ?? 'node_modules/.cache/echo-arc-continuity-' +
    new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl');
  const header = {
    type: 'run', director: 'v1.2', scenarioRevision: 'continuity-kitchen-v2',
    promptSha256: geminiMinimal ? undefined : promptSha256,
    plannedTurns, providers, suites, retryGemini, geminiProbe, geminiMinimal, probeProvider, output,
  };
  console.log(JSON.stringify(header));

  function record(value: object) {
    appendFileSync(output, JSON.stringify(value) + '\n', 'utf8');
  }
  if (!dryRun) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(header) + '\n', { encoding: 'utf8', flag: 'wx' });
  }

  const originalFetch = globalThis.fetch;
  let nextGroqAt = 0;
  const failed = new Set<NarratorProviderName>();
  for (const suite of suites) {
    for (const provider of providers.filter((name) => !failed.has(name))) {
      const state = createContinuityFixture();
      const actions = probeProvider ? [referenceTurns[0].action]
        : suite === 'controlled' ? referenceTurns.map(({ action }) => action) : independentActions;
      const model = provider === 'groq' ? GROQ_MODEL : geminiModel!;
      const timeoutMs = provider === 'groq'
        ? boundedInteger(process.env.GROQ_TIMEOUT_MS, 30_000, 1_000, 60_000)
        : boundedInteger(process.env.GEMINI_TIMEOUT_MS, 60_000, 1_000, 60_000);
      for (const [index, declaredAction] of actions.entries()) {
        const sceneIntent = probeProvider ? PROBE_SCENE_INTENT : undefined;
        const input = { ...state, declaredAction, sceneIntent };
        const context = buildNarratorContext(input);
        const userPrompt = buildNarratorPrompt({ declaredAction, context, sceneIntent });
        const minimalContents = 'Responda somente com a palavra OK.';
        const turn = geminiMinimal ? { type: 'probe', provider, model, timeoutMs, contentsSha256: hash(minimalContents) } : {
          type: 'turn', suite, provider, model, turn: index + 1,
          historyMode: suite === 'controlled' ? 'fixed-reference' : 'own-sequence',
          declaredAction, context, sceneIntent, contextSha256: hash(userPrompt), promptSha256, timeoutMs,
        };
        if (dryRun) {
          console.log(JSON.stringify({ ...turn, status: 'planned' }));
          if (suite === 'controlled') advanceContinuity(state, declaredAction, referenceTurns[index].response);
          else break; // Later contexts in independent mode require actual earlier turns.
          continue;
        }

        if (provider === 'groq') {
          const wait = Math.max(0, nextGroqAt - Date.now());
          if (wait > 60_000) {
            record({ ...turn, status: 'paused', retryAt: new Date(nextGroqAt).toISOString() });
            console.log(JSON.stringify({ provider, suite, status: 'paused', retryAt: new Date(nextGroqAt).toISOString() }));
            failed.add(provider);
            break;
          }
          await sleep(wait);
        }

        const attempts: Attempt[] = [];
        const pendingTelemetry: Promise<void>[] = [];
        globalThis.fetch = async (request, init) => {
          const url = new URL(request instanceof Request ? request.url : String(request));
          const allowed = provider === 'groq'
            ? url.origin === 'https://api.groq.com' && url.pathname === '/openai/v1/chat/completions'
            : url.origin === 'https://generativelanguage.googleapis.com' && url.pathname.endsWith(':generateContent');
          if (!allowed) throw new Error('Destino proibido nesta avaliação.');
          const body = JSON.parse(typeof init?.body === 'string' ? init.body :
            request instanceof Request ? await request.clone().text() : '{}');
          const parameters = provider === 'groq'
            ? { temperature: body.temperature, maxOutputTokens: body.max_completion_tokens, reasoningEffort: body.reasoning_effort, timeoutMs }
            : { temperature: body.generationConfig?.temperature, maxOutputTokens: body.generationConfig?.maxOutputTokens,
              thinkingConfig: body.generationConfig?.thinkingConfig, retry503: retryGemini, automaticContinuation: false, timeoutMs };
          if (probeProvider && attempts.length) throw new Error('Limite de uma chamada do diagnóstico.');
          const requestStart = performance.now();
          const elapsed = () => Math.round(performance.now() - requestStart);
          const signal = init?.signal ?? (request instanceof Request ? request.signal : undefined);
          const attempt: Attempt = { parameters, signalAttached: Boolean(signal) };
          attempts.push(attempt);
          const trackAbort = () => { attempt.abortElapsedMs = elapsed(); };
          if (signal?.aborted) trackAbort();
          else signal?.addEventListener('abort', trackAbort, { once: true });
          let response: Response;
          try {
            response = await originalFetch(request, probeProvider ? { ...init, redirect: 'error' } : init);
          } catch (error) {
            attempt.transportFailure = describeNarratorFailure(error, provider, signal);
            throw error;
          }
          attempt.status = response.status;
          attempt.headersElapsedMs = elapsed();
          if (provider === 'groq') {
            nextGroqAt = nextGroqAttempt(response.headers, response.status, Date.now(), body.max_completion_tokens ?? 1000);
          }
          if (response.ok) {
            pendingTelemetry.push(response.clone().json().then((json) => {
              attempt.bodyDecodedElapsedMs = elapsed();
              const reportedModel = provider === 'groq' ? json.model : json.modelVersion;
              if (typeof reportedModel === 'string' && /^[a-zA-Z0-9_./:-]{1,100}$/.test(reportedModel)) {
                attempt.reportedModel = reportedModel;
              }
              const usage = provider === 'groq' ? json.usage : json.usageMetadata;
              if (usage) attempt.usage = Object.fromEntries(Object.entries(usage)
                .filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
              const choice = provider === 'groq' ? json.choices?.[0] : json.candidates?.[0];
              attempt.finishReason = provider === 'groq' ? choice?.finish_reason : choice?.finishReason;
              attempt.text = provider === 'groq' ? choice?.message?.content : choice?.content?.parts
                ?.filter((part: { thought?: boolean }) => !part.thought)
                .map((part: { text?: string }) => part.text ?? '').join('');
            }).catch(() => { /* Provider validation still handles invalid bodies. */ }));
          }
          return response;
        };

        const started = performance.now();
        let narration: string | undefined;
        let failure;
        const previousSettings = geminiProbe ? Object.entries(GEMINI_PROBE_SETTINGS).map(([name, value]) => {
          const previous = process.env[name];
          process.env[name] = value;
          return [name, previous] as const;
        }) : [];
        try {
          if (geminiMinimal) {
            const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
            const response = await withNarratorDeadline(timeoutMs, (abortSignal) => ai.models.generateContent({
              model, contents: minimalContents,
              config: {
                abortSignal, automaticContinuation: false, temperature: 0.8, maxOutputTokens: 1536,
                ...(model === 'gemini-3.6-flash' || model === 'models/gemini-3.6-flash'
                  ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } } : {}),
              },
            }));
            if (response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
              throw new NarratorFailure('GEMINI_MAX_TOKENS', 'response');
            }
            narration = validateNarration(response.text, 'gemini');
          } else {
            narration = await generateCampaignNarration(input, provider);
          }
        } catch (error) {
          failure = describeNarratorFailure(error, provider);
        } finally {
          globalThis.fetch = originalFetch;
          for (const [name, previous] of previousSettings) {
            if (previous === undefined) delete process.env[name];
            else process.env[name] = previous;
          }
        }
        const latencyMs = Math.round(performance.now() - started);
        await Promise.all(pendingTelemetry);
        const text = narration ?? attempts.at(-1)?.text;
        const finishReason = attempts.at(-1)?.finishReason;
        const truncated = finishReason === 'MAX_TOKENS' || finishReason === 'length';
        const finished = Boolean(narration) || finishReason?.toLowerCase() === 'stop';
        const completionStatus = truncated ? 'truncated' : finished ? 'complete' : 'failed';
        record({ ...turn, status: failure ? 'failed' : 'generated', attempts, latencyMs, text, failure,
          retryAt: provider === 'groq' && attempts.at(-1)?.status === 429 ? new Date(nextGroqAt).toISOString() : undefined,
          completionStatus, formatValid: Boolean(narration) && !truncated, screeningFlags: text ? reviewEchoArcNarration(text) : [],
          literaryReview: 'pending', reviewCriteria });
        console.log(JSON.stringify({ provider, suite, turn: index + 1, latencyMs, status: failure?.code ?? 'generated' }));
        if (geminiMinimal) {
          if (failure || truncated || !narration) failed.add(provider);
          break;
        }
        if (failure || !narration) {
          failed.add(provider);
          break;
        }
        advanceContinuity(state, declaredAction, suite === 'controlled' ? referenceTurns[index].response : narration);
      }
    }
  }
  if (failed.size) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Falha no executor de avaliação.');
  process.exitCode = 1;
});
