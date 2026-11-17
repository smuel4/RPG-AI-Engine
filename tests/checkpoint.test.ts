import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type {
  Campaign,
  Checkpoint,
  GameEvent,
  InventoryItem,
  NarrativeEntry,
  NpcRecord,
} from '../src/types/game';
import { LIMITS, ROOT_TIMELINE_ID } from '../src/engine/constants';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import {
  buildCheckpointPayload,
  classifyEventsForAudit,
  classifyNarrativeEntriesForAudit,
  prepareCheckpointRestore,
  processCurrencyMutation,
  processInventoryMutation,
  processPlayerAction,
  processTimeAdvance,
} from '../src/engine/rulesEngine';
import {
  executeRestoreCheckpointTransaction,
  executeSaveCheckpointTransaction,
  type CheckpointTransactionContext,
  type CheckpointTransactionPort,
} from '../src/services/checkpointTransaction';

class InMemoryTransactionalStore {
  campaigns = new Map<string, Campaign>();
  inventory = new Map<string, Map<string, InventoryItem>>();
  npcs = new Map<string, Map<string, NpcRecord>>();
  narrative = new Map<string, Map<string, NarrativeEntry>>();
  events = new Map<string, Map<string, GameEvent>>();
  checkpoints = new Map<string, Map<string, Checkpoint>>();

  transactionCalls = 0;
  failOnWriteNumber: number | null = null;
  onBeforeTransactionRead?: () => void;

  seedBundle(bundle: ReturnType<typeof createEchoArcBundle>) {
    const cid = bundle.campaign.id;
    this.campaigns.set(cid, structuredClone(bundle.campaign));
    this.inventory.set(cid, new Map(bundle.inventory.map((i) => [i.id, structuredClone(i)])));
    this.npcs.set(cid, new Map(bundle.npcs.map((n) => [n.id, structuredClone(n)])));
    this.narrative.set(cid, new Map(bundle.narrative.map((e) => [e.id, structuredClone(e)])));
    this.events.set(cid, new Map(bundle.events.map((e) => [e.id, structuredClone(e)])));
    this.checkpoints.set(cid, new Map());
  }

  getCampaign(cid: string): Campaign {
    const c = this.campaigns.get(cid);
    assert.ok(c, `Campaign ${cid} missing`);
    return structuredClone(c);
  }

  getInventoryList(cid: string): InventoryItem[] {
    return Array.from(this.inventory.get(cid)?.values() ?? []).map((i) => structuredClone(i));
  }

  getNpcsList(cid: string): NpcRecord[] {
    return Array.from(this.npcs.get(cid)?.values() ?? []).map((n) => structuredClone(n));
  }

  getNarrativeList(cid: string): NarrativeEntry[] {
    return Array.from(this.narrative.get(cid)?.values() ?? [])
      .map((e) => structuredClone(e))
      .sort((a, b) => a.sequence - b.sequence);
  }

  getEventsList(cid: string): GameEvent[] {
    return Array.from(this.events.get(cid)?.values() ?? [])
      .map((e) => structuredClone(e))
      .sort((a, b) => a.sequence - b.sequence);
  }

  getCheckpoint(cid: string, cpId: string): Checkpoint {
    const cp = this.checkpoints.get(cid)?.get(cpId);
    assert.ok(cp, `Checkpoint ${cpId} missing`);
    return structuredClone(cp);
  }

  applyPlayerAction(cid: string, text: string, minutes = 10) {
    const c = this.getCampaign(cid);
    const inv = this.getInventoryList(cid);
    const npcs = this.getNpcsList(cid);
    const res = processPlayerAction(c, inv, npcs, text, minutes);
    if (!res.ok) assert.fail(res.error);

    this.campaigns.set(cid, {
      ...c,
      worldTime: res.data.nextWorldTime,
      revision: res.data.nextRevision,
      lastSequence: res.data.nextLastSequence,
    });
    this.narrative.get(cid)!.set(res.data.playerEntry.id, structuredClone(res.data.playerEntry));
    this.narrative.get(cid)!.set(res.data.engineEntry.id, structuredClone(res.data.engineEntry));
    this.events.get(cid)!.set(res.data.event.id, structuredClone(res.data.event));
    return res.data;
  }

