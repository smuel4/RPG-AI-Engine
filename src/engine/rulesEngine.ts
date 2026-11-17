import type {
  Campaign,
  Checkpoint,
  Currency,
  GameEvent,
  InventoryCategory,
  InventoryItem,
  InventorySnapshotItem,
  NarrativeEntry,
  NpcRecord,
  NpcSnapshotItem,
  RuleResult,
  TimelineAuditStatus,
  TimelineSegment,
  WorldTime,
} from '../types/game';
import {
  ID_PATTERN,
  LIMITS,
  ROOT_TIMELINE_ID,
  WORLD_MONTHS,
  WORLD_SEASONS,
  WORLD_WEEKDAYS,
  clampText,
  createSafeId,
  formatWorldClock,
  formatWorldTimeLabel,
} from './constants';
import { defaultNarratorAdapter } from './narratorPort';
import type { CustomCampaignDraft } from './echoArcFixture';

export interface PlayerActionResult {
  nextWorldTime: WorldTime;
  nextRevision: number;
  nextLastSequence: number;
  playerEntry: Omit<NarrativeEntry, 'createdAt'>;
  engineEntry: Omit<NarrativeEntry, 'createdAt'>;
  event: Omit<GameEvent, 'createdAt'>;
}

export type InventoryMutationCommand =
  | {
      kind: 'add';
      name: string;
      category: InventoryCategory;
      quantity: number;
      description: string;
      equipable: boolean;
    }
  | {
      kind: 'set_quantity';
      itemId: string;
      quantity: number;
    }
  | {
      kind: 'toggle_equipped';
      itemId: string;
    }
  | {
      kind: 'remove';
      itemId: string;
    };

export interface InventoryMutationResult {
  kind: 'create' | 'update' | 'delete';
  item: Omit<InventoryItem, 'createdAt' | 'updatedAt'>;
  nextRevision: number;
  nextLastSequence: number;
  event: Omit<GameEvent, 'createdAt'>;
}

export interface CurrencyMutationResult {
  nextCurrency: Currency;
  nextRevision: number;
  nextLastSequence: number;
  event: Omit<GameEvent, 'createdAt'>;
}

export interface TimeAdvanceResult {
  nextWorldTime: WorldTime;
  nextRevision: number;
  nextLastSequence: number;
  event: Omit<GameEvent, 'createdAt'>;
}

export interface AuditClassification<T extends { id: string }> {
  active: T[];
  superseded: T[];
  statusById: Record<string, TimelineAuditStatus>;
}

export interface CheckpointRestorePlan {
  campaignId: string;
  ownerId: string;
  checkpointId: string;
  expectedRevision: number;
  nextRevision: number;
  nextLastSequence: number;
  nextTimelineId: string;
  nextTimelineLineage: TimelineSegment[];
  restoredState: {
    protagonist: Campaign['protagonist'];
    currency: Campaign['currency'];
    worldTime: Campaign['worldTime'];
    currentLocation: string;
  };
  inventoryDeletes: string[];
  inventoryUpdates: InventorySnapshotItem[];
  inventoryCreates: Array<Omit<InventoryItem, 'createdAt' | 'updatedAt'>>;
  npcDeletes: string[];
  npcUpdates: NpcSnapshotItem[];
  npcCreates: Array<Omit<NpcRecord, 'createdAt' | 'updatedAt'>>;
  narrativeEntry: Omit<NarrativeEntry, 'createdAt'>;
  event: Omit<GameEvent, 'createdAt'>;
  totalSubcollectionOps: number;
}

export function getActiveTimelineId(campaign: Pick<Campaign, 'activeTimelineId'>): string {
  return campaign.activeTimelineId && ID_PATTERN.test(campaign.activeTimelineId)
    ? campaign.activeTimelineId
    : ROOT_TIMELINE_ID;
}

export function getCampaignTimelineLineage(
  campaign: Pick<Campaign, 'activeTimelineId' | 'timelineLineage'>,
): TimelineSegment[] {
  if (Array.isArray(campaign.timelineLineage) && campaign.timelineLineage.length > 0) {
    return campaign.timelineLineage.map((seg) => ({
      timelineId: seg.timelineId || ROOT_TIMELINE_ID,
      fromSequence: seg.fromSequence,
      toSequence: seg.toSequence,
    }));
  }

  return [
    {
      timelineId: getActiveTimelineId(campaign),
      fromSequence: 0,
      toSequence: null,
    },
  ];
}

export function getCheckpointTimelineLineage(
  checkpoint: Pick<
    Checkpoint,
    'timelineId' | 'narrativeCutoffSequence' | 'lastSequence' | 'timelineLineageSnapshot'
  >,
): TimelineSegment[] {
  if (
    Array.isArray(checkpoint.timelineLineageSnapshot) &&
    checkpoint.timelineLineageSnapshot.length > 0
  ) {
    return checkpoint.timelineLineageSnapshot.map((seg, idx, arr) => {
      const fallbackCutoff = checkpoint.narrativeCutoffSequence ?? checkpoint.lastSequence;
      const toSeq =
        seg.toSequence !== null
          ? seg.toSequence
          : idx === arr.length - 1
            ? Math.max(seg.fromSequence, fallbackCutoff)
            : seg.fromSequence;
      return {
        timelineId: seg.timelineId || ROOT_TIMELINE_ID,
        fromSequence: seg.fromSequence,
        toSequence: toSeq,
      };
    });
  }

  const cutoff = checkpoint.narrativeCutoffSequence ?? checkpoint.lastSequence;
  return [
    {
      timelineId: checkpoint.timelineId || ROOT_TIMELINE_ID,
      fromSequence: 0,
      toSequence: cutoff,
    },
  ];
}

