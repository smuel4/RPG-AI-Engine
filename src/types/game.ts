export type CampaignStatus = 'active' | 'archived';

export type InventoryCategory =
  | 'equipamento'
  | 'consumivel'
  | 'documento'
  | 'recurso'
  | 'chave';

export type NarrativeAuthorRole =
  | 'system_seed'
  | 'player_action'
  | 'engine_response';

export type GameEventType =
  | 'CAMPAIGN_CREATED'
  | 'PLAYER_ACTION'
  | 'INVENTORY_ADDED'
  | 'INVENTORY_UPDATED'
  | 'INVENTORY_REMOVED'
  | 'CURRENCY_UPDATED'
  | 'TIME_ADVANCED'
  | 'CHECKPOINT_SAVED'
  | 'CHECKPOINT_LOADED';

export interface Protagonist {
  name: string;
  age: number;
  origin: string;
  futureHook: string;
  vitality: number;
  maxVitality: number;
  focus: number;
  maxFocus: number;
  disposition: string;
}

export interface Currency {
  gold: number;
  silver: number;
  copper: number;
}

export interface WorldTime {
  year: number;
  month: number;
  day: number;
  weekday: string;
  season: string;
  hour: number;
  minute: number;
  periodOfDay: string;
}

export interface TimelineSegment {
  timelineId: string;
  fromSequence: number;
  toSequence: number | null;
}

export type TimelineAuditStatus = 'active' | 'alternate_timeline';

export interface Campaign {
  id: string;
  ownerId: string;
  name: string;
  setting: string;
  currentLocation: string;
  status: CampaignStatus;
  revision: number;
  lastSequence: number;
  protagonist: Protagonist;
  currency: Currency;
  worldTime: WorldTime;
  activeTimelineId?: string;
  timelineLineage?: TimelineSegment[];
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface InventoryItem {
  id: string;
  ownerId: string;
  campaignId: string;
  name: string;
  category: InventoryCategory;
  quantity: number;
  description: string;
  equipable: boolean;
  equipped: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface NpcRecord {
  id: string;
  ownerId: string;
  campaignId: string;
  name: string;
  role: string;
  location: string;
  relationship: string;
  notes: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface PilotFocus {
  kind: 'npc' | 'object' | 'place';
  id: string;
}

export interface NarrativeEntry {
  id: string;
  ownerId: string;
  campaignId: string;
  timelineId?: string;
  sequence: number;
  authorRole: NarrativeAuthorRole;
  content: string;
  worldTimeLabel: string;
  privateRecipientId?: string;
  pilotFocus?: PilotFocus[];
  createdAt?: unknown;
}

export interface GameEvent {
  id: string;
  ownerId: string;
  campaignId: string;
  timelineId?: string;
  sequence: number;
  type: GameEventType;
  summary: string;
  actor: string;
  beforeSummary: string;
  afterSummary: string;
  worldTimeLabel: string;
  createdAt?: unknown;
}

export interface InventorySnapshotItem {
  id: string;
  name: string;
  category: InventoryCategory;
  quantity: number;
  description: string;
  equipable: boolean;
  equipped: boolean;
}

export interface NpcSnapshotItem {
  id: string;
  name: string;
  role: string;
  location: string;
  relationship: string;
  notes: string;
}

export interface Checkpoint {
  id: string;
  ownerId: string;
  campaignId: string;
  label: string;
  note: string;
  revision: number;
  lastSequence: number;
  timelineId?: string;
  narrativeCutoffSequence?: number;
  timelineLineageSnapshot?: TimelineSegment[];
  currentLocation: string;
  protagonist: Protagonist;
  currency: Currency;
  worldTime: WorldTime;
  inventorySnapshot: InventorySnapshotItem[];
  npcsSnapshot: NpcSnapshotItem[];
  createdAt?: unknown;
}

export type SyncState = 'idle' | 'saving' | 'synced' | 'error';

export interface PersistenceErrorState {
  title: string;
  message: string;
  code?: string;
  retryable: boolean;
}

export type RuleResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface PilotScene {
  revision: number;
  timelineId: string;
  location: string;
  exits: { id: string; label: string }[];
  people: { id: string; name: string; available: boolean }[];
  landmarks: { id: string; name: string }[];
}