  applyInventoryAdd(cid: string, name: string, quantity = 1) {
    const c = this.getCampaign(cid);
    const inv = this.getInventoryList(cid);
    const res = processInventoryMutation(c, inv, {
      kind: 'add',
      name,
      category: 'recurso',
      quantity,
      description: `Item de teste ${name}`,
      equipable: false,
    });
    if (!res.ok) assert.fail(res.error);

    this.campaigns.set(cid, {
      ...c,
      revision: res.data.nextRevision,
      lastSequence: res.data.nextLastSequence,
    });
    this.inventory.get(cid)!.set(res.data.item.id, structuredClone(res.data.item));
    this.events.get(cid)!.set(res.data.event.id, structuredClone(res.data.event));
    return res.data.item;
  }

  applyCurrencyDelta(cid: string, delta: { gold?: number; silver?: number; copper?: number }) {
    const c = this.getCampaign(cid);
    const res = processCurrencyMutation(c, delta);
    if (!res.ok) assert.fail(res.error);

    this.campaigns.set(cid, {
      ...c,
      currency: res.data.nextCurrency,
      revision: res.data.nextRevision,
      lastSequence: res.data.nextLastSequence,
    });
    this.events.get(cid)!.set(res.data.event.id, structuredClone(res.data.event));
  }

  applyTimeAdvance(cid: string, minutes: number) {
    const c = this.getCampaign(cid);
    const res = processTimeAdvance(c, minutes);
    if (!res.ok) assert.fail(res.error);

    this.campaigns.set(cid, {
      ...c,
      worldTime: res.data.nextWorldTime,
      revision: res.data.nextRevision,
      lastSequence: res.data.nextLastSequence,
    });
    this.events.get(cid)!.set(res.data.event.id, structuredClone(res.data.event));
  }

  createPort(uid: string): CheckpointTransactionPort {
    return {
      ensureVerifiedUser: async (expectedOwnerId: string) => {
        if (uid !== expectedOwnerId) {
          throw new Error('Divergência de identidade');
        }
        return uid;
      },
      fetchLiveInventoryAndNpcs: async (cid: string) => ({
        inventory: this.getInventoryList(cid),
        npcs: this.getNpcsList(cid),
      }),
      serverTimestamp: () => new Date('2026-11-16T12:00:00Z'),
      runAtomicTransaction: async <T>(fn: (tx: CheckpointTransactionContext) => Promise<T>) => {
        this.transactionCalls += 1;
        if (this.onBeforeTransactionRead) {
          const hook = this.onBeforeTransactionRead;
          this.onBeforeTransactionRead = undefined;
          hook();
        }

        const stagedActions: Array<() => void> = [];
        let writeCount = 0;

        const queueWrite = (op: () => void) => {
          writeCount += 1;
          if (this.failOnWriteNumber !== null && writeCount === this.failOnWriteNumber) {
            throw new Error(`SIMULATED_INTERMEDIATE_FAILURE_AT_WRITE_${writeCount}`);
          }
          stagedActions.push(op);
        };

        const tx: CheckpointTransactionContext = {
          getCampaign: async (cid) => {
            const found = this.campaigns.get(cid);
            return found ? structuredClone(found) : null;
          },
          getCheckpoint: async (cid, cpId) => {
            const found = this.checkpoints.get(cid)?.get(cpId);
            return found ? structuredClone(found) : null;
          },
          updateCampaign: (cid, patch) => {
            queueWrite(() => {
              const cur = this.campaigns.get(cid);
              assert.ok(cur);
              this.campaigns.set(cid, structuredClone({ ...cur, ...patch } as Campaign));
            });
          },
          setCheckpoint: (cid, cpId, data) => {
            queueWrite(() => {
              this.checkpoints.get(cid)!.set(cpId, structuredClone(data as unknown as Checkpoint));
            });
          },
          setInventoryItem: (cid, itemId, data) => {
            queueWrite(() => {
              this.inventory.get(cid)!.set(itemId, structuredClone(data as unknown as InventoryItem));
            });
          },
          updateInventoryItem: (cid, itemId, patch) => {
            queueWrite(() => {
              const map = this.inventory.get(cid)!;
              const cur = map.get(itemId);
              assert.ok(cur);
              map.set(itemId, structuredClone({ ...cur, ...patch } as InventoryItem));
            });
          },
          deleteInventoryItem: (cid, itemId) => {
            queueWrite(() => {
              this.inventory.get(cid)!.delete(itemId);
            });
          },
          setNpc: (cid, npcId, data) => {
            queueWrite(() => {
              this.npcs.get(cid)!.set(npcId, structuredClone(data as unknown as NpcRecord));
            });
          },
          updateNpc: (cid, npcId, patch) => {
            queueWrite(() => {
              const map = this.npcs.get(cid)!;
              const cur = map.get(npcId);
              assert.ok(cur);
              map.set(npcId, structuredClone({ ...cur, ...patch } as NpcRecord));
            });
          },
          deleteNpc: (cid, npcId) => {
            queueWrite(() => {
              this.npcs.get(cid)!.delete(npcId);
            });
          },
          setNarrativeEntry: (cid, entryId, data) => {
            queueWrite(() => {
              this.narrative
                .get(cid)!
                .set(entryId, structuredClone(data as unknown as NarrativeEntry));
            });
          },
          setEvent: (cid, eventId, data) => {
            queueWrite(() => {
              this.events.get(cid)!.set(eventId, structuredClone(data as unknown as GameEvent));
            });
          },
        };

        // Emula commit atômico: se qualquer exceção ocorrer durante fn(), nenhum stagedAction é aplicado.
        const result = await fn(tx);
        for (const apply of stagedActions) {
          apply();
        }
        return result;
      },
    };
  }
}

