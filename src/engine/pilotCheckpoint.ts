import type { Checkpoint } from '../types/game';

export type CheckpointSummary = Pick<Checkpoint, 'id' | 'label' | 'note' | 'currentLocation' |
  'worldTime' | 'revision' | 'currency'> & { inventoryCount: number };

export function summarizeCheckpoint(checkpoint: Omit<Checkpoint, 'createdAt'>): CheckpointSummary {
  const { id, label, note, currentLocation, worldTime, revision, currency, inventorySnapshot } = checkpoint;
  return { id, label, note, currentLocation, worldTime, revision, currency, inventoryCount: inventorySnapshot.length };
}

export type PilotCheckpointAction = { action: 'save'; label: string; note: string } |
  { action: 'restore'; checkpointId: string };

export type PilotCheckpointRequest = PilotCheckpointAction & {
  campaignId: string;
  requestId: string;
  expectedRevision: number;
  baseTimelineId: string;
};

export interface PilotCheckpointResult {
  checkpointId: string;
  revision: number;
  timelineId: string;
}
