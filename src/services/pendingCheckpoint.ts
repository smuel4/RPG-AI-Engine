import type { PilotCheckpointRequest } from '../engine/pilotCheckpoint';
import { isTurnId } from '../engine/turnIdentity';

export type CheckpointEnvironment = 'local' | 'staging';
type Scope = { environment: CheckpointEnvironment; ownerId: string; campaignId: string };
const storageKey = ({ environment, ownerId, campaignId }: Scope) =>
  'echo-arc:pending-checkpoint:' + JSON.stringify([environment, ownerId, campaignId]);

export function loadPendingCheckpoint(storage: Storage, scope: Scope): PilotCheckpointRequest | null {
  try {
    const record = JSON.parse(storage.getItem(storageKey(scope)) ?? 'null');
    if (record?.environment !== scope.environment || record.ownerId !== scope.ownerId) return null;
    const { request } = record;
    if (request?.campaignId !== scope.campaignId || !isTurnId(request.requestId) ||
        !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
        typeof request.baseTimelineId !== 'string' || !/^[\w-]{1,128}$/u.test(request.baseTimelineId)) return null;
    const base = { campaignId: scope.campaignId, requestId: request.requestId,
      expectedRevision: request.expectedRevision as number, baseTimelineId: request.baseTimelineId as string };
    if (request.action === 'save' && typeof request.label === 'string' && typeof request.note === 'string') {
      return { ...base, action: 'save', label: request.label, note: request.note };
    }
    if (request.action === 'restore' && typeof request.checkpointId === 'string' && /^[\w-]{1,128}$/u.test(request.checkpointId)) {
      return { ...base, action: 'restore', checkpointId: request.checkpointId };
    }
    return null;
  } catch {
    return null;
  }
}

export function savePendingCheckpoint(storage: Storage, scope: Scope, request: PilotCheckpointRequest) {
  if (request.campaignId !== scope.campaignId || loadPendingCheckpoint(storage, scope)) {
    throw new Error('Já existe uma operação de checkpoint pendente ou incompatível.');
  }
  storage.setItem(storageKey(scope), JSON.stringify({ ...scope, request }));
}

export function clearPendingCheckpoint(storage: Storage, scope: Scope, requestId: string) {
  if (loadPendingCheckpoint(storage, scope)?.requestId === requestId) storage.removeItem(storageKey(scope));
}
