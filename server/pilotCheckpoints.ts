import { FieldValue, type DocumentData, type Firestore, type QuerySnapshot } from 'firebase-admin/firestore';
import { isDeepStrictEqual } from 'node:util';
import { LIMITS } from '../src/engine/constants';
import type { NpcRoutineState } from '../src/engine/npcRoutine';
import { SERVER_PILOT_ID } from '../src/engine/pilotCampaign';
import { summarizeCheckpoint, type PilotCheckpointRequest, type PilotCheckpointResult } from '../src/engine/pilotCheckpoint';
import { buildCheckpointPayload, getActiveTimelineId, prepareCheckpointRestore } from '../src/engine/rulesEngine';
import { isTurnId } from '../src/engine/turnIdentity';
import type { Campaign, Checkpoint, InventoryItem, NpcRecord } from '../src/types/game';
import { hasPilotInvitation } from './pilotInvitation';

export class PilotCheckpointError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type Placement = { id: string; data: DocumentData };
interface PilotSnapshot {
  checkpoint: Omit<Checkpoint, 'createdAt'>;
  inventory: InventoryItem[];
  npcs: NpcRecord[];
  placements: Placement[];
  runtime: NpcRoutineState | null;
}

const idPattern = /^[a-z0-9_-]{1,128}$/iu;
const maxNpcs = 30;
const maxPlacements = 100;

