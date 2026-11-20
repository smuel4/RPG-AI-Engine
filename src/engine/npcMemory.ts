import type { Campaign, NpcRecord, WorldTime } from '../types/game';
import { getActiveTimelineId } from './rulesEngine';

export type NpcMemoryOrigin =
  | { kind: 'observed'; subjectId: string; location: string; event?: 'organization' }
  | { kind: 'participated'; subjectId: string; event: 'delivery' | 'organization' }
  | { kind: 'reported'; reporterId: string; speakerName?: string }
  | { kind: 'interpretation'; evidenceId: string }
  | { kind: 'consequence'; effect: 'commitment' | 'relationship'; subjectId: string };

export interface NpcMemory {
  npcId: string;
  timelineId: string;
  turnId: string;
  sequence: number;
  occurredAt?: WorldTime;
  origin: NpcMemoryOrigin;
  fact: string;
}

const MAX_SAVED_PER_NPC = 12;
const MAX_SCENE_PER_NPC = 3;
export const MAX_NPC_MEMORY_LENGTH = 180;

// Callers supply only events resolved by the engine, never free narrative text.
export function recordNpcMemories(saved: readonly NpcMemory[], additions: readonly NpcMemory[]): readonly NpcMemory[] {
  if (!additions.length) return saved;
  let result = [...saved];
  for (const entry of additions) {
    const fact = entry.fact.trim();
    if (!fact || fact.length > MAX_NPC_MEMORY_LENGTH || result.some((previous) =>
      previous.timelineId === entry.timelineId && previous.turnId === entry.turnId &&
      previous.npcId === entry.npcId && previous.origin.kind === entry.origin.kind && previous.fact === fact)) continue;
    result.push({ ...entry, fact });
    const individual = result.filter(({ npcId }) => npcId === entry.npcId);
    if (individual.length > MAX_SAVED_PER_NPC) result = result.filter((item) => item !== individual[0]);
  }
  return result;
}

export function recallNpcMemories(campaign: Campaign, npcs: readonly NpcRecord[], saved: readonly NpcMemory[],
  throughSequence = campaign.lastSequence) {
  const timelineId = getActiveTimelineId(campaign);
  return npcs.flatMap((npc) => {
    if (npc.campaignId !== campaign.id || npc.ownerId !== campaign.ownerId || npc.location !== campaign.currentLocation) return [];
    const memories = saved.filter((entry) => entry.npcId === npc.id && entry.timelineId === timelineId &&
      entry.sequence <= throughSequence).sort((a, b) => b.sequence - a.sequence).slice(0, MAX_SCENE_PER_NPC)
      .map(({ origin, fact }) => ({
        source: origin.kind,
        fact,
        ...(origin.kind === 'reported' && origin.speakerName ? { speaker: origin.speakerName } : {}),
      }));
    return memories.length ? [{ name: npc.name, memories }] : [];
  }).slice(0, 6);
}
