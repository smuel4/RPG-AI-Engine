import type { NpcRecord } from '../types/game';

export interface CharacterRelationship {
  from: string;
  toward: string;
  timelineId: string;
  bond: 'family' | 'friendship' | 'unspecified';
  familiarity: number;
  trust: number;
  respect: number;
  rapport: number;
  disclosure?: { turnId: string; sequence: number };
  firstEncounter?: { turnId: string; sequence: number };
}

export const PLAYER_CHARACTER_ID = 'player';

export function recordFirstEncounters(saved: readonly CharacterRelationship[], present: readonly NpcRecord[],
  origin: { timelineId: string; turnId: string; sequence: number }): readonly CharacterRelationship[] {
  const additions = present.flatMap((npc) => {
    if (saved.some((entry) => entry.from === npc.id && entry.toward === PLAYER_CHARACTER_ID &&
      entry.timelineId === origin.timelineId)) return [];
    const baseline = initialRelationship(npc, PLAYER_CHARACTER_ID, origin.timelineId);
    // Only explicit first-encounter records authorize this milestone.
    if (!/^primeiro encontro$/iu.test(npc.relationship.trim()) || baseline.bond !== 'unspecified') return [];
    return [{ ...baseline, familiarity: 1, firstEncounter: { turnId: origin.turnId, sequence: origin.sequence } }];
  });
  return additions.length ? [...saved, ...additions] : saved;
}

export function initialRelationship(from: NpcRecord, toward: string, timelineId: string): CharacterRelationship {
  const label = toward === PLAYER_CHARACTER_ID
    ? from.relationship.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase() : '';
  const bond = /\bfamilia\b/.test(label) ? 'family' : /\b(?:amizade|amig[oa])\b/.test(label) ? 'friendship' : 'unspecified';
  return {
    from: from.id, toward, timelineId, bond,
    familiarity: bond === 'family' ? 3 : bond === 'friendship' ? 2 : 0,
    trust: label.includes('confianca plena') ? 4 : 0,
    respect: 0,
    rapport: bond === 'friendship' ? 2 : 0,
  };
}

// Only the first explicit personal disclosure per direction can affect familiarity.
export function recordPersonalDisclosure(saved: readonly CharacterRelationship[], listener: NpcRecord,
  speakerId: string, origin: { timelineId: string; turnId: string; sequence: number }): readonly CharacterRelationship[] {
  if (listener.id === speakerId) return saved;
  const current = saved.find((item) => item.from === listener.id && item.toward === speakerId &&
    item.timelineId === origin.timelineId);
  const baseline = current ?? initialRelationship(listener, speakerId, origin.timelineId);
  if (baseline.disclosure || baseline.familiarity >= 4) return saved;
  const next = { ...baseline, familiarity: baseline.familiarity + 1,
    disclosure: { turnId: origin.turnId, sequence: origin.sequence } };
  return [...saved.filter((item) => item !== current), next];
}

export function relationshipsInScene(present: readonly NpcRecord[], timelineId: string,
  saved: readonly CharacterRelationship[]) {
  const visible = new Map(present.map((npc) => [npc.id, npc]));
  const active = saved.filter((entry) => entry.timelineId === timelineId && visible.has(entry.from) &&
    (entry.toward === PLAYER_CHARACTER_ID || visible.has(entry.toward)));
  return present.slice(0, 6).flatMap((npc) => {
    const towardPlayer = active.find((entry) => entry.from === npc.id && entry.toward === PLAYER_CHARACTER_ID) ??
      initialRelationship(npc, PLAYER_CHARACTER_ID, timelineId);
    return [towardPlayer, ...active.filter((entry) => entry.from === npc.id && entry.toward !== PLAYER_CHARACTER_ID).slice(0, 3)]
      .filter((entry) => entry.bond !== 'unspecified' || entry.disclosure || entry.familiarity || entry.trust || entry.respect || entry.rapport)
      .map((entry) => ({
        character: npc.name,
        toward: entry.toward === PLAYER_CHARACTER_ID ? 'protagonista' : visible.get(entry.toward)!.name,
        bond: entry.bond,
        familiarity: ['pouca', 'inicial', 'regular', 'alta', 'muito alta'][entry.familiarity],
        ...(entry.trust ? { trust: entry.trust >= 4 ? 'plena' : entry.trust < 0 ? 'abalada' : 'presente' } : {}),
        ...(entry.respect ? { respect: entry.respect < 0 ? 'abalado' : 'presente' } : {}),
        ...(entry.rapport ? { rapport: entry.rapport < 0 ? 'tensão' : 'afinidade' } : {}),
      }));
  });
}
