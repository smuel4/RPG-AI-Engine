import type { CheckpointSummary, PilotCheckpointRequest, PilotCheckpointResult } from '../engine/pilotCheckpoint';

export class CheckpointRequestError extends Error {
  constructor(message: string, readonly definitive: boolean) { super(message); }
}

async function checkpointRequest(token: string, options: RequestInit) {
  const response = await fetch('/api/freixo/checkpoints', {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new CheckpointRequestError(body?.message ?? 'Não foi possível acessar os checkpoints da campanha.',
      typeof body?.message === 'string' && [400, 404, 409].includes(response.status));
  }
  return response.json();
}

export function requestPilotCheckpoints(token: string, signal: AbortSignal): Promise<CheckpointSummary[]> {
  return checkpointRequest(token, { signal });
}

export function sendPilotCheckpoint(token: string, request: PilotCheckpointRequest): Promise<PilotCheckpointResult> {
  return checkpointRequest(token, { method: 'POST', body: JSON.stringify(request) });
}