export function isSequenceInTimelineLineage(
  timelineId: string | undefined,
  sequence: number,
  lineage: TimelineSegment[],
): boolean {
  const normalizedTimeline = timelineId || ROOT_TIMELINE_ID;
  return lineage.some(
    (seg) =>
      seg.timelineId === normalizedTimeline &&
      sequence >= seg.fromSequence &&
      (seg.toSequence === null || sequence <= seg.toSequence),
  );
}

export function classifyNarrativeEntriesForAudit(
  campaign: Pick<Campaign, 'activeTimelineId' | 'timelineLineage'>,
  entries: NarrativeEntry[],
): AuditClassification<NarrativeEntry> {
  const lineage = getCampaignTimelineLineage(campaign);
  const active: NarrativeEntry[] = [];
  const superseded: NarrativeEntry[] = [];
  const statusById: Record<string, TimelineAuditStatus> = {};

  for (const entry of entries) {
    const inActiveLine = isSequenceInTimelineLineage(entry.timelineId, entry.sequence, lineage);
    if (inActiveLine) {
      active.push(entry);
      statusById[entry.id] = 'active';
    } else {
      superseded.push(entry);
      statusById[entry.id] = 'alternate_timeline';
    }
  }

  return { active, superseded, statusById };
}

export function classifyEventsForAudit(
  campaign: Pick<Campaign, 'activeTimelineId' | 'timelineLineage'>,
  events: GameEvent[],
): AuditClassification<GameEvent> {
  const lineage = getCampaignTimelineLineage(campaign);
  const active: GameEvent[] = [];
  const superseded: GameEvent[] = [];
  const statusById: Record<string, TimelineAuditStatus> = {};

  for (const evt of events) {
    const inActiveLine = isSequenceInTimelineLineage(evt.timelineId, evt.sequence, lineage);
    if (inActiveLine) {
      active.push(evt);
      statusById[evt.id] = 'active';
    } else {
      superseded.push(evt);
      statusById[evt.id] = 'alternate_timeline';
    }
  }

  return { active, superseded, statusById };
}

function getPeriodOfDay(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Manhã';
  if (hour >= 12 && hour < 18) return 'Tarde';
  if (hour >= 18 && hour < 22) return 'Noite';
  return 'Madrugada';
}

