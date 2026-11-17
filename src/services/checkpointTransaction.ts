import type {
  Campaign,
  Checkpoint,
  GameEvent,
  InventoryItem,
  NpcRecord,
} from '../types/game';
import {
  prepareCheckpointRestore,
  type CheckpointRestorePlan,
} from '../engine/rulesEngine';

export type TransactionDiagnosticOp = 'get' | 'list' | 'create' | 'update' | 'delete' | 'write';

export interface FirestoreDiagnosticContext {
  operationType: TransactionDiagnosticOp;
  path: string;
}

const DIAGNOSTIC_SYMBOL = Symbol('firestoreDiagnosticContext');

export function attachFirestoreContext(
  error: unknown,
  context: FirestoreDiagnosticContext,
): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  const holder = err as Error & { [DIAGNOSTIC_SYMBOL]?: FirestoreDiagnosticContext };
  if (!holder[DIAGNOSTIC_SYMBOL]) {
    holder[DIAGNOSTIC_SYMBOL] = context;
  }
  return err;
}

export function extractFirestoreContext(error: unknown): FirestoreDiagnosticContext | null {
  if (error && typeof error === 'object' && DIAGNOSTIC_SYMBOL in error) {
    return (
      (error as { [DIAGNOSTIC_SYMBOL]?: FirestoreDiagnosticContext })[DIAGNOSTIC_SYMBOL] ?? null
    );
  }
  return null;
}

export interface CheckpointTransactionContext {
  getCampaign: (campaignId: string) => Promise<Campaign | null>;
  getCheckpoint: (campaignId: string, checkpointId: string) => Promise<Checkpoint | null>;
  updateCampaign: (campaignId: string, patch: Record<string, unknown>) => void;
  setCheckpoint: (campaignId: string, checkpointId: string, data: Record<string, unknown>) => void;
  setInventoryItem: (campaignId: string, itemId: string, data: Record<string, unknown>) => void;
  updateInventoryItem: (campaignId: string, itemId: string, patch: Record<string, unknown>) => void;
  deleteInventoryItem: (campaignId: string, itemId: string) => void;
  setNpc: (campaignId: string, npcId: string, data: Record<string, unknown>) => void;
  updateNpc: (campaignId: string, npcId: string, patch: Record<string, unknown>) => void;
  deleteNpc: (campaignId: string, npcId: string) => void;
  setNarrativeEntry: (campaignId: string, entryId: string, data: Record<string, unknown>) => void;
  setEvent: (campaignId: string, eventId: string, data: Record<string, unknown>) => void;
}

export interface CheckpointTransactionPort {
  ensureVerifiedUser: (expectedOwnerId: string) => Promise<string>;
  fetchLiveInventoryAndNpcs?: (
    campaignId: string,
    ownerId: string,
  ) => Promise<{ inventory: InventoryItem[]; npcs: NpcRecord[] }>;
  runAtomicTransaction: <T>(
    fn: (tx: CheckpointTransactionContext) => Promise<T>,
  ) => Promise<T>;
  serverTimestamp: () => unknown;
}

export async function executeSaveCheckpointTransaction(
  port: CheckpointTransactionPort,
  campaignId: string,
  checkpoint: Omit<Checkpoint, 'createdAt'>,
  event: Omit<GameEvent, 'createdAt'>,
  expectedRevision: number,
  nextRevision: number,
  nextLastSequence: number,
): Promise<void> {
  let activeContext: FirestoreDiagnosticContext = {
    operationType: 'write',
    path: `campaigns/${campaignId}/checkpoints/${checkpoint.id}`,
  };

  try {
    const uid = await port.ensureVerifiedUser(checkpoint.ownerId);

    await port.runAtomicTransaction(async (tx) => {
      activeContext = { operationType: 'get', path: `campaigns/${campaignId}` };
      const liveCampaign = await tx.getCampaign(campaignId);
      if (!liveCampaign) {
        throw new Error('Campanha não encontrada no Cloud Firestore.');
      }
      if (liveCampaign.ownerId !== uid) {
        throw new Error('Permissão negada: a campanha pertence a outra conta.');
      }
      if (liveCampaign.status === 'archived') {
        throw new Error('Campanha arquivada não permite gravar novos pontos de controle.');
      }
      if (liveCampaign.revision !== expectedRevision) {
        throw new Error(
          `CONCURRENT_REVISION_CONFLICT: A campanha foi modificada concorrentemente antes de salvar o ponto de controle (revisão local ${expectedRevision}, revisão no servidor ${liveCampaign.revision}).`,
        );
      }

      activeContext = {
        operationType: 'write',
        path: `campaigns/${campaignId} [tx: update campaign, create checkpoints/${checkpoint.id}, create events/${event.id}]`,
      };

      tx.updateCampaign(campaignId, {
        lastSequence: nextLastSequence,
        revision: nextRevision,
        updatedAt: port.serverTimestamp(),
      });

      tx.setCheckpoint(campaignId, checkpoint.id, {
        ...checkpoint,
        createdAt: port.serverTimestamp(),
      });

      tx.setEvent(campaignId, event.id, {
        ...event,
        createdAt: port.serverTimestamp(),
      });
    });
  } catch (error) {
    throw attachFirestoreContext(error, activeContext);
  }
}

