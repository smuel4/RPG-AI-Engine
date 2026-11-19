import { planTurn } from '../src/engine/turnPlanner';
import type { Campaign, NpcRecord } from '../src/types/game';

export function diagnoseCampaignTurn(action: string, campaign: Campaign, npcs: readonly NpcRecord[]) {
  const locations = new Set([campaign.currentLocation]);
  for (const npc of npcs) {
    if (npc.campaignId === campaign.id && npc.ownerId === campaign.ownerId && npc.location.trim()) {
      locations.add(npc.location);
    }
  }
  const result = planTurn(action, campaign, {
    places: [...locations].map((id) => ({
      id,
      aliases: id.split(/\s*[–—,]\s*/).slice(0, 1),
    })),
    routes: [],
  });
  return { mode: 'diagnostic' as const, result };
}
