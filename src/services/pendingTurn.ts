import { isTurnId, type TurnIdentity } from '../engine/turnIdentity';
import { NarratorRequestError } from './narratorClient';

const pilotRejections = new Set([
  'PILOT_TRAVEL_UNAVAILABLE', 'PILOT_SPEECH_UNAVAILABLE', 'PILOT_ACTION_UNSUPPORTED',
  'PILOT_OBSERVATION_UNAVAILABLE', 'PILOT_ACTIVITY_UNAVAILABLE', 'PILOT_ACTION_INVALID',
  'PILOT_OBJECT_AMBIGUOUS', 'PILOT_OBJECT_OUT_OF_REACH', 'PILOT_OBJECT_UNREGISTERED',
  'PILOT_NARRATION_CONFLICT',
  'PILOT_SEQUENCE_LIMIT', 'PILOT_SEQUENCE_NEEDS_REPLY',
]);

export function releaseRejectedPilotTurn(storage: Storage, ownerId: string, turn: TurnIdentity,
  error: unknown): error is NarratorRequestError {
  if (!(error instanceof NarratorRequestError) || error.status !== 422 ||
      !error.code || !pilotRejections.has(error.code)) return false;
  clearPendingTurn(storage, ownerId, turn);
  return true;
}

const keyFor = (ownerId: string, campaignId: string) =>
  'echo-arc:pending-turn:' + JSON.stringify([ownerId, campaignId]);

export function loadPendingTurn(storage: Storage, ownerId: string, campaignId: string): TurnIdentity | null {
  try {
    const record = JSON.parse(storage.getItem(keyFor(ownerId, campaignId)) ?? 'null');
    if (!record || record.ownerId !== ownerId || record.campaignId !== campaignId ||
        !isTurnId(record.turnId) || typeof record.declaredAction !== 'string' ||
        record.declaredAction.trim().length < 1 || record.declaredAction.length > 800 ||
        !Number.isSafeInteger(record.advanceMinutes) || record.advanceMinutes < 0 || record.advanceMinutes > 720 ||
        !Number.isSafeInteger(record.expectedRevision) || record.expectedRevision < 0 ||
        typeof record.baseTimelineId !== 'string' || !/^[\w-]{1,128}$/.test(record.baseTimelineId)) return null;
    const { turnId, declaredAction, advanceMinutes, expectedRevision, baseTimelineId } = record;
    return { campaignId, turnId, declaredAction, advanceMinutes, expectedRevision, baseTimelineId };
  } catch {
    return null;
  }
}

export function savePendingTurn(storage: Storage, ownerId: string, turn: TurnIdentity): void {
  const { campaignId, turnId, declaredAction, advanceMinutes, expectedRevision, baseTimelineId } = turn;
  storage.setItem(keyFor(ownerId, campaignId), JSON.stringify({
    ownerId, campaignId, turnId, declaredAction, advanceMinutes, expectedRevision, baseTimelineId,
  }));
}

export function clearPendingTurn(storage: Storage, ownerId: string, turn: TurnIdentity): void {
  if (loadPendingTurn(storage, ownerId, turn.campaignId)?.turnId === turn.turnId) {
    storage.removeItem(keyFor(ownerId, turn.campaignId));
  }
}
