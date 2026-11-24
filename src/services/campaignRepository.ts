import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type Unsubscribe,
  type Transaction,
} from 'firebase/firestore';
import type {
  Campaign,
  Checkpoint,
  GameEvent,
  InventoryItem,
  NarrativeEntry,
  NpcRecord,
} from '../types/game';
import type { CampaignSeedBundle } from '../engine/echoArcFixture';
import { advanceWorldTime } from '../engine/rulesEngine';
import { isTurnId, readCommittedTurn, turnDocumentIds, type TurnIdentity } from '../engine/turnIdentity';
import type {
  CurrencyMutationResult,
  InventoryMutationResult,
  PlayerActionResult,
  TimeAdvanceResult,
} from '../engine/rulesEngine';
import {
  attachFirestoreContext,
  executeRestoreCheckpointTransaction,
  executeSaveCheckpointTransaction,
  extractFirestoreContext,
  type CheckpointTransactionPort,
} from './checkpointTransaction';
import { OperationType, auth, db, handleFirestoreError, localFreixo, stagingFreixo } from './firebaseClient';
import { SERVER_PILOT_ID } from '../engine/pilotCampaign';
import { confirmLocalPilotSession } from './localPilotAuth';

function toOperationType(op: string): OperationType {
  switch (op) {
    case 'get':
      return OperationType.GET;
    case 'list':
      return OperationType.LIST;
    case 'create':
      return OperationType.CREATE;
    case 'update':
      return OperationType.UPDATE;
    case 'delete':
      return OperationType.DELETE;
    default:
      return OperationType.WRITE;
  }
}

function toMillis(ts: unknown): number {
  if (ts instanceof Timestamp) return ts.toMillis();
  if (ts && typeof ts === 'object' && 'seconds' in ts) {
    return Number((ts as { seconds: number }).seconds) * 1000;
  }
  return 0;
}

async function ensureVerifiedAuthUser(expectedOwnerId?: string): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Usuário não autenticado no Firebase Authentication.');
  }
  if (expectedOwnerId && user.uid !== expectedOwnerId) {
    throw new Error(
      `Divergência de identidade: UID autenticado (${user.uid}) diferente do ownerId (${expectedOwnerId}).`,
    );
  }
  if (localFreixo) await confirmLocalPilotSession(auth, user);
  else await user.getIdToken();
  return user.uid;
}

export function subscribeUserCampaigns(
  uid: string,
  onData: (campaigns: Campaign[]) => void,
  onError: (err: unknown) => void,
): Unsubscribe {
  const path = 'campaigns';
  if (stagingFreixo) {
    return onSnapshot(doc(db, path, SERVER_PILOT_ID), (snapshot) => {
      const campaign = snapshot.data() as Campaign | undefined;
      onData(campaign?.ownerId === uid && campaign.id === SERVER_PILOT_ID ? [campaign] : []);
    }, onError);
  }
  const q = query(collection(db, path), where('ownerId', '==', uid));

  return onSnapshot(
    q,
    (snapshot) => {
      const list = snapshot.docs.map((d) => d.data() as Campaign);
      list.sort((a, b) => toMillis(b.updatedAt) - toMillis(a.updatedAt));
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped);
      }
    },
  );
}

export interface CampaignDetailCallbacks {
  onCampaign: (campaign: Campaign | null) => void;
  onInventory: (items: InventoryItem[]) => void;
  onNpcs: (npcs: NpcRecord[]) => void;
  onNarrative: (entries: NarrativeEntry[]) => void;
  onEvents: (events: GameEvent[]) => void;
  onCheckpoints: (checkpoints: Checkpoint[]) => void;
  onError: (err: unknown) => void;
}