export async function executeRestoreCheckpointTransaction(
  port: CheckpointTransactionPort,
  campaign: Campaign,
  checkpoint: Checkpoint,
  currentInventory: InventoryItem[],
  currentNpcs: NpcRecord[],
): Promise<CheckpointRestorePlan> {
  let activeContext: FirestoreDiagnosticContext = {
    operationType: 'write',
    path: `campaigns/${campaign.id}`,
  };

  try {
    const uid = await port.ensureVerifiedUser(campaign.ownerId);

    let effectiveInventory = currentInventory;
    let effectiveNpcs = currentNpcs;

    if (port.fetchLiveInventoryAndNpcs) {
      activeContext = {
        operationType: 'list',
        path: `campaigns/${campaign.id}/inventory & npcs`,
      };
      const liveCollections = await port.fetchLiveInventoryAndNpcs(campaign.id, uid);
      effectiveInventory = liveCollections.inventory;
      effectiveNpcs = liveCollections.npcs;
    }

    const planResult = prepareCheckpointRestore(
      campaign,
      checkpoint,
      effectiveInventory,
      effectiveNpcs,
    );

    if (!planResult.ok) {
      throw new Error(planResult.error);
    }

    const plan = planResult.data;

    await port.runAtomicTransaction(async (tx) => {
      activeContext = { operationType: 'get', path: `campaigns/${campaign.id}` };
      const liveCampaign = await tx.getCampaign(campaign.id);

      activeContext = {
        operationType: 'get',
        path: `campaigns/${campaign.id}/checkpoints/${checkpoint.id}`,
      };
      const liveCheckpoint = await tx.getCheckpoint(campaign.id, checkpoint.id);

      if (!liveCampaign) {
        throw new Error('Campanha não encontrada no Cloud Firestore.');
      }
      if (liveCampaign.ownerId !== uid) {
        throw new Error('Permissão negada: a campanha pertence a outra conta.');
      }
      if (liveCampaign.status === 'archived') {
        throw new Error('Campanha arquivada não permite restauração de pontos de controle.');
      }
      if (liveCampaign.revision !== plan.expectedRevision) {
        throw new Error(
          `CONCURRENT_REVISION_CONFLICT: A campanha foi modificada em outra operação ou aba (revisão esperada ${plan.expectedRevision}, revisão atual no servidor ${liveCampaign.revision}). Sincronize antes de restaurar.`,
        );
      }
      if (
        !liveCheckpoint ||
        liveCheckpoint.campaignId !== campaign.id ||
        liveCheckpoint.ownerId !== uid
      ) {
        throw new Error('Ponto de controle não encontrado ou incompatível no servidor.');
      }

      activeContext = {
        operationType: 'write',
        path: `campaigns/${campaign.id} [tx: update campaign, inv(del:${plan.inventoryDeletes.length},upd:${plan.inventoryUpdates.length},set:${plan.inventoryCreates.length}), npcs(del:${plan.npcDeletes.length},upd:${plan.npcUpdates.length},set:${plan.npcCreates.length}), create narrative/${plan.narrativeEntry.id}, create events/${plan.event.id}]`,
      };

      tx.updateCampaign(campaign.id, {
        protagonist: plan.restoredState.protagonist,
        currency: plan.restoredState.currency,
        worldTime: plan.restoredState.worldTime,
        currentLocation: plan.restoredState.currentLocation,
        lastSequence: plan.nextLastSequence,
        revision: plan.nextRevision,
        activeTimelineId: plan.nextTimelineId,
        timelineLineage: plan.nextTimelineLineage,
        updatedAt: port.serverTimestamp(),
      });

      for (const itemId of plan.inventoryDeletes) {
        tx.deleteInventoryItem(campaign.id, itemId);
      }

      for (const item of plan.inventoryUpdates) {
        tx.updateInventoryItem(campaign.id, item.id, {
          name: item.name,
          category: item.category,
          quantity: item.quantity,
          description: item.description,
          equipable: item.equipable,
          equipped: item.equipped,
          updatedAt: port.serverTimestamp(),
        });
      }

      for (const item of plan.inventoryCreates) {
        tx.setInventoryItem(campaign.id, item.id, {
          ...item,
          createdAt: port.serverTimestamp(),
          updatedAt: port.serverTimestamp(),
        });
      }

      for (const npcId of plan.npcDeletes) {
        tx.deleteNpc(campaign.id, npcId);
      }

      for (const npc of plan.npcUpdates) {
        tx.updateNpc(campaign.id, npc.id, {
          name: npc.name,
          role: npc.role,
          location: npc.location,
          relationship: npc.relationship,
          notes: npc.notes,
          updatedAt: port.serverTimestamp(),
        });
      }

      for (const npc of plan.npcCreates) {
        tx.setNpc(campaign.id, npc.id, {
          ...npc,
          createdAt: port.serverTimestamp(),
          updatedAt: port.serverTimestamp(),
        });
      }

      tx.setNarrativeEntry(campaign.id, plan.narrativeEntry.id, {
        ...plan.narrativeEntry,
        createdAt: port.serverTimestamp(),
      });

      tx.setEvent(campaign.id, plan.event.id, {
        ...plan.event,
        createdAt: port.serverTimestamp(),
      });
    });

    return plan;
  } catch (error) {
    throw attachFirestoreContext(error, activeContext);
  }
}
