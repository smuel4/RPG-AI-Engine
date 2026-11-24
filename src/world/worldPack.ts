import type { TurnCatalog } from '../engine/turnPlanner';

interface NpcRoutineWindow {
  location: string;
  fromHour: number;
  untilHour: number;
  activity: string;
  dialogue?: { kind: 'work' | 'rest' | 'travel'; present: string; past: string };
}

export interface NpcIdentity {
  key: string;
  temperament: string;
  voice: string;
  occupation: string;
  objective: string;
  appearance?: { portraitRef: string; recognizableTraits: string };
  routine?: NpcRoutineWindow;
  nextRoutine?: NpcRoutineWindow;
  knowledge: readonly NpcKnowledge[];
}

export type NpcKnowledge =
  | { source: 'public'; fact: string }
  | { source: 'personal' | 'observed' | 'conversation' | 'interpretation'; fact: string; knownBy: readonly string[] }
  | { source: 'player-private'; fact: string };

export interface WorldPackV1 {
  version: 1;
  catalog: TurnCatalog;
  npcs: readonly { key: string; name: string; location: string; identity?: NpcIdentity }[];
}

export function defineWorldPack<T extends WorldPackV1>(pack: T): T {
  const { places, routes, objects = [], activities = [], occurrences = [] } = pack.catalog;
  function unique(keys: readonly string[], kind: string) {
    const values = new Set(keys);
    if (values.size !== keys.length) throw new Error(`WorldPack: duplicate ${kind}`);
    return values;
  }
  const locations = unique(places.map(({ id }) => id), 'place ID');
  const stableIds = places.flatMap(({ stableId }) => stableId === undefined ? [] : [stableId]);
  unique(stableIds, 'stable place ID');
  for (const { id, stableId } of places) {
    if (stableId !== undefined && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(stableId) ||
        (stableId !== id && locations.has(stableId)))) {
      throw new Error(`WorldPack: invalid stable place ID "${stableId}" for "${id}"`);
    }
  }
  const npcKeys = unique(pack.npcs.map(({ key }) => key), 'NPC key');
  unique(objects.map(({ id }) => id), 'object ID');
  unique(activities.map(({ id }) => id), 'activity ID');
  unique(occurrences.map(({ id }) => id), 'occurrence ID');
  unique(routes.map(({ from, to }) => JSON.stringify([from, to])), 'route');
  function requireLocation(location: string, subject: string) {
    if (!locations.has(location)) throw new Error(`WorldPack: unknown location "${location}" for ${subject}`);
  }
  for (const { from, to } of routes) {
    requireLocation(from, 'route origin');
    requireLocation(to, 'route destination');
  }
  for (const npc of pack.npcs) {
    requireLocation(npc.location, npc.key);
    if (npc.identity && npc.identity.key !== npc.key) throw new Error(`WorldPack: mismatched identity for ${npc.key}`);
    const { routine, nextRoutine } = npc.identity ?? {};
    for (const window of [routine, nextRoutine]) {
      if (window) requireLocation(window.location, `routine of ${npc.key}`);
    }
    if (nextRoutine && (!routine || !(nextRoutine.fromHour >= routine.untilHour) ||
        (nextRoutine.location !== routine.location && !routes.some(({ from, to, minutes, blocked }) =>
          from === routine.location && to === nextRoutine.location && !blocked && Number.isSafeInteger(minutes) && minutes > 0)))) {
      throw new Error(`WorldPack: incompatible follow-up routine of ${npc.key}`);
    }
  }
  for (const activity of activities) {
    requireLocation(activity.location, activity.id);
    if (!pack.npcs.some(({ name }) => name === activity.participant)) {
      throw new Error(`WorldPack: unknown participant for ${activity.id}`);
    }
  }
  for (const occurrence of occurrences) {
    requireLocation(occurrence.location, occurrence.id);
    const identity = pack.npcs.find(({ key }) => key === occurrence.npcKey)?.identity;
    const routine = occurrence.routine === 'next' ? identity?.nextRoutine : identity?.routine;
    if (routine?.location !== occurrence.location || !occurrence.narration.trim()) {
      throw new Error(`WorldPack: incompatible occurrence "${occurrence.id}"`);
    }
  }
  for (const object of objects) {
    requireLocation(object.location, object.id);
    if (object.condition && !activities.some(({ id, location }) =>
      id === object.condition?.activityId && location === object.location)) {
      throw new Error(`WorldPack: invalid activity for ${object.id}`);
    }
    if (object.condition?.knownBy?.some((key) => !npcKeys.has(key))) {
      throw new Error(`WorldPack: unknown knowledge holder for ${object.id}`);
    }
    const { storageId, delivery } = object.portable ?? {};
    if (storageId && !objects.some(({ id, openable, portable }) => id === storageId && openable && !portable)) {
      throw new Error(`WorldPack: invalid storage for ${object.id}`);
    }
    if (delivery) {
      requireLocation(delivery.location, `delivery of ${object.id}`);
      if (!npcKeys.has(delivery.recipientKey)) throw new Error(`WorldPack: unknown recipient for ${object.id}`);
    }
  }
  return pack;
}
