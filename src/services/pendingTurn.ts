import { isTurnId, type TurnIdentity } from '../engine/turnIdentity';
import { NarratorRequestError } from './narratorClient';

const pilotRejections = new Set([
  'PILOT_FACTUAL_NPC_OCCUPIED',
  'PILOT_TRAVEL_UNAVAILABLE', 'PILOT_SPEECH_UNAVAILABLE', 'PILOT_ACTION_UNSUPPORTED',
  'PILOT_OBSERVATION_UNAVAILABLE', 'PILOT_ACTIVITY_UNAVAILABLE', 'PILOT_ACTION_INVALID',
  'PILOT_OBJECT_AMBIGUOUS', 'PILOT_OBJECT_OUT_OF_REACH', 'PILOT_OBJECT_UNREGISTERED',
  'PILOT_OBJECT_FIXED', 'PILOT_OBJECT_NOT_HELD', 'PILOT_OBJECT_ALREADY_HELD',
  'PILOT_OBJECT_OWNED', 'PILOT_TRANSFER_SEQUENCE', 'PILOT_TRANSFER_AMBIGUOUS',
  'PILOT_STORAGE_DISTANT', 'PILOT_STORAGE_UNAVAILABLE', 'PILOT_STORAGE_CLOSED', 'PILOT_STORAGE_EMPTY', 'PILOT_STORAGE_EXPLICIT',
  'PILOT_DELIVERY_RECIPIENT', 'PILOT_DELIVERY_NOT_TRANSFERABLE', 'PILOT_DELIVERY_NOT_ALLOWED', 'PILOT_DELIVERY_OFFER',
  'PILOT_ENVIRONMENT_SEQUENCE', 'PILOT_ENVIRONMENT_AMBIGUOUS', 'PILOT_ENVIRONMENT_UNAVAILABLE',
  'PILOT_ENVIRONMENT_ALREADY_ORGANIZED',
  'PILOT_WAIT_SEQUENCE', 'PILOT_WAIT_UNAVAILABLE',
  'PILOT_OPEN_CLOSE_SEQUENCE', 'PILOT_OPEN_CLOSE_AMBIGUOUS', 'PILOT_OPEN_CLOSE_UNAVAILABLE', 'PILOT_OPEN_CLOSE_ALREADY_SET',
  'PILOT_NARRATION_CONFLICT',
  'PILOT_SEQUENCE_LIMIT', 'PILOT_SEQUENCE_NEEDS_REPLY',
  'PILOT_CLARIFICATION_EXPIRED',
]);

export interface PendingTurn extends TurnIdentity {
  clarificationToken?: string;
}

export function releaseRejectedPilotTurn(storage: Storage, ownerId: string, turn: TurnIdentity,
  error: unknown): error is NarratorRequestError {
  if (!(error instanceof NarratorRequestError) || error.status !== 422 ||
      !error.code || !pilotRejections.has(error.code)) return false;
  clearPendingTurn(storage, ownerId, turn);
  return true;
}

const keyFor = (ownerId: string, campaignId: string) =>
  'echo-arc:pending-turn:' + JSON.stringify([ownerId, campaignId]);

export function loadPendingTurn(storage: Storage, ownerId: string, campaignId: string): PendingTurn | null {
  try {
    const record = JSON.parse(storage.getItem(keyFor(ownerId, campaignId)) ?? 'null');
    if (!record || record.ownerId !== ownerId || record.campaignId !== campaignId ||
        !isTurnId(record.turnId) || typeof record.declaredAction !== 'string' ||
        record.declaredAction.trim().length < 1 || record.declaredAction.length > 800 ||
        !Number.isSafeInteger(record.advanceMinutes) || record.advanceMinutes < 0 || record.advanceMinutes > 720 ||
        !Number.isSafeInteger(record.expectedRevision) || record.expectedRevision < 0 ||
        typeof record.baseTimelineId !== 'string' || !/^[\w-]{1,128}$/.test(record.baseTimelineId)) return null;
    const { turnId, declaredAction, advanceMinutes, expectedRevision, baseTimelineId } = record;
    if (record.clarificationToken !== undefined &&
        (typeof record.clarificationToken !== 'string' || record.clarificationToken.length > 556)) return null;
    return { campaignId, turnId, declaredAction, advanceMinutes, expectedRevision, baseTimelineId,
      ...(record.clarificationToken ? { clarificationToken: record.clarificationToken } : {}) };
  } catch {
    return null;
  }
}

export function savePendingTurn(storage: Storage, ownerId: string, turn: PendingTurn): void {
  const { campaignId, turnId, declaredAction, advanceMinutes, expectedRevision, baseTimelineId, clarificationToken } = turn;
  storage.setItem(keyFor(ownerId, campaignId), JSON.stringify({
    ownerId, campaignId, turnId, declaredAction, advanceMinutes, expectedRevision, baseTimelineId, clarificationToken,
  }));
}

export function clearPendingTurn(storage: Storage, ownerId: string, turn: TurnIdentity): void {
  if (loadPendingTurn(storage, ownerId, turn.campaignId)?.turnId === turn.turnId) {
    storage.removeItem(keyFor(ownerId, turn.campaignId));
  }
}
