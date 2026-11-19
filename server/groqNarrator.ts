import {
  boundedInteger, buildNarratorPrompt, measureNarration, NarratorFailure, narratorInstructions,
  validateNarration, withNarratorDeadline, type NarratorProvider,
} from './narratorProvider';

const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
const CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';

interface GroqCompletion {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export const groqNarrator: NarratorProvider = {
  async generate(input) {
    const model = process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL;
    const apiKey = process.env.GROQ_API_KEY?.trim();
    return measureNarration('groq', model, async (recordUsage) => {
      if (!apiKey) throw new NarratorFailure('GROQ_API_KEY_MISSING', 'configuration');
      const timeout = boundedInteger(process.env.GROQ_TIMEOUT_MS, 30_000, 1_000, 60_000);
      const maxTokens = boundedInteger(process.env.GROQ_MAX_OUTPUT_TOKENS, 1000, 1, 2048);
      const result = await withNarratorDeadline(timeout, async (signal) => {
        const response = await fetch(CHAT_COMPLETIONS_URL, {
          method: 'POST',
          redirect: 'error',
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: narratorInstructions },
              { role: 'user', content: buildNarratorPrompt(input) },
            ],
            temperature: 0.8,
            max_completion_tokens: maxTokens,
            ...(model === DEFAULT_GROQ_MODEL ? { reasoning_effort: 'low' } : {}),
          }),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new NarratorFailure('GROQ_HTTP_ERROR', 'provider_http', response.status);
        }
        return await response.json() as GroqCompletion | null;
      });

      recordUsage({
        inputTokens: result?.usage?.prompt_tokens,
        outputTokens: result?.usage?.completion_tokens,
        totalTokens: result?.usage?.total_tokens,
      });
      const choice = result?.choices?.[0];
      if (choice?.finish_reason === 'length') throw new NarratorFailure('GROQ_MAX_TOKENS', 'response');
      const text = choice?.message?.content;
      return validateNarration(typeof text === 'string' ? text : undefined, 'groq');
    });
  },
};
