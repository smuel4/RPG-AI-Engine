import type {
  Campaign,
  InventoryItem,
  NarrativeEntry,
  NpcRecord,
} from '../src/types/game';
import { formatWorldTimeLabel, ROOT_TIMELINE_ID } from '../src/engine/constants';
import { classifyNarrativeEntriesForAudit } from '../src/engine/rulesEngine';
import { npcSceneProfiles, type NpcKnowledge } from '../src/engine/npcIdentity';
import type { recallNpcMemories } from '../src/engine/npcMemory';
import type { relationshipsInScene } from '../src/engine/npcRelationship';

export interface NarratorMemoryInput {
  publicOnly?: boolean;
  campaign: Campaign;
  inventory: InventoryItem[];
  npcs: NpcRecord[];
  narrative: NarrativeEntry[];
  settlement?: string;
  sceneKnowledge?: readonly NpcKnowledge[];
  npcActivities?: readonly { name: string; activity: string }[];
  npcMemories?: ReturnType<typeof recallNpcMemories>;
  npcRelationships?: ReturnType<typeof relationshipsInScene>;
}

const HISTORY_MAX_ENTRIES = 16;
const HISTORY_MAX_CONTENT_LENGTH = 8_000;

function recentCompleteEntries(entries: NarrativeEntry[]): NarrativeEntry[] {
  let first = entries.length;
  let remaining = HISTORY_MAX_CONTENT_LENGTH;
  while (first > 0) {
    const last = entries[first - 1];
    const previous = entries[first - 2];
    const paired = last.authorRole === 'engine_response' && previous?.authorRole === 'player_action' &&
      previous.sequence + 1 === last.sequence &&
      (previous.timelineId || ROOT_TIMELINE_ID) === (last.timelineId || ROOT_TIMELINE_ID);
    const count = paired ? 2 : 1;
    const length = last.content.length + (paired ? previous.content.length : 0);
    if (length > remaining || entries.length - first + count > HISTORY_MAX_ENTRIES) break;
    remaining -= length;
    first -= count;
  }
  return entries.slice(first);
}

export function buildNarratorContext(input: NarratorMemoryInput) {
  const { campaign, inventory, npcs, narrative } = input;

  const campaignEntries = narrative.filter(
    (entry) =>
      entry.campaignId === campaign.id &&
      entry.ownerId === campaign.ownerId &&
      entry.sequence <= campaign.lastSequence && (!input.publicOnly || entry.privateRecipientId === undefined),
  );

  const activeEntries = classifyNarrativeEntriesForAudit(
    campaign,
    campaignEntries,
  ).active
    .filter(
      (entry) =>
        !(
          entry.authorRole === 'engine_response' &&
          entry.content.startsWith('[Narrativa fixa de teste')
        ),
    )
    .sort((a, b) => a.sequence - b.sequence);
  const activeHistory = recentCompleteEntries(activeEntries).map((entry) => ({
    sequence: entry.sequence,
    author: entry.authorRole,
    content: entry.content,
    time: entry.worldTimeLabel,
  }));

  const npcRecords = npcs
    .filter(
      (npc) =>
        npc.campaignId === campaign.id &&
        npc.ownerId === campaign.ownerId,
    )
    .slice(0, 30);
  const campaignNpcs = npcRecords.map((npc) => ({
      name: npc.name,
      role: npc.role,
      relationship: npc.relationship,
      location: npc.location,
      notes: npc.notes.slice(0, 800),
    }));

  const campaignInventory = inventory
    .filter(
      (item) =>
        item.campaignId === campaign.id &&
        item.ownerId === campaign.ownerId,
    )
    .slice(0, 40)
    .map((item) => ({
      name: item.name,
      quantity: item.quantity,
      description: item.description.slice(0, 300),
      equipped: item.equipped,
    }));

  const { name, age, origin, futureHook, ...protagonistState } = campaign.protagonist;
  return {
    establishedRecords: {
      campaignName: campaign.name,
      setting: campaign.setting,
      protagonist: { name, age, origin },
      npcs: campaignNpcs.map(({ location, ...record }) => record),
    },
    currentState: {
      location: campaign.currentLocation,
      settlement: input.settlement,
      worldTime: campaign.worldTime,
      calendarLabel: formatWorldTimeLabel(campaign.worldTime),
      activeTimelineId: campaign.activeTimelineId || ROOT_TIMELINE_ID,
      protagonist: protagonistState,
      knownPresentNpcs: campaignNpcs.filter(({ location }) => location === campaign.currentLocation).map(({ name }) => name),
      npcSceneProfiles: npcSceneProfiles(campaign, npcRecords, input.sceneKnowledge, input.publicOnly),
      ...(input.npcActivities?.length ? { confirmedNpcActivities: input.npcActivities } : {}),
      ...(!input.publicOnly && input.npcMemories?.length ? { privateNpcMemories: input.npcMemories } : {}),
      ...(!input.publicOnly && input.npcRelationships?.length ? { privateNpcRelationships: input.npcRelationships } : {}),
      npcLocations: campaignNpcs.map(({ name, location }) => ({ name, location })),
      inventory: campaignInventory,
    },
    recentActiveHistory: activeHistory,
    futureHooks: futureHook ? [futureHook] : [],
  };
}

export type NarratorContext = ReturnType<typeof buildNarratorContext>;