export function subscribeCampaignDetails(
  campaignId: string,
  uid: string,
  callbacks: CampaignDetailCallbacks,
): Unsubscribe {
  const basePath = `campaigns/${campaignId}`;

  const emitError = (err: unknown, op: OperationType, path: string) => {
    try {
      handleFirestoreError(err, op, path);
    } catch (wrapped) {
      callbacks.onError(wrapped);
    }
  };

  const unsubCampaign = onSnapshot(
    doc(db, 'campaigns', campaignId),
    (snap) => {
      callbacks.onCampaign(snap.exists() ? (snap.data() as Campaign) : null);
    },
    (err) => emitError(err, OperationType.GET, basePath),
  );

  const unsubInventory = onSnapshot(
    query(collection(db, basePath, 'inventory'), where('ownerId', '==', uid)),
    (snap) => {
      const items = snap.docs.map((d) => d.data() as InventoryItem);
      items.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      callbacks.onInventory(items);
    },
    (err) => emitError(err, OperationType.LIST, `${basePath}/inventory`),
  );

  const unsubNpcs = onSnapshot(
    query(collection(db, basePath, 'npcs'), where('ownerId', '==', uid)),
    (snap) => {
      const npcs = snap.docs.map((d) => d.data() as NpcRecord);
      npcs.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      callbacks.onNpcs(npcs);
    },
    (err) => emitError(err, OperationType.LIST, `${basePath}/npcs`),
  );

  const unsubNarrative = onSnapshot(
    query(collection(db, basePath, 'narrative'), where('ownerId', '==', uid)),
    (snap) => {
      const entries = snap.docs.map((d) => d.data() as NarrativeEntry);
      entries.sort((a, b) => a.sequence - b.sequence);
      callbacks.onNarrative(entries);
    },
    (err) => emitError(err, OperationType.LIST, `${basePath}/narrative`),
  );

  const unsubEvents = onSnapshot(
    query(collection(db, basePath, 'events'), where('ownerId', '==', uid)),
    (snap) => {
      const events = snap.docs.map((d) => d.data() as GameEvent);
      events.sort((a, b) => b.sequence - a.sequence);
      callbacks.onEvents(events);
    },
    (err) => emitError(err, OperationType.LIST, `${basePath}/events`),
  );

  if (localFreixo || stagingFreixo) callbacks.onCheckpoints([]);
  const unsubCheckpoints = localFreixo || stagingFreixo ? undefined : onSnapshot(
    query(collection(db, basePath, 'checkpoints'), where('ownerId', '==', uid)),
    (snap) => {
      const list = snap.docs.map((d) => d.data() as Checkpoint);
      list.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
      callbacks.onCheckpoints(list);
    },
    (err) => emitError(err, OperationType.LIST, `${basePath}/checkpoints`),
  );

  return () => {
    unsubCampaign();
    unsubInventory();
    unsubNpcs();
    unsubNarrative();
    unsubEvents();
    unsubCheckpoints?.();
  };
}