export function advanceWorldTime(current: WorldTime, minutesToAdd: number): WorldTime {
  const totalMinutes = current.hour * 60 + current.minute + minutesToAdd;
  const dayOffset = Math.floor(totalMinutes / 1440);
  const normalizedMinutes = ((totalMinutes % 1440) + 1440) % 1440;
  const hour = Math.floor(normalizedMinutes / 60);
  const minute = normalizedMinutes % 60;

  let day = current.day + dayOffset;
  let month = current.month;
  let year = current.year;

  while (day > 30) {
    day -= 30;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  const totalDaysElapsed = (year - 1) * 360 + (month - 1) * 30 + (day - 1);
  const weekday = WORLD_WEEKDAYS[totalDaysElapsed % WORLD_WEEKDAYS.length];
  const season = WORLD_SEASONS[month - 1] ?? current.season;

  return {
    year,
    month,
    day,
    weekday,
    season,
    hour,
    minute,
    periodOfDay: getPeriodOfDay(hour),
  };
}

export function validateCustomCampaignDraft(
  draft: CustomCampaignDraft,
): RuleResult<CustomCampaignDraft> {
  const name = draft.name.trim();
  const setting = draft.setting.trim();
  const currentLocation = draft.currentLocation.trim();
  const protagonistName = draft.protagonistName.trim();
  const protagonistOrigin = draft.protagonistOrigin.trim();
  const futureHook = draft.futureHook.trim();

  if (name.length < 2 || name.length > LIMITS.NAME_MAX) {
    return { ok: false, error: `O nome da campanha deve ter entre 2 e ${LIMITS.NAME_MAX} caracteres.` };
  }
  if (setting.length < 3 || setting.length > LIMITS.SETTING_MAX) {
    return { ok: false, error: `A ambientação deve ter entre 3 e ${LIMITS.SETTING_MAX} caracteres.` };
  }
  if (currentLocation.length < 2 || currentLocation.length > LIMITS.LOCATION_MAX) {
    return { ok: false, error: `O local inicial deve ter entre 2 e ${LIMITS.LOCATION_MAX} caracteres.` };
  }
  if (protagonistName.length < 2 || protagonistName.length > LIMITS.NAME_MAX) {
    return { ok: false, error: `O nome do protagonista deve ter entre 2 e ${LIMITS.NAME_MAX} caracteres.` };
  }
  if (!Number.isInteger(draft.protagonistAge) || draft.protagonistAge < 1 || draft.protagonistAge > 200) {
    return { ok: false, error: 'A idade do protagonista deve ser um número inteiro entre 1 e 200.' };
  }
  if (protagonistOrigin.length < 2 || protagonistOrigin.length > LIMITS.SETTING_MAX) {
    return { ok: false, error: 'A origem do protagonista é obrigatória.' };
  }

  return {
    ok: true,
    data: {
      name,
      setting,
      currentLocation,
      protagonistName,
      protagonistAge: draft.protagonistAge,
      protagonistOrigin,
      futureHook: futureHook.slice(0, LIMITS.SETTING_MAX),
    },
  };
}

export function processPlayerAction(
  campaign: Campaign,
  inventory: InventoryItem[],
  npcs: NpcRecord[],
  rawAction: string,
  advanceMinutes = 10,
): RuleResult<PlayerActionResult> {
  if (campaign.status === 'archived') {
    return {
      ok: false,
      error: 'Campanha arquivada não aceita novas ações. Crie ou carregue uma campanha ativa.',
    };
  }

  const trimmed = rawAction.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: 'Ação inválida: descreva a decisão do protagonista antes de enviar.',
    };
  }

  if (trimmed.length > 800) {
    return {
      ok: false,
      error: 'Ação inválida: o texto excede o limite de 800 caracteres para uma única ação.',
    };
  }

  if (!Number.isInteger(advanceMinutes) || advanceMinutes < 0 || advanceMinutes > 720) {
    return {
      ok: false,
      error: 'Ação inválida: o avanço de tempo da ação deve estar entre 0 e 720 minutos.',
    };
  }

  // Regra fundamental: bloquear tentativas de comando direto para forjar moedas/itens sem passar pelas regras
  if (/^\/(dar|set|hack|forjar|gold|ouro)\b/i.test(trimmed)) {
    return {
      ok: false,
      error:
        'Ação bloqueada pelo motor de regras: alterações de moedas ou inventário devem passar pelos controles estruturados validados.',
    };
  }

  const prevTimeLabel = formatWorldClock(campaign.worldTime);
  const nextWorldTime = advanceWorldTime(campaign.worldTime, advanceMinutes);
  const nextTimeLabel = formatWorldTimeLabel(nextWorldTime);
  const timelineId = getActiveTimelineId(campaign);

  const playerSeq = campaign.lastSequence + 1;
  const engineSeq = campaign.lastSequence + 2;
  const eventSeq = campaign.lastSequence + 3;

  const updatedCampaignSnapshot: Campaign = {
    ...campaign,
    worldTime: nextWorldTime,
  };

  const responseText = defaultNarratorAdapter.respondToPlayerAction({
    campaign: updatedCampaignSnapshot,
    inventory,
    npcs,
    declaredAction: trimmed,
  });

  return {
    ok: true,
    data: {
      nextWorldTime,
      nextRevision: campaign.revision + 1,
      nextLastSequence: eventSeq,
      playerEntry: {
        id: createSafeId('nar'),
        ownerId: campaign.ownerId,
        campaignId: campaign.id,
        timelineId,
        sequence: playerSeq,
        authorRole: 'player_action',
        content: trimmed,
        worldTimeLabel: nextTimeLabel,
      },
      engineEntry: {
        id: createSafeId('nar'),
        ownerId: campaign.ownerId,
        campaignId: campaign.id,
        timelineId,
        sequence: engineSeq,
        authorRole: 'engine_response',
        content: responseText,
        worldTimeLabel: nextTimeLabel,
      },
      event: {
        id: createSafeId('evt'),
        ownerId: campaign.ownerId,
        campaignId: campaign.id,
        timelineId,
        sequence: eventSeq,
        type: 'PLAYER_ACTION',
        summary: clampText(`Ação de ${campaign.protagonist.name}: ${trimmed}`, LIMITS.SUMMARY_MAX),
        actor: campaign.protagonist.name,
        beforeSummary: `Horário: ${prevTimeLabel} · Local: ${campaign.currentLocation}`,
        afterSummary: `Horário: ${formatWorldClock(nextWorldTime)} · Ação confirmada e registrada`,
        worldTimeLabel: nextTimeLabel,
      },
    },
  };
}

