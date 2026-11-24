import type { NpcRecord } from '../types/game';

import { freixoLira } from '../world/freixo';
export { villageWell } from '../world/freixo';

export function createWellEncounterNpc(ownerId: string, campaignId: string): NpcRecord {
  return {
    ownerId, campaignId,
    id: freixoLira.key,
    name: freixoLira.name,
    role: 'Moradora de Freixo',
    relationship: 'Primeiro encontro',
    location: freixoLira.location,
    notes: 'Presença no poço prevista para esta sessão local.',
  };
}