export async function createCampaignBundle(bundle: CampaignSeedBundle): Promise<string> {
  const { campaign, inventory, npcs, narrative, events } = bundle;
  const campaignPath = `campaigns/${campaign.id}`;
  const campaignRef = doc(db, 'campaigns', campaign.id);

  try {
    await ensureVerifiedAuthUser(campaign.ownerId);

    // Passo 1: Cria primeiro o documento mestre da campanha para garantir existência imediata
    // nas regras de segurança (evita dependência frágil de getAfter em lotes multi-coleção).
    await setDoc(campaignRef, {
      ...campaign,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, campaignPath);
  }

  // Passo 2: Grava subcoleções iniciais em lote atômico com parent já existente.
  const batch = writeBatch(db);

  for (const item of inventory) {
    batch.set(doc(db, campaignPath, 'inventory', item.id), {
      ...item,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  for (const npc of npcs) {
    batch.set(doc(db, campaignPath, 'npcs', npc.id), {
      ...npc,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  for (const entry of narrative) {
    batch.set(doc(db, campaignPath, 'narrative', entry.id), {
      ...entry,
      createdAt: serverTimestamp(),
    });
  }

  for (const evt of events) {
    batch.set(doc(db, campaignPath, 'events', evt.id), {
      ...evt,
      createdAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
    return campaign.id;
  } catch (error) {
    // Reverte documento raiz caso o lote inicial das subcoleções falhe
    try {
      await deleteDoc(campaignRef);
    } catch {
      // Ignora falha de limpeza secundária para preservar o erro original
    }
    handleFirestoreError(error, OperationType.CREATE, `${campaignPath}/subcollections`);
  }
}

export async function commitPlayerAction(
  campaignId: string,
  result: PlayerActionResult,
): Promise<void> {
  const campaignPath = `campaigns/${campaignId}`;
  await ensureVerifiedAuthUser(result.event.ownerId);
  const batch = writeBatch(db);

  batch.update(doc(db, 'campaigns', campaignId), {
    worldTime: result.nextWorldTime,
    lastSequence: result.nextLastSequence,
    revision: result.nextRevision,
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, campaignPath, 'narrative', result.playerEntry.id), {
    ...result.playerEntry,
    createdAt: serverTimestamp(),
  });

  batch.set(doc(db, campaignPath, 'narrative', result.engineEntry.id), {
    ...result.engineEntry,
    createdAt: serverTimestamp(),
  });

  batch.set(doc(db, campaignPath, 'events', result.event.id), {
    ...result.event,
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(
      error,
      OperationType.WRITE,
      `${campaignPath} [lote: update campaign, create narrative/${result.playerEntry.id}, create narrative/${result.engineEntry.id}, create events/${result.event.id}]`,
    );
  }
}

export interface PlayerActionTransactionOptions {
  db?: typeof db;
  skipAuthCheck?: boolean;
  turn?: TurnIdentity;
}

export async function commitPlayerActionTransaction(
  campaignId: string,
  result: PlayerActionResult,
  expectedRevision: number,
  expectedTimelineId: string,
  options?: PlayerActionTransactionOptions,
): Promise<NarrativeEntry | undefined> {
  const targetDb = options?.db ?? db;
  const campaignPath = `campaigns/${campaignId}`;

  // Em ambiente de navegador (producao e dev client), a checagem de autenticacao
  // e obrigatoria e irrevogavel. A opcao skipAuthCheck so e considerada em testes Node.
  const isBrowser = typeof window !== 'undefined';
  if (isBrowser || !options?.skipAuthCheck) {
    await ensureVerifiedAuthUser(result.event.ownerId);
  }

  const turn = options?.turn;
  if (turn && (!isTurnId(turn.turnId) || turn.campaignId !== campaignId ||
      turn.expectedRevision !== expectedRevision || turn.baseTimelineId !== expectedTimelineId ||
      turn.declaredAction.trim() !== result.playerEntry.content ||
      !Number.isSafeInteger(turn.advanceMinutes) || turn.advanceMinutes < 0 || turn.advanceMinutes > 720)) {
    throw new Error('TURN_ID_CONFLICT');
  }
  const ids = turn && await turnDocumentIds(turn);
  const campaignRef = doc(targetDb, 'campaigns', campaignId);
  const readReceipt = async (tx: Transaction, ownerId: string) => {
    if (!turn || !ids) return undefined;
    const event = await tx.get(doc(targetDb, campaignPath, 'events', ids.event));
    if (!event.exists()) return undefined;
    const player = await tx.get(doc(targetDb, campaignPath, 'narrative', ids.player));
    const engine = await tx.get(doc(targetDb, campaignPath, 'narrative', ids.engine));
    return readCommittedTurn(turn, ownerId, event.data() as GameEvent,
      player.data() as NarrativeEntry | undefined, engine.data() as NarrativeEntry | undefined);
  };
  try {
    return await runTransaction(targetDb, async (tx) => {
      const snap = await tx.get(campaignRef);

      if (!snap.exists()) {
        throw new Error(`CONCURRENT_STATE_CONFLICT: Campanha ${campaignId} não encontrada.`);
      }

      const currentCampaign = snap.data() as Campaign;
      if (turn && ids) {
        const replay = await readReceipt(tx, currentCampaign.ownerId);
        if (replay === null) throw new Error('TURN_ID_CONFLICT');
        if (replay) return replay;
        if (currentCampaign.revision !== expectedRevision || (currentCampaign.activeTimelineId || 'tl_root') !== expectedTimelineId) {
          throw new Error('CONCURRENT_STATE_CONFLICT: A revisão ou a linha temporal de origem mudou.');
        }
        const next = advanceWorldTime(currentCampaign.worldTime, turn.advanceMinutes);
        if (Object.entries(next).some(([key, value]) => result.nextWorldTime[key as keyof typeof next] !== value) ||
            result.nextRevision !== expectedRevision + 1 ||
            result.playerEntry.sequence !== currentCampaign.lastSequence + 1 ||
            result.engineEntry.sequence !== currentCampaign.lastSequence + 2 ||
            result.nextLastSequence !== currentCampaign.lastSequence + 3 ||
            result.event.sequence !== result.nextLastSequence ||
            [result.event, result.playerEntry, result.engineEntry].some((entry) =>
              entry.campaignId !== campaignId || entry.ownerId !== currentCampaign.ownerId || entry.timelineId !== expectedTimelineId)) {
          throw new Error('TURN_ID_CONFLICT');
        }
      }

      if (currentCampaign.revision !== expectedRevision) {
        throw new Error(
          `CONCURRENT_STATE_CONFLICT: A revisão da campanha avançou (${currentCampaign.revision} vs esperada ${expectedRevision}). A narrativa gerada foi descartada para evitar inconsistência temporal.`,
        );
      }

      const currentTimeline = currentCampaign.activeTimelineId || 'tl_root';
      if (currentTimeline !== expectedTimelineId) {
        throw new Error(
          `CONCURRENT_STATE_CONFLICT: A linha temporal ativa mudou (${currentTimeline} vs esperada ${expectedTimelineId}). A narrativa gerada foi descartada.`,
        );
      }

      if (currentCampaign.status === 'archived') {
        throw new Error('Campanha arquivada não aceita novas ações.');
      }

      tx.update(campaignRef, {
        worldTime: result.nextWorldTime,
        lastSequence: result.nextLastSequence,
        revision: result.nextRevision,
        updatedAt: serverTimestamp(),
      });

      const playerId = ids?.player ?? result.playerEntry.id;
      const engineId = ids?.engine ?? result.engineEntry.id;
      const eventId = ids?.event ?? result.event.id;
      tx.set(doc(targetDb, campaignPath, 'narrative', playerId), {
        ...result.playerEntry,
        id: playerId,
        createdAt: serverTimestamp(),
      });

      tx.set(doc(targetDb, campaignPath, 'narrative', engineId), {
        ...result.engineEntry,
        id: engineId,
        createdAt: serverTimestamp(),
      });

      tx.set(doc(targetDb, campaignPath, 'events', eventId), {
        ...result.event,
        id: eventId,
        createdAt: serverTimestamp(),
      });
    });
  } catch (error) {
    if (ids && error && typeof error === 'object' && 'code' in error && error.code === 'permission-denied') {
      // A competing commit may have turned the creates into forbidden updates.
      // Recover only an authenticated, matching receipt. Never retry the writes here.
      const replay = await runTransaction(targetDb, async (tx) => {
        const snap = await tx.get(campaignRef);
        if (!snap.exists() || snap.data().ownerId !== result.event.ownerId) return undefined;
        return readReceipt(tx, snap.data().ownerId);
      }).catch(() => undefined);
      if (replay) return replay;
      if (replay === null) throw new Error('TURN_ID_CONFLICT');
    }
    handleFirestoreError(
      error,
      OperationType.WRITE,
      `${campaignPath} [transação: validação de revisão ${expectedRevision} e timeline ${expectedTimelineId}]`,
    );
  }
}

export async function commitInventoryMutation(
  campaignId: string,
  mutation: InventoryMutationResult,
): Promise<void> {
  const campaignPath = `campaigns/${campaignId}`;
  await ensureVerifiedAuthUser(mutation.event.ownerId);
  const itemRef = doc(db, campaignPath, 'inventory', mutation.item.id);
  const batch = writeBatch(db);

  batch.update(doc(db, 'campaigns', campaignId), {
    lastSequence: mutation.nextLastSequence,
    revision: mutation.nextRevision,
    updatedAt: serverTimestamp(),
  });

  if (mutation.kind === 'create') {
    batch.set(itemRef, {
      ...mutation.item,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } else if (mutation.kind === 'update') {
    batch.update(itemRef, {
      name: mutation.item.name,
      category: mutation.item.category,
      quantity: mutation.item.quantity,
      description: mutation.item.description,
      equipable: mutation.item.equipable,
      equipped: mutation.item.equipped,
      updatedAt: serverTimestamp(),
    });
  } else {
    batch.delete(itemRef);
  }

  batch.set(doc(db, campaignPath, 'events', mutation.event.id), {
    ...mutation.event,
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(
      error,
      OperationType.WRITE,
      `${campaignPath} [lote: update campaign, ${mutation.kind} inventory/${mutation.item.id}, create events/${mutation.event.id}]`,
    );
  }
}

export async function commitCurrencyMutation(
  campaignId: string,
  mutation: CurrencyMutationResult,
): Promise<void> {
  const campaignPath = `campaigns/${campaignId}`;
  await ensureVerifiedAuthUser(mutation.event.ownerId);
  const batch = writeBatch(db);

  batch.update(doc(db, 'campaigns', campaignId), {
    currency: mutation.nextCurrency,
    lastSequence: mutation.nextLastSequence,
    revision: mutation.nextRevision,
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, campaignPath, 'events', mutation.event.id), {
    ...mutation.event,
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(
      error,
      OperationType.WRITE,
      `${campaignPath} [lote: update campaign, create events/${mutation.event.id}]`,
    );
  }
}

export async function commitTimeAdvance(
  campaignId: string,
  result: TimeAdvanceResult,
): Promise<void> {
  const campaignPath = `campaigns/${campaignId}`;
  await ensureVerifiedAuthUser(result.event.ownerId);
  const batch = writeBatch(db);

  batch.update(doc(db, 'campaigns', campaignId), {
    worldTime: result.nextWorldTime,
    lastSequence: result.nextLastSequence,
    revision: result.nextRevision,
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, campaignPath, 'events', result.event.id), {
    ...result.event,
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(
      error,
      OperationType.WRITE,
      `${campaignPath} [lote: update campaign, create events/${result.event.id}]`,
    );
  }
}

const firestoreCheckpointPort: CheckpointTransactionPort = {
  ensureVerifiedUser: (expectedOwnerId: string) => ensureVerifiedAuthUser(expectedOwnerId),
  fetchLiveInventoryAndNpcs: async (campaignId: string, ownerId: string) => {
    const basePath = `campaigns/${campaignId}`;
    const invPromise = getDocs(
      query(collection(db, basePath, 'inventory'), where('ownerId', '==', ownerId)),
    ).catch((err) => {
      throw attachFirestoreContext(err, { operationType: 'list', path: `${basePath}/inventory` });
    });
    const npcPromise = getDocs(
      query(collection(db, basePath, 'npcs'), where('ownerId', '==', ownerId)),
    ).catch((err) => {
      throw attachFirestoreContext(err, { operationType: 'list', path: `${basePath}/npcs` });
    });
    const [invSnap, npcSnap] = await Promise.all([invPromise, npcPromise]);
    return {
      inventory: invSnap.docs.map((d) => d.data() as InventoryItem),
      npcs: npcSnap.docs.map((d) => d.data() as NpcRecord),
    };
  },
  runAtomicTransaction: (fn) =>
    runTransaction(db, async (tx) =>
      fn({
        getCampaign: async (campaignId) => {
          const snap = await tx.get(doc(db, 'campaigns', campaignId));
          return snap.exists() ? (snap.data() as Campaign) : null;
        },
        getCheckpoint: async (campaignId, checkpointId) => {
          const snap = await tx.get(
            doc(db, `campaigns/${campaignId}`, 'checkpoints', checkpointId),
          );
          return snap.exists() ? (snap.data() as Checkpoint) : null;
        },
        updateCampaign: (campaignId, patch) => {
          tx.update(doc(db, 'campaigns', campaignId), patch);
        },
        setCheckpoint: (campaignId, checkpointId, data) => {
          tx.set(doc(db, `campaigns/${campaignId}`, 'checkpoints', checkpointId), data);
        },
        setInventoryItem: (campaignId, itemId, data) => {
          tx.set(doc(db, `campaigns/${campaignId}`, 'inventory', itemId), data);
        },
        updateInventoryItem: (campaignId, itemId, patch) => {
          tx.update(doc(db, `campaigns/${campaignId}`, 'inventory', itemId), patch);
        },
        deleteInventoryItem: (campaignId, itemId) => {
          tx.delete(doc(db, `campaigns/${campaignId}`, 'inventory', itemId));
        },
        setNpc: (campaignId, npcId, data) => {
          tx.set(doc(db, `campaigns/${campaignId}`, 'npcs', npcId), data);
        },
        updateNpc: (campaignId, npcId, patch) => {
          tx.update(doc(db, `campaigns/${campaignId}`, 'npcs', npcId), patch);
        },
        deleteNpc: (campaignId, npcId) => {
          tx.delete(doc(db, `campaigns/${campaignId}`, 'npcs', npcId));
        },
        setNarrativeEntry: (campaignId, entryId, data) => {
          tx.set(doc(db, `campaigns/${campaignId}`, 'narrative', entryId), data);
        },
        setEvent: (campaignId, eventId, data) => {
          tx.set(doc(db, `campaigns/${campaignId}`, 'events', eventId), data);
        },
      }),
    ),
  serverTimestamp: () => serverTimestamp(),
};

export async function saveCheckpoint(
  campaignId: string,
  checkpoint: Omit<Checkpoint, 'createdAt'>,
  event: Omit<GameEvent, 'createdAt'>,
  nextRevision: number,
  nextLastSequence: number,
  expectedRevision = nextRevision - 1,
): Promise<void> {
  const campaignPath = `campaigns/${campaignId}`;
  try {
    await executeSaveCheckpointTransaction(
      firestoreCheckpointPort,
      campaignId,
      checkpoint,
      event,
      expectedRevision,
      nextRevision,
      nextLastSequence,
    );
  } catch (error) {
    const ctx = extractFirestoreContext(error);
    handleFirestoreError(
      error,
      ctx ? toOperationType(ctx.operationType) : OperationType.CREATE,
      ctx?.path ?? `${campaignPath}/checkpoints/${checkpoint.id}`,
    );
  }
}

export async function restoreCheckpoint(
  campaign: Campaign,
  checkpoint: Checkpoint,
  currentInventory: InventoryItem[],
  currentNpcs: NpcRecord[],
): Promise<void> {
  const campaignPath = `campaigns/${campaign.id}`;
  try {
    await executeRestoreCheckpointTransaction(
      firestoreCheckpointPort,
      campaign,
      checkpoint,
      currentInventory,
      currentNpcs,
    );
  } catch (error) {
    const ctx = extractFirestoreContext(error);
    handleFirestoreError(
      error,
      ctx ? toOperationType(ctx.operationType) : OperationType.WRITE,
      ctx?.path ?? campaignPath,
    );
  }
}

export async function deleteCampaignWithSubcollections(
  campaignId: string,
  uid: string,
): Promise<void> {
  const basePath = `campaigns/${campaignId}`;
  await ensureVerifiedAuthUser(uid);
  const subcollections = ['inventory', 'npcs', 'narrative', 'events', 'checkpoints'];

  try {
    const deleteRefs = [];
    for (const sub of subcollections) {
      const snap = await getDocs(
        query(collection(db, basePath, sub), where('ownerId', '==', uid)),
      );
      for (const docSnap of snap.docs) {
        deleteRefs.push(docSnap.ref);
      }
    }

    for (let i = 0; i < deleteRefs.length; i += 10) {
      const batch = writeBatch(db);
      for (const ref of deleteRefs.slice(i, i + 10)) {
        batch.delete(ref);
      }
      await batch.commit();
    }

    await deleteDoc(doc(db, 'campaigns', campaignId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, basePath);
  }
}

/**
 * Executa uma tentativa de escrita intencionalmente rejeitada pelas regras do Firestore
 * para validar o tratamento e exibição clara de erros de salvamento sem afetar campanhas reais.
 */
export async function testPersistenceFailure(): Promise<never> {
  const protectedPath = 'security_probe/unauthorized_write';
  try {
    await setDoc(doc(db, 'security_probe', 'unauthorized_write'), {
      probe: true,
      createdAt: serverTimestamp(),
    });
    throw new Error('Unexpected write success');
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, protectedPath);
  }
}