export function processInventoryMutation(
  campaign: Campaign,
  currentInventory: InventoryItem[],
  command: InventoryMutationCommand,
): RuleResult<InventoryMutationResult> {
  if (campaign.status === 'archived') {
    return {
      ok: false,
      error: 'Campanha arquivada: o inventário está bloqueado para alterações.',
    };
  }

  const timeLabel = formatWorldTimeLabel(campaign.worldTime);
  const timelineId = getActiveTimelineId(campaign);
  const nextSeq = campaign.lastSequence + 1;
  const nextRev = campaign.revision + 1;

  if (command.kind === 'add') {
    if (currentInventory.length >= LIMITS.MAX_INVENTORY_ITEMS) {
      return {
        ok: false,
        error: `Limite estrutural atingido (${LIMITS.MAX_INVENTORY_ITEMS} tipos de itens por campanha).`,
      };
    }

    const name = command.name.trim();
    const description = command.description.trim();

    if (name.length < 1 || name.length > LIMITS.NAME_MAX) {
      return {
        ok: false,
        error: `Nome do item inválido (1 a ${LIMITS.NAME_MAX} caracteres).`,
      };
    }

    if (!Number.isInteger(command.quantity) || command.quantity < 1 || command.quantity > LIMITS.MAX_QUANTITY) {
      return {
        ok: false,
        error: `Quantidade inválida: informe um inteiro entre 1 e ${LIMITS.MAX_QUANTITY}.`,
      };
    }

    if (description.length > LIMITS.DESCRIPTION_MAX) {
      return {
        ok: false,
        error: `Descrição excede ${LIMITS.DESCRIPTION_MAX} caracteres.`,
      };
    }

    const duplicate = currentInventory.find(
      (i) => i.name.toLowerCase() === name.toLowerCase() && i.category === command.category,
    );
    if (duplicate) {
      const updatedQty = duplicate.quantity + command.quantity;
      if (updatedQty > LIMITS.MAX_QUANTITY) {
        return { ok: false, error: 'A soma ultrapassa a quantidade máxima permitida para o item.' };
      }

      const updatedItem: Omit<InventoryItem, 'createdAt' | 'updatedAt'> = {
        id: duplicate.id,
        ownerId: duplicate.ownerId,
        campaignId: duplicate.campaignId,
        name: duplicate.name,
        category: duplicate.category,
        quantity: updatedQty,
        description: description || duplicate.description,
        equipable: duplicate.equipable,
        equipped: duplicate.equipped,
      };

      return {
        ok: true,
        data: {
          kind: 'update',
          item: updatedItem,
          nextRevision: nextRev,
          nextLastSequence: nextSeq,
          event: {
            id: createSafeId('evt'),
            ownerId: campaign.ownerId,
            campaignId: campaign.id,
            timelineId,
            sequence: nextSeq,
            type: 'INVENTORY_UPDATED',
            summary: clampText(`Quantidade de "${duplicate.name}" somada.`, LIMITS.SUMMARY_MAX),
            actor: 'Jogador',
            beforeSummary: `${duplicate.name}: ${duplicate.quantity} un.`,
            afterSummary: `${duplicate.name}: ${updatedQty} un.`,
            worldTimeLabel: timeLabel,
          },
        },
      };
    }

    const newItem: Omit<InventoryItem, 'createdAt' | 'updatedAt'> = {
      id: createSafeId('item'),
      ownerId: campaign.ownerId,
      campaignId: campaign.id,
      name,
      category: command.category,
      quantity: command.quantity,
      description,
      equipable: command.equipable,
      equipped: false,
    };

    return {
      ok: true,
      data: {
        kind: 'create',
        item: newItem,
        nextRevision: nextRev,
        nextLastSequence: nextSeq,
        event: {
          id: createSafeId('evt'),
          ownerId: campaign.ownerId,
          campaignId: campaign.id,
          timelineId,
          sequence: nextSeq,
          type: 'INVENTORY_ADDED',
          summary: clampText(`Item adicionado: ${name} (${command.quantity}x).`, LIMITS.SUMMARY_MAX),
          actor: 'Jogador',
          beforeSummary: 'Item ausente no inventário',
          afterSummary: `${name} · ${command.quantity} un. (${command.category})`,
          worldTimeLabel: timeLabel,
        },
      },
    };
  }

  const target = currentInventory.find((i) => i.id === command.itemId);
  if (!target) {
    return {
      ok: false,
      error: 'Item não encontrado no estado estruturado atual do inventário.',
    };
  }

  if (command.kind === 'set_quantity') {
    if (!Number.isInteger(command.quantity) || command.quantity < 0 || command.quantity > LIMITS.MAX_QUANTITY) {
      return {
        ok: false,
        error: `Quantidade inválida: não é permitido definir valores negativos ou acima de ${LIMITS.MAX_QUANTITY}.`,
      };
    }

    if (command.quantity === target.quantity) {
      return {
        ok: false,
        error: 'Nenhuma alteração detectada na quantidade do item.',
      };
    }

    if (command.quantity === 0) {
      return {
        ok: true,
        data: {
          kind: 'delete',
          item: {
            id: target.id,
            ownerId: target.ownerId,
            campaignId: target.campaignId,
            name: target.name,
            category: target.category,
            quantity: 0,
            description: target.description,
            equipable: target.equipable,
            equipped: false,
          },
          nextRevision: nextRev,
          nextLastSequence: nextSeq,
          event: {
            id: createSafeId('evt'),
            ownerId: campaign.ownerId,
            campaignId: campaign.id,
            timelineId,
            sequence: nextSeq,
            type: 'INVENTORY_REMOVED',
            summary: clampText(`Item esgotado e removido: ${target.name}.`, LIMITS.SUMMARY_MAX),
            actor: 'Jogador',
            beforeSummary: `${target.name}: ${target.quantity} un.`,
            afterSummary: `${target.name}: removido (0 un.)`,
            worldTimeLabel: timeLabel,
          },
        },
      };
    }

    return {
      ok: true,
      data: {
        kind: 'update',
        item: {
          id: target.id,
          ownerId: target.ownerId,
          campaignId: target.campaignId,
          name: target.name,
          category: target.category,
          quantity: command.quantity,
          description: target.description,
          equipable: target.equipable,
          equipped: target.equipped,
        },
        nextRevision: nextRev,
        nextLastSequence: nextSeq,
        event: {
          id: createSafeId('evt'),
          ownerId: campaign.ownerId,
          campaignId: campaign.id,
          timelineId,
          sequence: nextSeq,
          type: 'INVENTORY_UPDATED',
          summary: clampText(`Quantidade alterada: ${target.name} (${target.quantity} → ${command.quantity}).`, LIMITS.SUMMARY_MAX),
          actor: 'Jogador',
          beforeSummary: `${target.name}: ${target.quantity} un.`,
          afterSummary: `${target.name}: ${command.quantity} un.`,
          worldTimeLabel: timeLabel,
        },
      },
    };
  }

  if (command.kind === 'toggle_equipped') {
    if (!target.equipable) {
      return {
        ok: false,
        error: `Regra violada: "${target.name}" não é um item equipável.`,
      };
    }

    const nextEquipped = !target.equipped;
    return {
      ok: true,
      data: {
        kind: 'update',
        item: {
          id: target.id,
          ownerId: target.ownerId,
          campaignId: target.campaignId,
          name: target.name,
          category: target.category,
          quantity: target.quantity,
          description: target.description,
          equipable: target.equipable,
          equipped: nextEquipped,
        },
        nextRevision: nextRev,
        nextLastSequence: nextSeq,
        event: {
          id: createSafeId('evt'),
          ownerId: campaign.ownerId,
          campaignId: campaign.id,
          timelineId,
          sequence: nextSeq,
          type: 'INVENTORY_UPDATED',
          summary: clampText(
            `${target.name} ${nextEquipped ? 'equipado' : 'desequipado'}.`,
            LIMITS.SUMMARY_MAX,
          ),
          actor: campaign.protagonist.name,
          beforeSummary: `${target.name}: ${target.equipped ? 'Equipado' : 'Guardado'}`,
          afterSummary: `${target.name}: ${nextEquipped ? 'Equipado' : 'Guardado'}`,
          worldTimeLabel: timeLabel,
        },
      },
    };
  }

  return {
    ok: true,
    data: {
      kind: 'delete',
      item: {
        id: target.id,
        ownerId: target.ownerId,
        campaignId: target.campaignId,
        name: target.name,
        category: target.category,
        quantity: target.quantity,
        description: target.description,
        equipable: target.equipable,
        equipped: target.equipped,
      },
      nextRevision: nextRev,
      nextLastSequence: nextSeq,
      event: {
        id: createSafeId('evt'),
        ownerId: campaign.ownerId,
        campaignId: campaign.id,
        timelineId,
        sequence: nextSeq,
        type: 'INVENTORY_REMOVED',
        summary: clampText(`Item removido do inventário: ${target.name}.`, LIMITS.SUMMARY_MAX),
        actor: 'Jogador',
        beforeSummary: `${target.name}: ${target.quantity} un.`,
        afterSummary: 'Removido do inventário',
        worldTimeLabel: timeLabel,
      },
    },
  };
}