async function saveCheckpointInStore(
  store: InMemoryTransactionalStore,
  uid: string,
  cid: string,
  label: string,
  note = '',
): Promise<Checkpoint> {
  const c = store.getCampaign(cid);
  const inv = store.getInventoryList(cid);
  const npcs = store.getNpcsList(cid);
  const built = buildCheckpointPayload(c, inv, npcs, label, note);
  if (!built.ok) assert.fail(built.error);

  await executeSaveCheckpointTransaction(
    store.createPort(uid),
    cid,
    built.data.checkpoint,
    built.data.event,
    built.data.expectedRevision,
    built.data.nextRevision,
    built.data.nextLastSequence,
  );

  return store.getCheckpoint(cid, built.data.checkpoint.id);
}

test('Salvamento de checkpoint grava snapshot completo e linha de corte narrativa', async () => {
  const uid = 'user_alpha';
  const store = new InMemoryTransactionalStore();
  const bundle = createEchoArcBundle(uid);
  store.seedBundle(bundle);
  const cid = bundle.campaign.id;

  store.applyPlayerAction(cid, 'Samuel conversa com Teresa antes de sair.', 15);
  const cp = await saveCheckpointInStore(store, uid, cid, 'Antes da praça');

  assert.equal(cp.revision, 2);
  assert.equal(cp.timelineId, ROOT_TIMELINE_ID);
  assert.equal(cp.narrativeCutoffSequence, cp.lastSequence);
  assert.equal(cp.inventorySnapshot.length, 4);
  assert.equal(cp.npcsSnapshot.length, 2);
  assert.deepEqual(cp.timelineLineageSnapshot, [
    { timelineId: ROOT_TIMELINE_ID, fromSequence: 0, toSequence: cp.lastSequence },
  ]);
});

