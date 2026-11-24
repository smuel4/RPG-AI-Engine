import type { TurnOrigin } from '../engine/turnIdentity';
import type { PilotScene } from '../types/game';

export async function requestPilotScene(token: string, signal: AbortSignal): Promise<PilotScene> {
  const response = await fetch('/api/freixo/scene', { headers: { Authorization: `Bearer ${token}` }, signal });
  if (!response.ok) throw new Error('Cena indisponível.');
  return response.json();
}

export interface RequestNarratorTurnOptions {
  campaignId: string;
  declaredAction: string;
  advanceMinutes?: number;
  mode?: 'gemini' | 'fixed';
  turn?: TurnOrigin;
  clarificationToken?: string;
}

export interface NarratorTurnResult {
  narration: string;
  mode: 'gemini' | 'groq' | 'fixed' | 'replay';
  turnId?: string;
  expectedRevision: number;
  expectedLastSequence: number;
  baseTimelineId: string;
}

export interface NarratorErrorPayload {
  code: string;
  message: string;
  clarificationToken?: string;
  gameplayFeedback?: boolean;
}

export class NarratorRequestError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number,
    readonly clarificationToken?: string, readonly gameplayFeedback = false) {
    super(message);
  }
}

export async function requestNarratorTurn(
  token: string,
  options: RequestNarratorTurnOptions,
): Promise<NarratorTurnResult> {
  const response = await fetch('/api/narrator/turn', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      campaignId: options.campaignId,
      declaredAction: options.declaredAction,
      advanceMinutes: options.advanceMinutes ?? 10,
      mode: options.mode,
      ...options.turn,
      clarificationToken: options.clarificationToken,
    }),
  });

  if (!response.ok) {
    let errorPayload: NarratorErrorPayload | null = null;
    try {
      errorPayload = (await response.json()) as NarratorErrorPayload;
    } catch {
      // Falha ao ler JSON
    }

    const message =
      errorPayload?.message ||
      `Falha na chamada ao narrador (${response.status}: ${response.statusText})`;

    const clarificationToken = typeof errorPayload?.clarificationToken === 'string'
      ? errorPayload.clarificationToken : undefined;
    throw new NarratorRequestError(message, errorPayload?.code, response.status, clarificationToken,
      response.status === 422 && errorPayload?.gameplayFeedback === true);
  }

  return (await response.json()) as NarratorTurnResult;
}
