import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildNarratorContext, type NarratorContext } from '../server/narratorMemory';
import { describeNarratorFailure, narratorInstructions } from '../server/narratorProvider';
import { generateCampaignNarration } from '../server/narratorService';
import { createContinuityFixture } from './echoArcContinuityFixture';
import { FreeTurnClarification, placeWellEncounter, resumeFreeAction, runFreeTurn, shouldEndFreeSession, type FreeTurnPlan } from './echoArcFreeTurn';
import { reviewEchoArcNarration } from './narrativeReview';

const model = 'openai/gpt-oss-120b';
const opening = 'É de manhã. Samuel, Teresa e Henrique estão na cozinha da casa da família, na Vila de Freixo.';

async function main() {
  const debug = process.argv.includes('--debug');
  const args = process.argv.slice(2).filter((arg) => arg !== '--debug');
  if (args.length > 1 || (args.length && !/^--turns=[345]$/.test(args[0]))) {
    throw new Error('Use --turns=3, --turns=4 ou --turns=5, com --debug se desejar confirmar todos os turnos.');
  }
  const limit = Number(args[0]?.at(-1) ?? 3);
  dotenv.config({ quiet: true });
  if (!process.env.GROQ_API_KEY?.trim() || (process.env.GROQ_MODEL?.trim() || model) !== model) {
    throw new Error('A sessão requer a configuração Groq existente para openai/gpt-oss-120b.');
  }

  const state = createContinuityFixture();
  placeWellEncounter(state);
  state.narrative[0] = { ...state.narrative[0], content: opening };
  const directory = resolve('node_modules/.cache');
  const output = resolve(directory, 'echo-arc-free-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl');
  mkdirSync(directory, { recursive: true });
  const promptSha256 = createHash('sha256').update(narratorInstructions).digest('hex');
  writeFileSync(output, JSON.stringify({ type: 'run', director: 'v1.2', direction: 'narrated-plan',
    promptSha256, model, limit, opening, debug }) + '\n', { flag: 'wx' });
  const record = (entry: object) => appendFileSync(output, JSON.stringify(entry) + '\n', 'utf8');
  console.log(opening + '\nDigite a fala ou ação de Samuel. Use :sair para encerrar.\nRegistro: ' + output);

  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let nextAllowedAt = 0;
  let clarification: FreeTurnClarification | undefined;
  try {
    for (let turn = 1; turn <= limit;) {
      const answer = (await terminal.question('\nSamuel > ')).trim();
      if (shouldEndFreeSession(answer)) break;
      const declaredAction = resumeFreeAction(answer, clarification);
      clarification = undefined;
      if (!declaredAction) continue;
      if (declaredAction.length > 800) {
        console.log('A ação pode ter até 800 caracteres.');
        continue;
      }
      let context: NarratorContext | undefined;
      let sceneIntent: string | undefined;
      const start = performance.now();
      let attempts = 0;
      const timing = { generationAttemptsMs: [] as number[], throttleWaitMs: 0, reviewWaitMs: 0 };
      let narration: string;
      let exitRequested = false;
      let plan: FreeTurnPlan | undefined;
      let narrationSource: string | undefined;
      try {
        narration = await runFreeTurn(state, declaredAction, '', async (attemptInput) => {
          context ??= buildNarratorContext(attemptInput);
          sceneIntent = attemptInput.sceneIntent;
          const waitMs = Math.max(0, nextAllowedAt - Date.now());
          if (waitMs) {
            console.log('Aguardando o intervalo entre chamadas ao Groq.');
            const throttleStart = performance.now();
            await sleep(waitMs);
            timing.throttleWaitMs += Math.round(performance.now() - throttleStart);
          }
          attempts++;
          const attemptStart = performance.now();
          try {
            return await generateCampaignNarration(attemptInput, 'groq');
          } catch (error) {
            const failure = describeNarratorFailure(error, 'groq');
            record({ type: 'attempt-failure', turn, attempt: attempts,
              latencyMs: Math.round(performance.now() - attemptStart), failure });
            if (attempts === 1 && failure.code === 'NARRATION_EXCEEDS_LIMIT') {
              console.log('A narração ultrapassou 2.000 caracteres. Vou tentar uma versão mais concisa.');
            }
            throw error;
          } finally {
            timing.generationAttemptsMs.push(Math.round(performance.now() - attemptStart));
            nextAllowedAt = Date.now() + 20_000;
          }
        }, async (proposed, draft, source) => {
          plan = proposed;
          narrationSource = source;
          if (!debug && source !== 'review') return true;
          console.log('\n' + draft);
          console.log('Estado proposto: ' + proposed.location + ', +' + proposed.minutes + ' min.');
          const reviewStart = performance.now();
          const answer = await terminal.question('A cena e o estado refletem sua ação? Confirme se o deslocamento previsto ocorreu, sem novas escolhas ou transferências para Samuel. [s/N] ')
            .finally(() => { timing.reviewWaitMs += Math.round(performance.now() - reviewStart); });
          exitRequested = shouldEndFreeSession(answer);
          return /^(?:s|sim)$/i.test(answer.trim());
        }, true);
      } catch (error) {
        const failure = describeNarratorFailure(error, 'groq');
        record({ type: 'turn', turn, declaredAction, context, sceneIntent, plan, attempts, timing, latencyMs: Math.round(performance.now() - start), failure });
        if (exitRequested) break;
        if (error instanceof FreeTurnClarification) {
          clarification = error;
          console.log(error.question);
          continue;
        }
        if (failure.category === 'response' || failure.category === 'timeout' || failure.category === 'network') {
          console.error('Turno sem avanço: ' + failure.code + '. Digite a ação novamente, escolha outra ou use :sair.');
          continue;
        }
        console.error('Sessão interrompida: ' + failure.code);
        process.exitCode = 1;
        break;
      }
      record({ type: 'turn', turn, declaredAction, context, sceneIntent, plan, narration, narrationSource, attempts, timing,
        latencyMs: Math.round(performance.now() - start), screeningFlags: reviewEchoArcNarration(narration), literaryReview: 'pending' });
      if (!debug && narrationSource !== 'review') console.log('\n' + narration);
      turn++;
    }
  } finally {
    terminal.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Falha na sessão local.');
  process.exitCode = 1;
});