test('Restauração reverte estado estruturado, oculta narrativa posterior da linha ativa e preserva auditoria', async () => {
  const uid = 'user_alpha';
  const store = new InMemoryTransactionalStore();
  const bundle = createEchoArcBundle(uid);
  store.seedBundle(bundle);
  const cid = bundle.campaign.id;

  store.applyPlayerAction(cid, 'Samuel observa o mapa da Vila de Freixo.', 10);
  const cp1 = await saveCheckpointInStore(store, uid, cid, 'Marco Inicial');
  const snapshotBeforeDivergence = {
    currency: store.getCampaign(cid).currency,
    worldTime: store.getCampaign(cid).worldTime,
    inventoryCount: store.getInventoryList(cid).length,
  };

  // Ações posteriores ao checkpoint que devem sair da linha narrativa ativa ao restaurar
  store.applyPlayerAction(cid, 'Samuel caminha até a floresta proibida ao norte.', 45);
  store.applyInventoryAdd(cid, 'Amuleto Estranho', 1);
  store.applyCurrencyDelta(cid, { copper: -5 });
  store.applyTimeAdvance(cid, 60);

  // Confirma que antes de restaurar a ação posterior está na narrativa ativa
  const preRestoreAudit = classifyNarrativeEntriesForAudit(
    store.getCampaign(cid),
    store.getNarrativeList(cid),
  );
  assert.equal(
    preRestoreAudit.active.some((e) => e.content.includes('floresta proibida')),
    true,
  );

  // Restaura CP1
  await executeRestoreCheckpointTransaction(
    store.createPort(uid),
    store.getCampaign(cid),
    cp1,
    store.getInventoryList(cid),
    store.getNpcsList(cid),
  );

  const restoredCampaign = store.getCampaign(cid);
  assert.deepEqual(restoredCampaign.currency, snapshotBeforeDivergence.currency);
  assert.deepEqual(restoredCampaign.worldTime, snapshotBeforeDivergence.worldTime);
  assert.equal(store.getInventoryList(cid).length, snapshotBeforeDivergence.inventoryCount);
  assert.equal(
    store.getInventoryList(cid).some((i) => i.name === 'Amuleto Estranho'),
    false,
  );

  // Narrativa ativa NÃO contém ações posteriores ao CP1, mas contém seed + ação pré-CP1 + aviso de restauração
  const postRestoreNarrativeAudit = classifyNarrativeEntriesForAudit(
    restoredCampaign,
    store.getNarrativeList(cid),
  );
  assert.equal(
    postRestoreNarrativeAudit.active.some((e) => e.content.includes('floresta proibida')),
    false,
  );
  assert.equal(
    postRestoreNarrativeAudit.active.some((e) => e.content.includes('mapa da Vila de Freixo')),
    true,
  );
  assert.equal(
    postRestoreNarrativeAudit.active.some((e) => e.content.includes('Ponto de controle restaurado: "Marco Inicial"')),
    true,
  );

  // Histórico antigo continua preservado para auditoria e marcado como outra linha temporal
  assert.equal(postRestoreNarrativeAudit.superseded.length, 2);
  assert.equal(
    postRestoreNarrativeAudit.superseded.some((e) => e.content.includes('floresta proibida')),
    true,
  );

  const eventAudit = classifyEventsForAudit(restoredCampaign, store.getEventsList(cid));
  assert.equal(eventAudit.superseded.length, 4);
  assert.equal(
    eventAudit.active.some((e) => e.type === 'CHECKPOINT_LOADED'),
    true,
  );

  // Nova ação na nova linha temporal continua coerentemente na narrativa ativa
  store.applyPlayerAction(cid, 'Samuel ajuda Henrique na oficina de madeira.', 20);
  const afterNewBranchAudit = classifyNarrativeEntriesForAudit(
    store.getCampaign(cid),
    store.getNarrativeList(cid),
  );
  assert.equal(
    afterNewBranchAudit.active.some((e) => e.content.includes('oficina de madeira')),
    true,
  );
  assert.equal(
    afterNewBranchAudit.active.some((e) => e.content.includes('floresta proibida')),
    false,
  );
});

