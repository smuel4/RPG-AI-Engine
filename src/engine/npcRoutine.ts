import type { Campaign, NpcRecord, WorldTime } from '../types/game';
import { getNpcIdentity, type NpcKnowledge } from './npcIdentity';
import type { TurnCatalog } from './turnPlanner';
import { getActiveTimelineId } from './rulesEngine';
import { recallNpcMemories, recordNpcMemories, type NpcMemory } from './npcMemory';
import type { CharacterRelationship } from './npcRelationship';

export interface NpcRoutineState {
  activities: { npcId: string; location: string; day: number; activity: string; stage?: 'next' }[];
  observations: { npcId: string; subjectId: string; fact: string }[];
  memories?: readonly NpcMemory[];
  relationships?: readonly CharacterRelationship[];
  completedActivities?: readonly string[];
  openObjects?: readonly string[];
  holds: { npcId: string; until: WorldTime; reason: 'commitment' | 'exception' | 'choice' }[];
}

const emptyState: NpcRoutineState = { activities: [], observations: [], holds: [] };
const day = ({ year, month, day }: WorldTime) => (year * 12 + month - 1) * 30 + day - 1;
const minute = (time: WorldTime) => day(time) * 1440 + time.hour * 60 + time.minute;

export function isNpcOccupied(state: NpcRoutineState | undefined, npcId: string, time: WorldTime) {
  return state?.holds?.some((hold) => hold.npcId === npcId && minute(hold.until) > minute(time)) ?? false;
}

export function advanceNpcRoutines(campaign: Campaign, end: WorldTime, records: readonly NpcRecord[],
  catalog: TurnCatalog, saved: NpcRoutineState = emptyState, event?: { turnId: string; sequence: number },
  isWait = false) {
  const startMinute = minute(campaign.worldTime);
  const endMinute = minute(end);
  const places = new Set(catalog.places.map(({ id }) => id));
  const changes = records.flatMap((npc) => {
    const identity = getNpcIdentity(campaign, npc);
    if (!identity?.routine || !places.has(npc.location)) return [];
    const followUp = identity.nextRoutine && places.has(identity.nextRoutine.location) &&
      identity.nextRoutine.fromHour >= identity.routine.untilHour ? identity.nextRoutine : undefined;
    const processInterval = isWait || Boolean(followUp);
    if (!processInterval && isNpcOccupied(saved, npc.id, campaign.worldTime)) return [];
    const available = processInterval ? (saved.holds ?? []).reduce((start, hold) =>
      hold.npcId === npc.id ? Math.max(start, minute(hold.until)) : start, startMinute) : startMinute;
    const today = day(end);
    let location = npc.location;
    return [identity.routine, followUp].flatMap((routine, index) => {
      const stage = index === 1 ? 'next' as const : undefined;
      if (!routine || !places.has(routine.location) ||
          saved.activities.some((entry) => entry.npcId === npc.id && entry.day === today && entry.stage === stage)) return [];
      const earliest = Math.max(available, today * 1440 + routine.fromHour * 60);
      const windowEnd = today * 1440 + routine.untilHour * 60;
      const deadline = processInterval ? Math.min(endMinute, windowEnd) : endMinute;
      if (earliest >= deadline || deadline > windowEnd) return [];
      const route = catalog.routes.find(({ from, to }) => from === location && to === routine.location);
      if (location !== routine.location && (!route || route.blocked || !Number.isSafeInteger(route.minutes) ||
          route.minutes < 1 || earliest + route.minutes > deadline)) return [];
      const completedAt = earliest + (location === routine.location ? 0 : route!.minutes);
      const change = { npcId: npc.id, from: location, to: routine.location, activity: routine.activity, day: today,
        completedAt, withinWindow: completedAt < windowEnd, ...(stage ? { stage } : {}) };
      location = routine.location;
      return [change];
    });
  });
  if (isWait || changes.some(({ stage }) => stage)) changes.sort((a, b) => a.completedAt - b.completedAt);
  const moves = changes.filter(({ from, to }) => from !== to)
    .map(({ completedAt: _, stage: _stage, withinWindow: _withinWindow, ...move }) => move);
  const performed = changes.filter(({ withinWindow }) => withinWindow);
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
      activities: [...saved.activities.filter((entry) => !performed.some((change) => change.npcId === entry.npcId &&
        (change.day !== entry.day || change.stage === entry.stage))),
        ...performed.map(({ npcId, to, activity, day, stage }) => ({ npcId, location: to, day, activity, ...(stage ? { stage } : {}) }))],
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
    const identity = getNpcIdentity(campaign, npc);
    const hour = campaign.worldTime.hour + campaign.worldTime.minute / 60;
    return state.activities.filter((entry) => {
      const routine = entry.stage === 'next' ? identity?.nextRoutine : identity?.routine;
      return routine && hour >= routine.fromHour && hour < routine.untilHour && entry.npcId === npc.id &&
        entry.location === npc.location && entry.day === day(campaign.worldTime);
    })
      .map(({ activity }) => ({ name: npc.name, activity }));
  });
  return { npcs, knowledge, activities,
    memories: recallNpcMemories(campaign, npcs, state.memories ?? [], throughSequence) };
}