export function processCurrencyMutation(
  campaign: Campaign,
  delta: Partial<Currency>,
): RuleResult<CurrencyMutationResult> {
  if (campaign.status === 'archived') {
    return { ok: false, error: 'Campanha arquivada não aceita alteração de moedas.' };
  }

  const nextGold = campaign.currency.gold + (delta.gold ?? 0);
  const nextSilver = campaign.currency.silver + (delta.silver ?? 0);
  const nextCopper = campaign.currency.copper + (delta.copper ?? 0);

  if (
    !Number.isInteger(nextGold) ||
    !Number.isInteger(nextSilver) ||
    !Number.isInteger(nextCopper) ||
    nextGold < 0 ||
    nextSilver < 0 ||
    nextCopper < 0
  ) {
    return {
      ok: false,
      error: 'Saldo insuficiente: moedas não podem assumir valores negativos.',
    };
  }

  if (
    nextGold > LIMITS.MAX_CURRENCY ||
    nextSilver > LIMITS.MAX_CURRENCY ||
    nextCopper > LIMITS.MAX_CURRENCY
  ) {
    return {
      ok: false,
      error: 'Valor de moedas excede o limite máximo estrutural.',
    };
  }

  if (
    nextGold === campaign.currency.gold &&
    nextSilver === campaign.currency.silver &&
    nextCopper === campaign.currency.copper
  ) {
    return { ok: false, error: 'Nenhuma variação de moedas informada.' };
  }

  const nextCurrency: Currency = { gold: nextGold, silver: nextSilver, copper: nextCopper };
  const timeLabel = formatWorldTimeLabel(campaign.worldTime);
  const timelineId = getActiveTimelineId(campaign);
  const nextSeq = campaign.lastSequence + 1;

  return {
    ok: true,
    data: {
      nextCurrency,
      nextRevision: campaign.revision + 1,
      nextLastSequence: nextSeq,
      event: {
        id: createSafeId('evt'),
        ownerId: campaign.ownerId,
        campaignId: campaign.id,
        timelineId,
        sequence: nextSeq,
        type: 'CURRENCY_UPDATED',
        summary: 'Reserva de moedas atualizada.',
        actor: 'Jogador',
        beforeSummary: `${campaign.currency.gold}o ${campaign.currency.silver}p ${campaign.currency.copper}c`,
        afterSummary: `${nextCurrency.gold}o ${nextCurrency.silver}p ${nextCurrency.copper}c`,
        worldTimeLabel: timeLabel,
      },
    },
  };
}