test('Multi-ramificação: alternar entre checkpoints de linhas temporais diferentes preserva coerência', async () => {
  const uid = 'user_alpha';
  const store = new InMemoryTransactionalStore();
  const bundle = createEchoArcBundle(uid);
  store.seedBundle(bundle);
  const cid = bundle.campaign.id;

  store.applyPlayerAction(cid, 'Ação Ramo 1 - Base', 10);
  const cp1 = await saveCheckpointInStore(store, uid, cid, 'CP1 Base');

  store.applyPlayerAction(cid, 'Ação Ramo 1 - Abandonada', 10);

  // Volta para CP1 -> abre ramo 2
  await executeRestoreCheckpointTransaction(
    store.createPort(uid),
    store.getCampaign(cid),
    cp1,
    store.getInventoryList(cid),
    store.getNpcsList(cid),
  );
  store.applyPlayerAction(cid, 'Ação Ramo 2 - Escolhida', 15);
  const cp2 = await saveCheckpointInStore(store, uid, cid, 'CP2 Ramo 2');

  store.applyPlayerAction(cid, 'Ação Ramo 2 - Depois de CP2', 15);

  // Restaura CP2 -> deve manter Ramo 1 Base + Ramo 2 Escolhida, ocultar Abandonada e Depois de CP2
  await executeRestoreCheckpointTransaction(
    store.createPort(uid),
    store.getCampaign(cid),
    cp2,
    store.getInventoryList(cid),
    store.getNpcsList(cid),
  );
  let audit = classifyNarrativeEntriesForAudit(store.getCampaign(cid), store.getNarrativeList(cid));
  assert.equal(audit.active.some((e) => e.content.includes('Ramo 1 - Base')), true);
  assert.equal(audit.active.some((e) => e.content.includes('Ramo 2 - Escolhida')), true);
  assert.equal(audit.active.some((e) => e.content.includes('Ramo 1 - Abandonada')), false);
  assert.equal(audit.active.some((e) => e.content.includes('Depois de CP2')), false);

  // Volta novamente para CP1 -> deve ocultar também Ramo 2 - Escolhida
  await executeRestoreCheckpointTransaction(
    store.createPort(uid),
    store.getCampaign(cid),
    cp1,
    store.getInventoryList(cid),
    store.getNpcsList(cid),
  );
  audit = classifyNarrativeEntriesForAudit(store.getCampaign(cid), store.getNarrativeList(cid));
  assert.equal(audit.active.some((e) => e.content.includes('Ramo 1 - Base')), true);
  assert.equal(audit.active.some((e) => e.content.includes('Ramo 2 - Escolhida')), false);
});

test('Compatibilidade retroativa: campanhas e checkpoints legados sem campos de linha temporal restauram com coerência', async () => {
  const uid = 'user_legacy';
  const store = new InMemoryTransactionalStore();
  const bundle = createEchoArcBundle(uid);

  // Remove novos campos opcionais simulando documentos gravados antes desta atualização
  const legacyCampaign: Campaign = { ...bundle.campaign };
  delete legacyCampaign.activeTimelineId;
  delete legacyCampaign.timelineLineage;

  const legacyNarrativeSeed: NarrativeEntry = { ...bundle.narrative[0] };
  delete legacyNarrativeSeed.timelineId;

  const legacyEventSeed: GameEvent = { ...bundle.events[0] };
  delete legacyEventSeed.timelineId;

  store.campaigns.set(legacyCampaign.id, legacyCampaign);
  store.inventory.set(
    legacyCampaign.id,
    new Map(bundle.inventory.map((i) => [i.id, structuredClone(i)])),
  );
  store.npcs.set(legacyCampaign.id, new Map(bundle.npcs.map((n) => [n.id, structuredClone(n)])));
  store.narrative.set(legacyCampaign.id, new Map([[legacyNarrativeSeed.id, legacyNarrativeSeed]]));
  store.events.set(legacyCampaign.id, new Map([[legacyEventSeed.id, legacyEventSeed]]));

  // Checkpoint legado salvo na sequência 3 (sem timelineId, narrativeCutoffSequence ou timelineLineageSnapshot)
  const legacyCheckpoint: Checkpoint = {
    id: 'chk_legacy_1',
    ownerId: uid,
    campaignId: legacyCampaign.id,
    label: 'Checkpoint Legado',
    note: '',
    revision: 1,
    lastSequence: 3,
    currentLocation: legacyCampaign.currentLocation,
    protagonist: structuredClone(legacyCampaign.protagonist),
    currency: structuredClone(legacyCampaign.currency),
    worldTime: structuredClone(legacyCampaign.worldTime),
    inventorySnapshot: bundle.inventory.map((i) => ({
      id: i.id,
      name: i.name,
      category: i.category,
      quantity: i.quantity,
      description: i.description,
      equipable: i.equipable,
      equipped: i.equipped,
    })),
    npcsSnapshot: bundle.npcs.map((n) => ({
      id: n.id,
      name: n.name,
      role: n.role,
      location: n.location,
      relationship: n.relationship,
      notes: n.notes,
    })),
  };
  store.checkpoints.set(legacyCampaign.id, new Map([[legacyCheckpoint.id, legacyCheckpoint]]));

  // Acontecimento legado criado depois do checkpoint (sem timelineId, seq 4 e 5)
  const legacyPostAction: NarrativeEntry = {
    id: 'nar_legacy_post_1',
    ownerId: uid,
    campaignId: legacyCampaign.id,
    sequence: 4,
    authorRole: 'player_action',
    content: 'Decisão legada pós-checkpoint que deve ser arquivada na restauração.',
    worldTimeLabel: 'Dia 14 de Broto',
  };
  store.narrative.get(legacyCampaign.id)!.set(legacyPostAction.id, legacyPostAction);
  store.campaigns.set(legacyCampaign.id, {
    ...legacyCampaign,
    revision: 2,
    lastSequence: 5,
    currency: { gold: 9, silver: 0, copper: 0 },
  });

  await executeRestoreCheckpointTransaction(
    store.createPort(uid),
    store.getCampaign(legacyCampaign.id),
    legacyCheckpoint,
    store.getInventoryList(legacyCampaign.id),
    store.getNpcsList(legacyCampaign.id),
  );

  const restored = store.getCampaign(legacyCampaign.id);
  assert.deepEqual(restored.currency, { gold: 0, silver: 2, copper: 15 });

  const audit = classifyNarrativeEntriesForAudit(
    restored,
    store.getNarrativeList(legacyCampaign.id),
  );
  assert.equal(audit.active.some((e) => e.id === legacyNarrativeSeed.id), true);
  assert.equal(audit.active.some((e) => e.id === legacyPostAction.id), false);
  assert.equal(audit.superseded.some((e) => e.id === legacyPostAction.id), true);
});

