import type { TurnOrigin } from '../engine/turnIdentity';

export interface RequestNarratorTurnOptions {
  campaignId: string;
  declaredAction: string;
  advanceMinutes?: number;
  mode?: 'gemini' | 'fixed';
  turn?: TurnOrigin;
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
}

export class NarratorRequestError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
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

    throw new NarratorRequestError(message, errorPayload?.code, response.status);
  }

  return (await response.json()) as NarratorTurnResult;
}
