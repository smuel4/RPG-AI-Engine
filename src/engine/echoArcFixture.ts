import { freixoWoodWorkshop } from './npcIdentity';
import type {
  Campaign,
  InventoryItem,
  NarrativeEntry,
  NpcRecord,
  GameEvent,
  WorldTime,
} from '../types/game';
import { ROOT_TIMELINE_ID, createSafeId, formatWorldTimeLabel } from './constants';

export interface CampaignSeedBundle {
  campaign: Omit<Campaign, 'createdAt' | 'updatedAt'>;
  inventory: Array<Omit<InventoryItem, 'createdAt' | 'updatedAt'>>;
  npcs: Array<Omit<NpcRecord, 'createdAt' | 'updatedAt'>>;
  narrative: Array<Omit<NarrativeEntry, 'createdAt'>>;
  events: Array<Omit<GameEvent, 'createdAt'>>;
}

export interface CustomCampaignDraft {
  name: string;
  setting: string;
  currentLocation: string;
  protagonistName: string;
  protagonistAge: number;
  protagonistOrigin: string;
  futureHook: string;
}

const INITIAL_ECHO_ARC_TIME: WorldTime = {
  year: 412,
  month: 3,
  day: 14,
  weekday: 'Lunis',
  season: 'Primavera',
  hour: 8,
  minute: 30,
  periodOfDay: 'Manhã',
};

export function createEchoArcBundle(ownerId: string): CampaignSeedBundle {
  const campaignId = createSafeId('echo_arc');
  const timeLabel = formatWorldTimeLabel(INITIAL_ECHO_ARC_TIME);

  const campaign: Omit<Campaign, 'createdAt' | 'updatedAt'> = {
    id: campaignId,
    ownerId,
    name: 'ECHO ARC',
    setting: 'Fantasia com magia, vilas, cidades e a Academia de Arvend',
    currentLocation: 'Vila de Freixo',
    status: 'active',
    revision: 1,
    lastSequence: 2,
    protagonist: {
      name: 'Samuel',
      age: 18,
      origin: 'Jovem adotado, inicialmente comum',
      futureHook: 'Futuro ligado à Academia de Arvend',
      vitality: 20,
      maxVitality: 20,
      focus: 12,
      maxFocus: 12,
      disposition: 'Atento e tranquilo',
    },
    currency: {
      gold: 0,
      silver: 2,
      copper: 15,
    },
    worldTime: INITIAL_ECHO_ARC_TIME,
    activeTimelineId: ROOT_TIMELINE_ID,
    timelineLineage: [
      {
        timelineId: ROOT_TIMELINE_ID,
        fromSequence: 0,
        toSequence: null,
      },
    ],
  };

  const inventory: Array<Omit<InventoryItem, 'createdAt' | 'updatedAt'>> = [
    {
      id: createSafeId('item'),
      ownerId,
      campaignId,
      name: 'Túnica Simples de Linho',
      category: 'equipamento',
      quantity: 1,
      description: 'Vestimenta comum de tecido resistente usada no cotidiano da Vila de Freixo.',
      equipable: true,
      equipped: true,
    },
    {
      id: createSafeId('item'),
      ownerId,
      campaignId,
      name: 'Diário de Anotações',
      category: 'documento',
      quantity: 1,
      description: 'Caderno de couro simples onde Samuel registra observações e recados.',
      equipable: false,
      equipped: false,
    },
    {
      id: createSafeId('item'),
      ownerId,
      campaignId,
      name: 'Cantil de Couro',
      category: 'recurso',
      quantity: 1,
      description: 'Cantil preenchido com água fresca do poço da vila.',
      equipable: false,
      equipped: false,
    },
    {
      id: createSafeId('item'),
      ownerId,
      campaignId,
      name: 'Pão de Centeio',
      category: 'consumivel',
      quantity: 2,
      description: 'Pães assados cedo na casa da família.',
      equipable: false,
      equipped: false,
    },
  ];

  const npcs: Array<Omit<NpcRecord, 'createdAt' | 'updatedAt'>> = [
    {
      id: createSafeId('npc'),
      ownerId,
      campaignId,
      name: 'Teresa',
      role: 'Mãe adotiva',
      location: 'Casa da Família · Vila de Freixo',
      relationship: 'Família (Confiança plena)',
      notes: 'Cuida do lar com serenidade e conhece as rotinas de toda a Vila de Freixo.',
    },
    {
      id: createSafeId('npc'),
      ownerId,
      campaignId,
      name: 'Henrique',
      role: 'Pai adotivo',
      location: freixoWoodWorkshop,
      relationship: 'Família (Confiança plena)',
      notes: 'Artesão respeitado na vila; ensinou a Samuel noções práticas de ofício e disciplina.',
    },
  ];

  const narrative: Array<Omit<NarrativeEntry, 'createdAt'>> = [
    {
      id: createSafeId('nar'),
      ownerId,
      campaignId,
      timelineId: ROOT_TIMELINE_ID,
      sequence: 1,
      authorRole: 'system_seed',
      worldTimeLabel: timeLabel,
      content:
        'A manhã avança com brisa amena sobre os telhados da Vila de Freixo. O cheiro de lenha recém-cortada vem da oficina de Henrique, enquanto Teresa organiza a mesa da cozinha para o início do dia. Samuel, aos 18 anos, encontra-se no pátio da casa com seus pertences cotidianos e o horizonte aberto diante de si — nenhum evento irreversível foi iniciado ainda.',
    },
  ];

  const events: Array<Omit<GameEvent, 'createdAt'>> = [
    {
      id: createSafeId('evt'),
      ownerId,
      campaignId,
      timelineId: ROOT_TIMELINE_ID,
      sequence: 2,
      type: 'CAMPAIGN_CREATED',
      summary: 'Campanha ECHO ARC criada com estado inicial estruturado.',
      actor: 'Sistema',
      beforeSummary: 'Sem estado anterior',
      afterSummary: 'Local: Vila de Freixo · Protagonista: Samuel (18 anos) · 4 itens iniciais',
      worldTimeLabel: timeLabel,
    },
  ];

  return { campaign, inventory, npcs, narrative, events };
}

