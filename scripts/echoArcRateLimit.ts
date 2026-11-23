import { setTimeout as delay } from 'node:timers/promises';
import { NarratorFailure } from '../server/narratorProvider';

function resetMs(header: string | null): number {
  if (!header) return 0;
  if (/^\d+(?:\.\d+)?$/.test(header)) return Number(header) * 1000;
  const scale: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
  const parts = [...header.matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/g)];
  if (parts.map((part) => part[0]).join('') !== header) return 0;
  return parts.reduce((sum, [, value, unit]) => sum + Number(value) * scale[unit], 0);
}

export function nextGroqAttempt(headers: Headers, status: number, now: number, maxOutputTokens: number): number {
  const retryAfter = headers.get('retry-after');
  const retryMs = !retryAfter ? 0 : /^\d+(?:\.\d+)?$/.test(retryAfter)
    ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - now) || 0;
  const requests = headers.get('x-ratelimit-remaining-requests');
  const tokens = headers.get('x-ratelimit-remaining-tokens');
  // Previous runs needed up to 1,256 prompt tokens. Reserve room for prompt edits.
  const requestReset = requests !== null && Number(requests) < 1
    ? resetMs(headers.get('x-ratelimit-reset-requests')) : 0;
  const tokenReset = tokens !== null && Number(tokens) < 1600 + maxOutputTokens
    ? resetMs(headers.get('x-ratelimit-reset-tokens')) : 0;
  const minimum = status === 429 && !retryMs ? 60_000 : 20_000;
  return now + Math.ceil(Math.max(minimum, retryMs, requestReset, tokenReset));
}

// The Freixo runner is sequential. One request per minute avoids overlapping
// reservations from this run. The token estimate includes both prompt messages.
export function createFreixoGroqBudget(maxCalls: number, now = Date.now, sleep: (ms: number) => Promise<void> = delay) {
  const minuteMs = 60_000;
  const maxWaitMs = 65_000;
  let calls = 0;
  let nextAt = 0;
  return {
    get calls() { return calls; },
    async generate<T>(input: string, maxOutputTokens: number, send: () => Promise<T>) {
      const estimatedInputTokens = Math.ceil(Buffer.byteLength(input, 'utf8') / 2) + 256;
      if (estimatedInputTokens + maxOutputTokens > 8_000) {
        throw new NarratorFailure('GROQ_EVALUATION_TOKEN_BUDGET', 'configuration');
      }
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (calls >= maxCalls) throw new NarratorFailure('GROQ_EVALUATION_CALL_BUDGET', 'configuration');
        const waitMs = Math.max(0, nextAt - now());
        if (waitMs > maxWaitMs) throw new NarratorFailure('GROQ_EVALUATION_WAIT_LIMIT', 'configuration');
        if (waitMs) await sleep(waitMs);

        const originalFetch = globalThis.fetch;
        let rateLimited = false;
        let sent = false;
        globalThis.fetch = async (request, init) => {
          const url = new URL(request instanceof Request ? request.url : String(request));
          if (url.href !== 'https://api.groq.com/openai/v1/chat/completions' || calls >= maxCalls || sent) {
            throw new Error('Chamada fora do orçamento ou do endpoint de avaliação.');
          }
          sent = true;
          calls++;
          nextAt = now() + minuteMs;
          const response = await originalFetch(request, init);
          rateLimited = response.status === 429;
          nextAt = Math.max(nextAt, nextGroqAttempt(response.headers, response.status, now(), maxOutputTokens));
          return response;
        };
        try {
          return await send();
        } catch (error) {
          if (!rateLimited || attempt === 2 || calls >= maxCalls || nextAt - now() > maxWaitMs) throw error;
        } finally {
          globalThis.fetch = originalFetch;
        }
      }
      throw new Error('Limite de tentativas ao Groq atingido.');
    },
  };
}
