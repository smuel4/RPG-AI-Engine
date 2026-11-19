import type { GameEvent, NarrativeEntry } from '../types/game';

export interface TurnOrigin {
  turnId: string;
  expectedRevision: number;
  baseTimelineId: string;
}

export interface TurnIdentity extends TurnOrigin {
  campaignId: string;
  declaredAction: string;
  advanceMinutes: number;
}

export const isTurnId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

export async function turnDocumentIds(turn: TurnIdentity) {
  const binding = new TextEncoder().encode(JSON.stringify([
    turn.campaignId, turn.turnId, turn.declaredAction.trim(), turn.expectedRevision, turn.baseTimelineId, turn.advanceMinutes,
  ]));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', binding);
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { event: 'evt_turn_' + turn.turnId, player: 'nar_turn_p_' + key, engine: 'nar_turn_e_' + key };
}

export function checkTurnRevision(
  turn: TurnOrigin,
  state: { revision: number; activeTimelineId?: string },
): boolean {
  return state.revision === turn.expectedRevision && (state.activeTimelineId || 'tl_root') === turn.baseTimelineId;
}


export function readCommittedTurn(turn: TurnIdentity, ownerId: string, event: GameEvent,
  player?: NarrativeEntry, engine?: NarrativeEntry): NarrativeEntry | null {
  const owned = (entry: GameEvent | NarrativeEntry) => entry.ownerId === ownerId &&
    entry.campaignId === turn.campaignId && entry.timelineId === turn.baseTimelineId;
  if (!player || !engine || !owned(event) || !owned(player) || !owned(engine) ||
      event.type !== 'PLAYER_ACTION' || player.authorRole !== 'player_action' ||
      engine.authorRole !== 'engine_response' || player.content !== turn.declaredAction.trim() ||
      player.sequence + 1 !== engine.sequence || engine.sequence + 1 !== event.sequence) return null;
  return engine;
}
