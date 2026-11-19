import type { Campaign, NpcRecord, WorldTime } from '../types/game';
import { getNpcIdentity, type NpcKnowledge } from './npcIdentity';
import type { TurnCatalog } from './turnPlanner';
import { getActiveTimelineId } from './rulesEngine';
import { recallNpcMemories, recordNpcMemories, type NpcMemory } from './npcMemory';
import type { CharacterRelationship } from './npcRelationship';

export interface NpcRoutineState {
  activities: { npcId: string; location: string; day: number; activity: string }[];
  observations: { npcId: string; subjectId: string; fact: string }[];
  memories?: readonly NpcMemory[];
  relationships?: readonly CharacterRelationship[];
  completedActivities?: readonly string[];
  holds: { npcId: string; until: WorldTime; reason: 'commitment' | 'exception' | 'choice' }[];
}

const emptyState: NpcRoutineState = { activities: [], observations: [], holds: [] };
const day = ({ year, month, day }: WorldTime) => (year * 12 + month - 1) * 30 + day - 1;
const minute = (time: WorldTime) => day(time) * 1440 + time.hour * 60 + time.minute;

export function isNpcOccupied(state: NpcRoutineState | undefined, npcId: string, time: WorldTime) {
  return state?.holds?.some((hold) => hold.npcId === npcId && minute(hold.until) > minute(time)) ?? false;
}

export function advanceNpcRoutines(campaign: Campaign, end: WorldTime, records: readonly NpcRecord[],
  catalog: TurnCatalog, saved: NpcRoutineState = emptyState, event?: { turnId: string; sequence: number }) {
  const startMinute = minute(campaign.worldTime);
  const endMinute = minute(end);
  const places = new Set(catalog.places.map(({ id }) => id));
  const changes = records.flatMap((npc) => {
    const routine = getNpcIdentity(campaign, npc)?.routine;
    if (!routine || !places.has(npc.location) || !places.has(routine.location) ||
        isNpcOccupied(saved, npc.id, campaign.worldTime)) return [];
    const earliest = Math.max(startMinute, day(end) * 1440 + routine.fromHour * 60);
    const windowEnd = day(end) * 1440 + routine.untilHour * 60;
    if (earliest >= endMinute || endMinute > windowEnd ||
        saved.activities.some((entry) => entry.npcId === npc.id && entry.day === day(end))) return [];
    const route = catalog.routes.find(({ from, to }) => from === npc.location && to === routine.location);
    if (npc.location !== routine.location && (!route || route.blocked || !Number.isSafeInteger(route.minutes) ||
        route.minutes < 1 || earliest + route.minutes > endMinute)) return [];
    return [{ npcId: npc.id, from: npc.location, to: routine.location, activity: routine.activity, day: day(end) }];
  });
  const moves = changes.filter(({ from, to }) => from !== to);
  const observations = moves.flatMap((move) => {
    const subject = records.find(({ id }) => id === move.npcId)!;
    return records.filter((npc) => npc.location === move.from && npc.id !== move.npcId &&
      npc.campaignId === campaign.id && npc.ownerId === campaign.ownerId && !moves.some(({ npcId }) => npcId === npc.id))
      .map(({ id }) => ({ npcId: id, subjectId: subject.id, location: move.from, fact: `Viu ${subject.name} sair.` }));
  });
  return {
    moves,
    state: changes.length === 0 ? saved : {
      ...saved,
      activities: [...saved.activities.filter(({ npcId }) => !changes.some((change) => change.npcId === npcId)),
        ...changes.map(({ npcId, to, activity, day }) => ({ npcId, location: to, day, activity }))],
      // Preserve observations already saved by the previous pilot.
      observations: saved.observations,
      ...(event ? { memories: recordNpcMemories(saved.memories ?? [], observations.map(({ npcId, subjectId, location, fact }) => ({
        ...event, npcId, timelineId: getActiveTimelineId(campaign), fact,
        origin: { kind: 'observed', subjectId, location },
      }))) } : {}),
      holds: saved.holds,
    },
  };
}

export function routineScene(campaign: Campaign, records: readonly NpcRecord[], state: NpcRoutineState,
  throughSequence?: number) {
  const npcs = records.filter(({ location }) => location === campaign.currentLocation);
  const knowledge: NpcKnowledge[] = npcs.flatMap((npc) => {
    const key = getNpcIdentity(campaign, npc)?.key;
    if (!key) return [];
    return state.observations.filter(({ npcId }) => npcId === npc.id)
      .map(({ fact }) => ({ source: 'observed' as const, fact, knownBy: [key] }));
  });
  const activities = npcs.flatMap((npc) => {
    const routine = getNpcIdentity(campaign, npc)?.routine;
    const hour = campaign.worldTime.hour;
    if (!routine || hour < routine.fromHour || hour >= routine.untilHour) return [];
    return state.activities.filter((entry) => entry.npcId === npc.id &&
      entry.location === npc.location && entry.day === day(campaign.worldTime))
      .map(({ activity }) => ({ name: npc.name, activity }));
  });
  return { npcs, knowledge, activities,
    memories: recallNpcMemories(campaign, npcs, state.memories ?? [], throughSequence) };
}