export function processTimeAdvance(
  campaign: Campaign,
  minutes: number,
): RuleResult<TimeAdvanceResult> {
  if (campaign.status === 'archived') {
    return { ok: false, error: 'Campanha arquivada não avança o relógio do mundo.' };
  }

  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) {
    return {
      ok: false,
      error: 'Avanço de tempo inválido: informe entre 1 e 1440 minutos.',
    };
  }

  const nextWorldTime = advanceWorldTime(campaign.worldTime, minutes);
  const beforeLabel = formatWorldTimeLabel(campaign.worldTime);
  const afterLabel = formatWorldTimeLabel(nextWorldTime);
  const timelineId = getActiveTimelineId(campaign);
  const nextSeq = campaign.lastSequence + 1;

  return {
    ok: true,
    data: {
      nextWorldTime,
      nextRevision: campaign.revision + 1,
      nextLastSequence: nextSeq,
      event: {
        id: createSafeId('evt'),
        ownerId: campaign.ownerId,
        campaignId: campaign.id,
        timelineId,
        sequence: nextSeq,
        type: 'TIME_ADVANCED',
        summary: `Tempo do mundo avançado em ${minutes} minutos.`,
        actor: 'Mundo',
        beforeSummary: beforeLabel,
        afterSummary: afterLabel,
        worldTimeLabel: afterLabel,
      },
    },
  };
}

export function buildCheckpointPayload(
  campaign: Campaign,
  inventory: InventoryItem[],
  npcs: NpcRecord[],
  label: string,
  note: string,
): RuleResult<{
  checkpoint: Omit<Checkpoint, 'createdAt'>;
  event: Omit<GameEvent, 'createdAt'>;
  expectedRevision: number;
  nextRevision: number;
  nextLastSequence: number;
}> {
  if (campaign.status === 'archived') {
    return {
      ok: false,
      error: 'Campanha arquivada não permite gravar novos pontos de controle.',
    };
  }

  const cleanLabel = label.trim();
  const cleanNote = note.trim();

  if (cleanLabel.length < 1 || cleanLabel.length > LIMITS.NAME_MAX) {
    return {
      ok: false,
      error: `O nome do ponto de controle deve ter entre 1 e ${LIMITS.NAME_MAX} caracteres.`,
    };
  }

  if (cleanNote.length > LIMITS.DESCRIPTION_MAX) {
    return {
      ok: false,
      error: `A anotação do ponto de controle excede ${LIMITS.DESCRIPTION_MAX} caracteres.`,
    };
  }

  const nextSeq = campaign.lastSequence + 1;
  const timeLabel = formatWorldTimeLabel(campaign.worldTime);
  const timelineId = getActiveTimelineId(campaign);
  const currentLineage = getCampaignTimelineLineage(campaign);
  const timelineLineageSnapshot: TimelineSegment[] = currentLineage.map((seg, idx) => {
    if (idx === currentLineage.length - 1 && seg.toSequence === null) {
      return {
        timelineId: seg.timelineId,
        fromSequence: seg.fromSequence,
        toSequence: Math.max(seg.fromSequence, nextSeq),
      };
    }
    return { ...seg };
  });

  const checkpoint: Omit<Checkpoint, 'createdAt'> = {
    id: createSafeId('chk'),
    ownerId: campaign.ownerId,
    campaignId: campaign.id,
    label: cleanLabel,
    note: cleanNote,
    revision: campaign.revision,
    lastSequence: nextSeq,
    timelineId,
    narrativeCutoffSequence: nextSeq,
    timelineLineageSnapshot,
    currentLocation: campaign.currentLocation,
    protagonist: { ...campaign.protagonist },
    currency: { ...campaign.currency },
    worldTime: { ...campaign.worldTime },
    inventorySnapshot: inventory.map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      quantity: item.quantity,
      description: item.description,
      equipable: item.equipable,
      equipped: item.equipped,
    })),
    npcsSnapshot: npcs.map((npc) => ({
      id: npc.id,
      name: npc.name,
      role: npc.role,
      location: npc.location,
      relationship: npc.relationship,
      notes: npc.notes,
    })),
  };

  const event: Omit<GameEvent, 'createdAt'> = {
    id: createSafeId('evt'),
    ownerId: campaign.ownerId,
    campaignId: campaign.id,
    timelineId,
    sequence: nextSeq,
    type: 'CHECKPOINT_SAVED',
    summary: clampText(`Ponto de controle salvo: "${cleanLabel}".`, LIMITS.SUMMARY_MAX),
    actor: 'Jogador',
    beforeSummary: `Revisão ${campaign.revision} · ${inventory.length} itens`,
    afterSummary: `Checkpoint "${cleanLabel}" gravado no Firestore`,
    worldTimeLabel: timeLabel,
  };

  return {
    ok: true,
    data: {
      checkpoint,
      event,
      expectedRevision: campaign.revision,
      nextRevision: campaign.revision + 1,
      nextLastSequence: nextSeq,
    },
  };
}

