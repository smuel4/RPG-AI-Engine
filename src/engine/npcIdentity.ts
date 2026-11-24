import type { Campaign, NpcRecord } from '../types/game';

import { echoArcIdentities, freixoWorldPack } from '../world/freixo';
export { freixoWoodWorkshop, freixoFamilyYard, freixoFamilyKitchen } from '../world/freixo';
import type { NpcIdentity, NpcKnowledge } from '../world/worldPack';
export type { NpcIdentity, NpcKnowledge } from '../world/worldPack';

export function getNpcIdentity(campaign: Campaign, npc: NpcRecord): NpcIdentity | undefined {
  if (campaign.name !== 'ECHO ARC' ||
      (!campaign.id.startsWith('echo_arc_') && campaign.id !== 'echo-arc-server-pilot') ||
      npc.campaignId !== campaign.id || npc.ownerId !== campaign.ownerId) return undefined;
  const identity = echoArcIdentities[npc.name + '|' + npc.role];
  if (campaign.id === 'echo-arc-server-pilot' && identity) {
    return freixoWorldPack.npcs.find(({ key }) => key === identity.key)?.identity ?? identity;
  }
  return identity;
}

export function npcSceneProfiles(campaign: Campaign, npcs: readonly NpcRecord[],
  sceneKnowledge: readonly NpcKnowledge[] = [], publicOnly = false) {
  return npcs.flatMap((npc) => {
    if (npc.location !== campaign.currentLocation) return [];
    const identity = getNpcIdentity(campaign, npc);
    if (!identity) return [];
    const { routine, knowledge, appearance, ...profile } = identity;
    const hour = campaign.worldTime.hour;
    const activity = routine && routine.location === npc.location &&
      hour >= routine.fromHour && hour < routine.untilHour ? routine.activity : undefined;
    return [{
      ...profile,
      name: npc.name,
      appearance: appearance?.recognizableTraits,
      suggestedActivity: activity,
      knowledge: [...knowledge, ...sceneKnowledge]
        .filter((entry) => entry.source === 'public' || (!publicOnly && 'knownBy' in entry && entry.knownBy.includes(identity.key)))
        .map(({ source, fact }) => ({ source, fact })),
    }];
  });
}
