import { setTimeout as delay } from 'node:timers/promises';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  boundedInteger, buildNarratorPrompt, describeNarratorFailure, measureNarration, NarratorFailure,
  narratorInstructions, validateNarration, withNarratorDeadline, type NarrationInput, type NarratorProvider,
} from './narratorProvider';

export type GeminiContentGenerator = (
  contents: string,
  systemInstruction: string,
) => Promise<string>;

const INITIAL_RETRY_DELAY_MS = 1_000;

export function describeGeminiFailure(error: unknown) {
  return describeNarratorFailure(error, 'gemini');
}

export async function generateGeminiNarration(
  input: NarrationInput,
  generatorOverride?: GeminiContentGenerator,
): Promise<string> {
  const contents = buildNarratorPrompt(input);
  if (generatorOverride) {
    return validateNarration(await generatorOverride(contents, narratorInstructions), 'gemini');
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim();
  return measureNarration('gemini', model, async (recordUsage) => {
    if (!apiKey) throw new NarratorFailure('GEMINI_API_KEY_MISSING', 'configuration');
    if (!model) throw new NarratorFailure('GEMINI_MODEL_MISSING', 'configuration');

    const ai = new GoogleGenAI({ apiKey });
    const timeout = boundedInteger(process.env.GEMINI_TIMEOUT_MS, 60_000, 1_000, 60_000);
    const maxOutputTokens = boundedInteger(process.env.GEMINI_MAX_OUTPUT_TOKENS, 1000, 1, 2048);
    const thinkingLevel = process.env.GEMINI_THINKING_LEVEL === 'MINIMAL' ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW;
    const response = await withNarratorDeadline(timeout, (signal) => {
      const generate = () => ai.models.generateContent({
        model,
        contents,
        config: {
          abortSignal: signal,
          automaticContinuation: false,
          systemInstruction: narratorInstructions,
          temperature: 0.8,
          maxOutputTokens,
          ...(model === 'gemini-3.6-flash' || model === 'models/gemini-3.6-flash'
            ? { thinkingConfig: { thinkingLevel } }
            : {}),
        },
      });
      return generate().catch(async (error: unknown) => {
        const failure = describeGeminiFailure(error);
        if (process.env.GEMINI_RETRY_503 !== 'true' ||
            failure.category !== 'provider_http' || failure.status !== 503) throw error;
        await delay(INITIAL_RETRY_DELAY_MS, undefined, { signal });
        signal.throwIfAborted();
        return generate();
      });
    });

    recordUsage({
      inputTokens: response.usageMetadata?.promptTokenCount,
      outputTokens: response.usageMetadata?.candidatesTokenCount,
      totalTokens: response.usageMetadata?.totalTokenCount,
    });
    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason === 'MAX_TOKENS') throw new NarratorFailure('GEMINI_MAX_TOKENS', 'response');
    if (!response.text?.trim()) {
      if (response.promptFeedback?.blockReason || finishReason === 'SAFETY') {
        throw new NarratorFailure('GEMINI_RESPONSE_BLOCKED', 'response');
      }
    }
    return validateNarration(response.text, 'gemini');
  });
}

export const geminiNarrator: NarratorProvider = { generate: generateGeminiNarration };