function isInventoryItemChanged(current: InventoryItem, snap: InventorySnapshotItem): boolean {
  return (
    current.name !== snap.name ||
    current.category !== snap.category ||
    current.quantity !== snap.quantity ||
    current.description !== snap.description ||
    current.equipable !== snap.equipable ||
    current.equipped !== snap.equipped
  );
}

function isNpcChanged(current: NpcRecord, snap: NpcSnapshotItem): boolean {
  return (
    current.name !== snap.name ||
    current.role !== snap.role ||
    current.location !== snap.location ||
    current.relationship !== snap.relationship ||
    current.notes !== snap.notes
  );
}

export function prepareCheckpointRestore(
  campaign: Campaign,
  checkpoint: Checkpoint,
  currentInventory: InventoryItem[],
  currentNpcs: NpcRecord[],
): RuleResult<CheckpointRestorePlan> {
  if (campaign.status === 'archived') {
    return {
      ok: false,
      error: 'Campanha arquivada não permite restauração de pontos de controle.',
    };
  }

  if (checkpoint.campaignId !== campaign.id || checkpoint.ownerId !== campaign.ownerId) {
    return {
      ok: false,
      error: 'Ponto de controle incompatível com a campanha ou conta selecionada.',
    };
  }

  if (!Array.isArray(checkpoint.inventorySnapshot) || !Array.isArray(checkpoint.npcsSnapshot)) {
    return {
      ok: false,
      error: 'Ponto de controle corrompido: snapshots estruturados ausentes.',
    };
  }

  if (checkpoint.inventorySnapshot.length > LIMITS.MAX_INVENTORY_ITEMS) {
    return {
      ok: false,
      error: `ATOMIC_LIMIT_EXCEEDED: O snapshot excede o limite de ${LIMITS.MAX_INVENTORY_ITEMS} itens.`,
    };
  }

  const seenItemIds = new Set<string>();
  for (const snapItem of checkpoint.inventorySnapshot) {
    if (!ID_PATTERN.test(snapItem.id) || seenItemIds.has(snapItem.id)) {
      return {
        ok: false,
        error: 'Ponto de controle inválido: identificadores duplicados ou inválidos no inventário.',
      };
    }
    seenItemIds.add(snapItem.id);

    if (
      !snapItem.name?.trim() ||
      !Number.isInteger(snapItem.quantity) ||
      snapItem.quantity < 0 ||
      snapItem.quantity > LIMITS.MAX_QUANTITY ||
      (snapItem.equipped && !snapItem.equipable)
    ) {
      return {
        ok: false,
        error: `Ponto de controle inválido: regra estrutural violada no item "${snapItem.name || snapItem.id}".`,
      };
    }
  }

  const seenNpcIds = new Set<string>();
  for (const snapNpc of checkpoint.npcsSnapshot) {
    if (!ID_PATTERN.test(snapNpc.id) || seenNpcIds.has(snapNpc.id)) {
      return {
        ok: false,
        error: 'Ponto de controle inválido: identificadores duplicados ou inválidos nos NPCs.',
      };
    }
    seenNpcIds.add(snapNpc.id);

    if (
      !snapNpc.name?.trim() ||
      !snapNpc.role?.trim() ||
      !snapNpc.location?.trim() ||
      !snapNpc.relationship?.trim()
    ) {
      return {
        ok: false,
        error: `Ponto de controle inválido: dados obrigatórios ausentes no NPC "${snapNpc.name || snapNpc.id}".`,
      };
    }
  }

  const baseLineage = getCheckpointTimelineLineage(checkpoint);
  if (baseLineage.length + 1 > LIMITS.MAX_TIMELINE_SEGMENTS) {
    return {
      ok: false,
      error: `ATOMIC_LIMIT_EXCEEDED: Limite máximo de ramificações de linha temporal (${LIMITS.MAX_TIMELINE_SEGMENTS}) atingido nesta beta. Nenhum dado foi alterado.`,
    };
  }

  const currentInventoryById = new Map(currentInventory.map((item) => [item.id, item]));
  const currentNpcById = new Map(currentNpcs.map((npc) => [npc.id, npc]));

  const inventoryDeletes: string[] = [];
  for (const existing of currentInventory) {
    if (!seenItemIds.has(existing.id)) {
      inventoryDeletes.push(existing.id);
    }
  }

  const inventoryUpdates: InventorySnapshotItem[] = [];
  const inventoryCreates: Array<Omit<InventoryItem, 'createdAt' | 'updatedAt'>> = [];
  for (const snapItem of checkpoint.inventorySnapshot) {
    const current = currentInventoryById.get(snapItem.id);
    if (current) {
      if (isInventoryItemChanged(current, snapItem)) {
        inventoryUpdates.push({ ...snapItem });
      }
    } else {
      inventoryCreates.push({
        id: snapItem.id,
        ownerId: campaign.ownerId,
        campaignId: campaign.id,
        name: snapItem.name,
        category: snapItem.category,
        quantity: snapItem.quantity,
        description: snapItem.description,
        equipable: snapItem.equipable,
        equipped: snapItem.equipped,
      });
    }
  }

  const npcDeletes: string[] = [];
  for (const existing of currentNpcs) {
    if (!seenNpcIds.has(existing.id)) {
      npcDeletes.push(existing.id);
    }
  }

  const npcUpdates: NpcSnapshotItem[] = [];
  const npcCreates: Array<Omit<NpcRecord, 'createdAt' | 'updatedAt'>> = [];
  for (const snapNpc of checkpoint.npcsSnapshot) {
    const current = currentNpcById.get(snapNpc.id);
    if (current) {
      if (isNpcChanged(current, snapNpc)) {
        npcUpdates.push({ ...snapNpc });
      }
    } else {
      npcCreates.push({
        id: snapNpc.id,
        ownerId: campaign.ownerId,
        campaignId: campaign.id,
        name: snapNpc.name,
        role: snapNpc.role,
        location: snapNpc.location,
        relationship: snapNpc.relationship,
        notes: snapNpc.notes,
      });
    }
  }

  // +2 para a entrada narrativa de restauração e o evento auditável CHECKPOINT_LOADED
  const totalSubcollectionOps =
    inventoryDeletes.length +
    inventoryUpdates.length +
    inventoryCreates.length +
    npcDeletes.length +
    npcUpdates.length +
    npcCreates.length +
    2;

  if (totalSubcollectionOps > LIMITS.BETA_MAX_ATOMIC_RESTORE_SUBCOLLECTION_OPS) {
    return {
      ok: false,
      error: `ATOMIC_LIMIT_EXCEEDED: Esta restauração exige ${totalSubcollectionOps} alterações em subcoleções (inventário, NPCs, narrativa e evento), excedendo o limite atômico suportado nesta beta (${LIMITS.BETA_MAX_ATOMIC_RESTORE_SUBCOLLECTION_OPS}). Nenhum dado foi alterado.`,
    };
  }

  const restoreNarrativeSeq = campaign.lastSequence + 1;
  const restoreEventSeq = campaign.lastSequence + 2;
  const nextTimelineId = createSafeId('tl');
  const restoredTimeLabel = formatWorldTimeLabel(checkpoint.worldTime);

  const nextTimelineLineage: TimelineSegment[] = [
    ...baseLineage,
    {
      timelineId: nextTimelineId,
      fromSequence: restoreNarrativeSeq,
      toSequence: null,
    },
  ];

  const narrativeEntry: Omit<NarrativeEntry, 'createdAt'> = {
    id: createSafeId('nar'),
    ownerId: campaign.ownerId,
    campaignId: campaign.id,
    timelineId: nextTimelineId,
    sequence: restoreNarrativeSeq,
    authorRole: 'engine_response',
    content: `[Ponto de controle restaurado: "${checkpoint.label}"] O estado estruturado do protagonista, moedas, inventário, NPCs, calendário e linha narrativa retornaram para ${restoredTimeLabel}.`,
    worldTimeLabel: restoredTimeLabel,
  };

  const event: Omit<GameEvent, 'createdAt'> = {
    id: createSafeId('evt'),
    ownerId: campaign.ownerId,
    campaignId: campaign.id,
    timelineId: nextTimelineId,
    sequence: restoreEventSeq,
    type: 'CHECKPOINT_LOADED',
    summary: clampText(
      `Estado e narrativa restaurados a partir do ponto de controle "${checkpoint.label}".`,
      LIMITS.SUMMARY_MAX,
    ),
    actor: 'Sistema',
    beforeSummary: `Revisão ${campaign.revision} · ${currentInventory.length} itens · Seq. #${campaign.lastSequence}`,
    afterSummary: `Checkpoint Rev. ${checkpoint.revision} (Seq. #${checkpoint.lastSequence}) · ${checkpoint.inventorySnapshot.length} itens`,
    worldTimeLabel: restoredTimeLabel,
  };

  return {
    ok: true,
    data: {
      campaignId: campaign.id,
      ownerId: campaign.ownerId,
      checkpointId: checkpoint.id,
      expectedRevision: campaign.revision,
      nextRevision: campaign.revision + 1,
      nextLastSequence: restoreEventSeq,
      nextTimelineId,
      nextTimelineLineage,
      restoredState: {
        protagonist: { ...checkpoint.protagonist },
        currency: { ...checkpoint.currency },
        worldTime: { ...checkpoint.worldTime },
        currentLocation: checkpoint.currentLocation,
      },
      inventoryDeletes,
      inventoryUpdates,
      inventoryCreates,
      npcDeletes,
      npcUpdates,
      npcCreates,
      narrativeEntry,
      event,
      totalSubcollectionOps,
    },
  };
}

export function describeMonthName(monthIndex: number): string {
  return WORLD_MONTHS[monthIndex - 1] ?? `Mês ${monthIndex}`;
}