function readRequest(input: unknown): PilotCheckpointRequest {
  const invalid = () => new PilotCheckpointError(400, 'Pedido de checkpoint inválido.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const { action, campaignId, requestId, expectedRevision, baseTimelineId, label, note, checkpointId } =
    input as Record<string, unknown>;
  if (campaignId !== SERVER_PILOT_ID) throw new PilotCheckpointError(403, 'Campanha incompatível com o piloto.');
  if (typeof requestId !== 'string' || !isTurnId(requestId) ||
      typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      typeof baseTimelineId !== 'string' || !idPattern.test(baseTimelineId)) throw invalid();
  const base = { campaignId, requestId, expectedRevision, baseTimelineId };
  const keys = Object.keys(input);
  if (action === 'save' && typeof label === 'string' && typeof note === 'string' && keys.length === 7) {
    return { ...base, action, label: label.trim(), note: note.trim() };
  }
  if (action === 'restore' && typeof checkpointId === 'string' && idPattern.test(checkpointId) && keys.length === 6) {
    return { ...base, action, checkpointId };
  }
  throw invalid();
}

function ownedCampaign(data: DocumentData | undefined, ownerId: string) {
  const campaign = data as Campaign | undefined;
  if (!campaign || campaign.id !== SERVER_PILOT_ID || campaign.ownerId !== ownerId || campaign.status !== 'active') {
    throw new PilotCheckpointError(403, 'Campanha indisponível para esta conta.');
  }
  return campaign;
}

function readRecords<T extends InventoryItem | NpcRecord>(snapshot: QuerySnapshot, campaign: Campaign, limit: number): T[] {
  if (snapshot.size > limit) throw new PilotCheckpointError(409, 'O estado excede o limite do checkpoint.');
  return snapshot.docs.map((doc) => {
    const data = doc.data() as T;
    if (data.id !== doc.id || data.ownerId !== campaign.ownerId || data.campaignId !== campaign.id) {
      throw new PilotCheckpointError(409, 'Registro incompatível com a campanha.');
    }
    return data;
  });
}

export function listPilotCheckpoints(db: Firestore, ownerId: string, requireInvitation = false) {
  const ref = db.collection('campaigns').doc(SERVER_PILOT_ID);
  return db.runTransaction(async (tx) => {
    if (requireInvitation && !(await hasPilotInvitation(db, ownerId, tx))) {
      throw new PilotCheckpointError(403, 'Convite do piloto indisponível.');
    }
    ownedCampaign((await tx.get(ref)).data(), ownerId);
    // The legacy inventory array supplies the count without fetching the private snapshot.
    const saved = await tx.get(ref.collection('pilotCheckpoints').orderBy('checkpoint.lastSequence', 'desc')
      .select('checkpoint.id', 'checkpoint.campaignId', 'checkpoint.ownerId', 'checkpoint.label', 'checkpoint.note',
        'checkpoint.currentLocation', 'checkpoint.worldTime', 'checkpoint.revision', 'checkpoint.currency',
        'checkpoint.inventorySnapshot').limit(30));
    return saved.docs.flatMap((doc) => {
      const { checkpoint } = doc.data() as PilotSnapshot;
      return checkpoint.id === doc.id && checkpoint.campaignId === ref.id && checkpoint.ownerId === ownerId
        ? [summarizeCheckpoint(checkpoint)] : [];
    });
  }, { readOnly: true });
}

export async function mutatePilotCheckpoint(db: Firestore, ownerId: string, input: unknown,
  requireInvitation = false): Promise<PilotCheckpointResult> {
  const request = readRequest(input);
  const ref = db.collection('campaigns').doc(SERVER_PILOT_ID);
  const receipts = ref.collection('pilotCheckpointReceipts');
  const saved = ref.collection('pilotCheckpoints');
  const items = ref.collection('inventory');
  const people = ref.collection('npcs');
  const positions = ref.collection('pilotObjectLocations');
  const routines = ref.collection('npcRoutineState');

  return db.runTransaction(async (tx) => {
    if (requireInvitation && !(await hasPilotInvitation(db, ownerId, tx))) {
      throw new PilotCheckpointError(403, 'Convite do piloto indisponível.');
    }
    const campaign = ownedCampaign((await tx.get(ref)).data(), ownerId);
    const receiptRef = receipts.doc(request.requestId);
    const receipt = (await tx.get(receiptRef)).data();
    if (receipt) {
      if (receipt.ownerId !== ownerId || !isDeepStrictEqual(receipt.request, request)) {
        throw new PilotCheckpointError(409, 'Identificador de checkpoint já utilizado.');
      }
      return receipt.result as PilotCheckpointResult;
    }

    const timelineId = getActiveTimelineId(campaign);
    if (campaign.revision !== request.expectedRevision || timelineId !== request.baseTimelineId) {
      throw new PilotCheckpointError(409, 'A campanha mudou. Confira a revisão atual e tente novamente.');
    }

    const [itemDocs, npcDocs, placementDocs, source] = await Promise.all([
      tx.get(items.limit(LIMITS.MAX_INVENTORY_ITEMS + 1)),
      tx.get(people.limit(maxNpcs + 1)),
      tx.get(positions.limit(maxPlacements + 1)),
      request.action === 'save' ? tx.get(routines.doc(timelineId)) : tx.get(saved.doc(request.checkpointId)),
    ]);
    const inventory = readRecords<InventoryItem>(itemDocs, campaign, LIMITS.MAX_INVENTORY_ITEMS);
    const npcs = readRecords<NpcRecord>(npcDocs, campaign, maxNpcs);
    if (placementDocs.size > maxPlacements) throw new PilotCheckpointError(409, 'Excesso de objetos posicionados.');
    const placements = placementDocs.docs.map((doc) => {
      const data = doc.data();
      if (data.timelineId !== timelineId || data.campaignId !== campaign.id || data.ownerId !== ownerId) {
        throw new PilotCheckpointError(409, 'Posição de objeto incompatível com a campanha.');
      }
      return { id: doc.id, data };
    });
    const stamp = FieldValue.serverTimestamp();
    let result: PilotCheckpointResult;

    if (request.action === 'save') {
      const plan = buildCheckpointPayload(campaign, inventory, npcs, request.label, request.note);
      if (!plan.ok) throw new PilotCheckpointError(400, plan.error);
      const { checkpoint, event, nextRevision, nextLastSequence } = plan.data;
      const snapshot: PilotSnapshot = { checkpoint, inventory, npcs, placements,
        runtime: (source.data() as NpcRoutineState | undefined) ?? null };
      // Leave room for Firestore's field encoding and refuse oversized snapshots as a unit.
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 500_000) {
        throw new PilotCheckpointError(409, 'O estado excede o tamanho permitido para um checkpoint.');
      }
      tx.create(saved.doc(checkpoint.id), snapshot);
      tx.create(ref.collection('events').doc(event.id), { ...event, createdAt: stamp });
      tx.update(ref, { revision: nextRevision, lastSequence: nextLastSequence, updatedAt: stamp });
      result = { checkpointId: checkpoint.id, revision: nextRevision, timelineId };
    } else {
      const snapshot = source.data() as PilotSnapshot | undefined;
      if (!snapshot || snapshot.checkpoint.id !== request.checkpointId ||
          snapshot.checkpoint.campaignId !== campaign.id || snapshot.checkpoint.ownerId !== ownerId) {
        throw new PilotCheckpointError(404, 'Ponto de controle indisponível para esta campanha.');
      }
      const plan = prepareCheckpointRestore(campaign, snapshot.checkpoint, inventory, npcs);
      if (!plan.ok) throw new PilotCheckpointError(409, plan.error);
      const { restoredState, nextRevision, nextLastSequence, nextTimelineId, nextTimelineLineage,
        narrativeEntry, event } = plan.data;

      for (const [collection, current, previous] of [
        [items, inventory, snapshot.inventory], [people, npcs, snapshot.npcs],
      ] as const) {
        const retained = new Set(previous.map(({ id }) => id));
        for (const { id } of current) if (!retained.has(id)) tx.delete(collection.doc(id));
        for (const record of previous) tx.set(collection.doc(record.id), record);
      }
      const retained = new Set(snapshot.placements.map(({ id }) => id));
      for (const { id } of placements) if (!retained.has(id)) tx.delete(positions.doc(id));
      for (const { id, data } of snapshot.placements) tx.set(positions.doc(id), { ...data, timelineId: nextTimelineId });
      if (snapshot.runtime) {
        const { memories, relationships, ...routine } = snapshot.runtime;
        const fromCheckpoint = ({ timelineId }: { timelineId: string }) => timelineId === snapshot.checkpoint.timelineId;
        const cutoff = snapshot.checkpoint.lastSequence;
        // Retain their provenance while making the captured facts usable in the new branch.
        tx.create(routines.doc(nextTimelineId), { ...routine,
          ...(memories && { memories: memories.filter((entry) => fromCheckpoint(entry) && entry.sequence <= cutoff)
            .map((entry) => ({ ...entry, timelineId: nextTimelineId })) }),
          ...(relationships && { relationships: relationships.filter((entry) => fromCheckpoint(entry) &&
            (entry.firstEncounter?.sequence ?? 0) <= cutoff && (entry.disclosure?.sequence ?? 0) <= cutoff)
            .map((entry) => ({ ...entry, timelineId: nextTimelineId })) }),
        });
      }
      tx.update(ref, { ...restoredState, lastSequence: nextLastSequence, revision: nextRevision,
        activeTimelineId: nextTimelineId, timelineLineage: nextTimelineLineage, updatedAt: stamp });
      tx.create(ref.collection('narrative').doc(narrativeEntry.id), { ...narrativeEntry, createdAt: stamp });
      tx.create(ref.collection('events').doc(event.id), { ...event, createdAt: stamp });
      result = { checkpointId: request.checkpointId, revision: nextRevision, timelineId: nextTimelineId };
    }
    tx.create(receiptRef, { ownerId, request, result, createdAt: stamp });
    return result;
  });
}