test('Atomicidade: falha intermediária durante a transação não deixa nenhuma alteração parcial', async () => {
  const uid = 'user_alpha';
  const store = new InMemoryTransactionalStore();
  const bundle = createEchoArcBundle(uid);
  store.seedBundle(bundle);
  const cid = bundle.campaign.id;

  const cp1 = await saveCheckpointInStore(store, uid, cid, 'CP Seguro');

  store.applyInventoryAdd(cid, 'Espada de Madeira', 1);
  store.applyInventoryAdd(cid, 'Erva Medicinal', 3);
  store.applyCurrencyDelta(cid, { silver: 5 });
  store.applyPlayerAction(cid, 'Ação antes da falha simulada.', 30);

  const beforeFailureCampaign = store.getCampaign(cid);
  const beforeFailureInventory = store.getInventoryList(cid);
  const beforeFailureNarrative = store.getNarrativeList(cid);
  const beforeFailureEvents = store.getEventsList(cid);

  // Simula falha na 3ª escrita da transação (após updateCampaign e deleteInventoryItem terem sido enfileirados)
  const port = store.createPort(uid);
  store.failOnWriteNumber = 3;

  await assert.rejects(
    () =>
      executeRestoreCheckpointTransaction(
        port,
        store.getCampaign(cid),
        cp1,
        store.getInventoryList(cid),
        store.getNpcsList(cid),
      ),
    /SIMULATED_INTERMEDIATE_FAILURE_AT_WRITE_3/,
  );

  // Nenhuma alteração parcial deve ter sido persistida
  assert.deepEqual(store.getCampaign(cid), beforeFailureCampaign);
  assert.deepEqual(store.getInventoryList(cid), beforeFailureInventory);
  assert.deepEqual(store.getNarrativeList(cid), beforeFailureNarrative);
  assert.deepEqual(store.getEventsList(cid), beforeFailureEvents);
});

