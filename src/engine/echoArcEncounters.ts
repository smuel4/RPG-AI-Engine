import type { NpcRecord } from '../types/game';

export const villageWell = 'Poço da Vila de Freixo';

export function createWellEncounterNpc(ownerId: string, campaignId: string): NpcRecord {
  return {
    ownerId, campaignId,
    id: 'freixo-local-lira',
    name: 'Lira',
    role: 'Moradora de Freixo',
    relationship: 'Primeiro encontro',
    location: villageWell,
    notes: 'Presença no poço prevista para esta sessão local.',
  };
}