export function createCustomCampaignBundle(
  ownerId: string,
  draft: CustomCampaignDraft,
): CampaignSeedBundle {
  const campaignId = createSafeId('camp');
  const initialTime: WorldTime = {
    year: 1,
    month: 1,
    day: 1,
    weekday: 'Solis',
    season: 'Primavera',
    hour: 9,
    minute: 0,
    periodOfDay: 'Manhã',
  };
  const timeLabel = formatWorldTimeLabel(initialTime);

  const campaign: Omit<Campaign, 'createdAt' | 'updatedAt'> = {
    id: campaignId,
    ownerId,
    name: draft.name.trim(),
    setting: draft.setting.trim(),
    currentLocation: draft.currentLocation.trim(),
    status: 'active',
    revision: 1,
    lastSequence: 2,
    protagonist: {
      name: draft.protagonistName.trim(),
      age: draft.protagonistAge,
      origin: draft.protagonistOrigin.trim(),
      futureHook: draft.futureHook.trim(),
      vitality: 20,
      maxVitality: 20,
      focus: 10,
      maxFocus: 10,
      disposition: 'Preparado',
    },
    currency: {
      gold: 0,
      silver: 1,
      copper: 10,
    },
    worldTime: initialTime,
    activeTimelineId: ROOT_TIMELINE_ID,
    timelineLineage: [
      {
        timelineId: ROOT_TIMELINE_ID,
        fromSequence: 0,
        toSequence: null,
      },
    ],
  };

  const narrative: Array<Omit<NarrativeEntry, 'createdAt'>> = [
    {
      id: createSafeId('nar'),
      ownerId,
      campaignId,
      timelineId: ROOT_TIMELINE_ID,
      sequence: 1,
      authorRole: 'system_seed',
      worldTimeLabel: timeLabel,
      content: `Ponto de partida registrado em ${campaign.currentLocation}. ${campaign.protagonist.name} inicia a jornada com estado estruturado pronto para suas decisões.`,
    },
  ];

  const events: Array<Omit<GameEvent, 'createdAt'>> = [
    {
      id: createSafeId('evt'),
      ownerId,
      campaignId,
      timelineId: ROOT_TIMELINE_ID,
      sequence: 2,
      type: 'CAMPAIGN_CREATED',
      summary: `Campanha "${campaign.name}" criada.`,
      actor: 'Sistema',
      beforeSummary: 'Sem estado anterior',
      afterSummary: `Local: ${campaign.currentLocation} · Protagonista: ${campaign.protagonist.name}`,
      worldTimeLabel: timeLabel,
    },
  ];

  return { campaign, inventory: [], npcs: [], narrative, events };
}