test('Limite atômico da beta: restauração acima do limite é rejeitada antes de iniciar transação ou alterar dados', async () => {
  const uid = 'user_alpha';
  const store = new InMemoryTransactionalStore();
  const bundle = createEchoArcBundle(uid);
  store.seedBundle(bundle);
  const cid = bundle.campaign.id;

  const cp1 = await saveCheckpointInStore(store, uid, cid, 'CP Limite');

  // Adiciona itens suficientes para exceder BETA_MAX_ATOMIC_RESTORE_SUBCOLLECTION_OPS (18)
  for (let i = 1; i <= LIMITS.BETA_MAX_ATOMIC_RESTORE_SUBCOLLECTION_OPS; i += 1) {
    store.applyInventoryAdd(cid, `Item Extra ${i}`, 1);
  }

  const callsBefore = store.transactionCalls;
  const campaignBefore = store.getCampaign(cid);
  const inventoryBefore = store.getInventoryList(cid);

  const plan = prepareCheckpointRestore(
    campaignBefore,
    cp1,
    inventoryBefore,
    store.getNpcsList(cid),
  );
  assert.equal(plan.ok, false);
  if (!plan.ok) {
    assert.match(plan.error, /ATOMIC_LIMIT_EXCEEDED/);
  }

  await assert.rejects(
    () =>
      executeRestoreCheckpointTransaction(
        store.createPort(uid),
        campaignBefore,
        cp1,
        inventoryBefore,
        store.getNpcsList(cid),
      ),
    /ATOMIC_LIMIT_EXCEEDED/,
  );

  // Garante que a transação nem foi iniciada e nenhum dado mudou
  assert.equal(store.transactionCalls, callsBefore);
  assert.deepEqual(store.getCampaign(cid), campaignBefore);
  assert.deepEqual(store.getInventoryList(cid), inventoryBefore);
});

test('Concorrência e revisões: modificação concorrente aborta salvamento e restauração sem alterações parciais', async () => {
  const uid = 'user_alpha';
  const store = new InMemoryTransactionalStore();
  const bundle = createEchoArcBundle(uid);
  store.seedBundle(bundle);
  const cid = bundle.campaign.id;

  const cp1 = await saveCheckpointInStore(store, uid, cid, 'CP Base');
  const staleCampaign = store.getCampaign(cid);
  const staleInventory = store.getInventoryList(cid);
  const staleNpcs = store.getNpcsList(cid);

  // Outra aba avança a revisão no servidor enquanto o cliente segura snapshot desatualizado
  const port = store.createPort(uid);
  store.onBeforeTransactionRead = () => {
    store.applyPlayerAction(cid, 'Ação concorrente em outra aba.', 10);
  };

  await assert.rejects(
    () =>
      executeRestoreCheckpointTransaction(
        port,
        staleCampaign,
        cp1,
        staleInventory,
        staleNpcs,
      ),
    /CONCURRENT_REVISION_CONFLICT/,
  );

  // Estado da ação concorrente permanece intacto e nenhum evento CHECKPOINT_LOADED foi gravado
  assert.equal(
    store.getEventsList(cid).some((e) => e.type === 'CHECKPOINT_LOADED'),
    false,
  );
  assert.equal(store.getCampaign(cid).revision, staleCampaign.revision + 1);

  // Também testa conflito concorrente no salvamento de checkpoint
  const staleForSave = store.getCampaign(cid);
  const built = buildCheckpointPayload(
    staleForSave,
    store.getInventoryList(cid),
    store.getNpcsList(cid),
    'CP Concorrente',
    '',
  );
  if (!built.ok) assert.fail(built.error);

  store.applyTimeAdvance(cid, 15);

  await assert.rejects(
    () =>
      executeSaveCheckpointTransaction(
        store.createPort(uid),
        cid,
        built.data.checkpoint,
        built.data.event,
        built.data.expectedRevision,
        built.data.nextRevision,
        built.data.nextLastSequence,
      ),
    /CONCURRENT_REVISION_CONFLICT/,
  );
  assert.equal(store.checkpoints.get(cid)!.has(built.data.checkpoint.id), false);
});

test('Regras do Firestore mantêm isolamento, compatibilidade retroativa e suporte a timelineLineage', () => {
  const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
  const rulesText = fs.readFileSync(rulesPath, 'utf8');

  assert.equal(/allow\s+read,\s*write:\s*if\s+true/.test(rulesText), false);
  assert.match(rulesText, /isValidTimelineSegment/);
  assert.match(rulesText, /activeTimelineId/);
  assert.match(rulesText, /timelineLineage/);
  assert.match(rulesText, /narrativeCutoffSequence/);
  assert.match(rulesText, /timelineLineageSnapshot/);
});
