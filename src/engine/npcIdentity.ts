import type { Campaign, NpcRecord } from '../types/game';

export const freixoWoodWorkshop = 'Oficina de Madeira · Vila de Freixo';

export interface NpcIdentity {
  key: string;
  temperament: string;
  voice: string;
  occupation: string;
  objective: string;
  appearance?: { portraitRef: string; recognizableTraits: string };
  routine?: { location: string; fromHour: number; untilHour: number; activity: string };
  knowledge: readonly NpcKnowledge[];
}

export type NpcKnowledge =
  | { source: 'public'; fact: string }
  | { source: 'personal' | 'observed' | 'conversation' | 'interpretation'; fact: string; knownBy: readonly string[] }
  | { source: 'player-private'; fact: string };

export function getNpcIdentity(campaign: Campaign, npc: NpcRecord): NpcIdentity | undefined {
  if (campaign.name !== 'ECHO ARC' ||
      (!campaign.id.startsWith('echo_arc_') && campaign.id !== 'echo-arc-server-pilot') ||
      npc.campaignId !== campaign.id || npc.ownerId !== campaign.ownerId) return undefined;
  return echoArcIdentities[npc.name + '|' + npc.role];
}

const echoArcIdentities: Record<string, NpcIdentity> = {
  'Teresa|Mãe adotiva': {
    key: 'echo-arc:teresa',
    temperament: 'Serena, atenta ao cotidiano.',
    voice: 'Tom familiar e tranquilo, com comentários concretos sobre o que está acontecendo.',
    occupation: 'Cuida do lar.',
    objective: 'Organizar a manhã da casa no seu próprio ritmo.',
    routine: { location: 'Casa da Família · Vila de Freixo', fromHour: 6, untilHour: 11,
      activity: 'Organizar a mesa e os afazeres da manhã.' },
    knowledge: [{ source: 'personal', fact: 'Conhece as rotinas da Vila de Freixo.', knownBy: ['echo-arc:teresa'] }],
  },
  'Henrique|Pai adotivo': {
    key: 'echo-arc:henrique',
    temperament: 'Prático, valoriza a disciplina no trabalho.',
    voice: 'Fala direta e familiar, com exemplos do ofício quando cabem na conversa.',
    occupation: 'Artesão de madeira.',
    objective: 'Dar andamento ao trabalho da oficina.',
    routine: { location: freixoWoodWorkshop, fromHour: 6, untilHour: 11,
      activity: 'Trabalhar a madeira na oficina.' },
    knowledge: [{ source: 'personal', fact: 'Ensinou a Samuel noções práticas de ofício e disciplina.',
      knownBy: ['echo-arc:henrique'] }],
  },
};

export function npcSceneProfiles(campaign: Campaign, npcs: readonly NpcRecord[],
  sceneKnowledge: readonly NpcKnowledge[] = []) {
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
        .filter((entry) => entry.source === 'public' || ('knownBy' in entry && entry.knownBy.includes(identity.key)))
        .map(({ source, fact }) => ({ source, fact })),
    }];
  });
}
