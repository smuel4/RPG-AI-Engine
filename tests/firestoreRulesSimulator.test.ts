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
import { createCustomCampaignBundle, createEchoArcBundle } from '../src/engine/echoArcFixture';
import {
  buildCheckpointPayload,
  processCurrencyMutation,
  processInventoryMutation,
  processPlayerAction,
  processTimeAdvance,
} from '../src/engine/rulesEngine';
import {
  attachFirestoreContext,
  executeRestoreCheckpointTransaction,
  executeSaveCheckpointTransaction,
  extractFirestoreContext,
  type CheckpointTransactionContext,
  type CheckpointTransactionPort,
} from '../src/services/checkpointTransaction';

const SERVER_TIMESTAMP = Symbol('serverTimestamp');

class SimulatedTimestamp {
  constructor(public readonly ms: number) {}
}

interface AuthContext {
  uid: string;
  emailVerified: boolean;
}

type RulesProfile = 'current_v3' | 'legacy_v2_pre_timeline';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && !(v instanceof SimulatedTimestamp);
}

function hasAll(obj: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

function hasOnly(obj: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(obj).every((k) => allowed.has(k));
}

function isValidId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length >= 1 &&
    id.length <= 128 &&
    /^[a-zA-Z0-9_-]+$/.test(id)
  );
}

function isValidOwnerId(uid: unknown, auth: AuthContext | null): boolean {
  return Boolean(
    auth &&
      typeof uid === 'string' &&
      uid.length >= 1 &&
      uid.length <= 128 &&
      uid === auth.uid,
  );
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function deepEqualValues(a: unknown, b: unknown): boolean {
  if (a instanceof SimulatedTimestamp && b instanceof SimulatedTimestamp) {
    return a.ms === b.ms;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function affectedKeys(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(incoming), ...Object.keys(existing)]);
  const changed: string[] = [];
  for (const k of keys) {
    const inHas = Object.prototype.hasOwnProperty.call(incoming, k);
    const exHas = Object.prototype.hasOwnProperty.call(existing, k);
    if (inHas !== exHas || !deepEqualValues(incoming[k], existing[k])) {
      changed.push(k);
    }
  }
  return changed;
}

function affectedKeysHasOnly(changed: string[], allowed: string[]): boolean {
  const set = new Set(allowed);
  return changed.every((k) => set.has(k));
}

function isValidProtagonist(p: unknown): boolean {
  if (!isPlainObject(p)) return false;
  const keys = [
    'name',
    'age',
    'origin',
    'futureHook',
    'vitality',
    'maxVitality',
    'focus',
    'maxFocus',
    'disposition',
  ];
  return (
    hasAll(p, keys) &&
    hasOnly(p, keys) &&
    typeof p.name === 'string' &&
    p.name.length >= 1 &&
    p.name.length <= 80 &&
    isInt(p.age) &&
    p.age >= 1 &&
    p.age <= 200 &&
    typeof p.origin === 'string' &&
    p.origin.length >= 1 &&
    p.origin.length <= 240 &&
    typeof p.futureHook === 'string' &&
    p.futureHook.length >= 0 &&
    p.futureHook.length <= 240 &&
    isInt(p.vitality) &&
    p.vitality >= 0 &&
    p.vitality <= 9999 &&
    isInt(p.maxVitality) &&
    p.maxVitality >= 1 &&
    p.maxVitality <= 9999 &&
    isInt(p.focus) &&
    p.focus >= 0 &&
    p.focus <= 9999 &&
    isInt(p.maxFocus) &&
    p.maxFocus >= 1 &&
    p.maxFocus <= 9999 &&
    typeof p.disposition === 'string' &&
    p.disposition.length >= 1 &&
    p.disposition.length <= 80
  );
}

function isValidCurrency(c: unknown): boolean {
  if (!isPlainObject(c)) return false;
  const keys = ['gold', 'silver', 'copper'];
  return (
    hasAll(c, keys) &&
    hasOnly(c, keys) &&
    isInt(c.gold) &&
    c.gold >= 0 &&
    c.gold <= 10000000 &&
    isInt(c.silver) &&
    c.silver >= 0 &&
    c.silver <= 10000000 &&
    isInt(c.copper) &&
    c.copper >= 0 &&
    c.copper <= 10000000
  );
}

function isValidWorldTime(t: unknown): boolean {
  if (!isPlainObject(t)) return false;
  const keys = ['year', 'month', 'day', 'weekday', 'season', 'hour', 'minute', 'periodOfDay'];
  return (
    hasAll(t, keys) &&
    hasOnly(t, keys) &&
    isInt(t.year) &&
    t.year >= 1 &&
    t.year <= 99999 &&
    isInt(t.month) &&
    t.month >= 1 &&
    t.month <= 12 &&
    isInt(t.day) &&
    t.day >= 1 &&
    t.day <= 31 &&
    typeof t.weekday === 'string' &&
    t.weekday.length >= 1 &&
    t.weekday.length <= 40 &&
    typeof t.season === 'string' &&
    t.season.length >= 1 &&
    t.season.length <= 40 &&
    isInt(t.hour) &&
    t.hour >= 0 &&
    t.hour <= 23 &&
    isInt(t.minute) &&
    t.minute >= 0 &&
    t.minute <= 59 &&
    typeof t.periodOfDay === 'string' &&
    t.periodOfDay.length >= 1 &&
    t.periodOfDay.length <= 40
  );
}

function isValidTimelineSegment(seg: unknown): boolean {
  if (!isPlainObject(seg)) return false;
  const keys = ['timelineId', 'fromSequence', 'toSequence'];
  return (
    hasAll(seg, keys) &&
    hasOnly(seg, keys) &&
    isValidId(seg.timelineId) &&
    isInt(seg.fromSequence) &&
    seg.fromSequence >= 0 &&
    (seg.toSequence === null || (isInt(seg.toSequence) && seg.toSequence >= seg.fromSequence))
  );
}

class FirestoreRulesSimulator {
  docs = new Map<string, Record<string, unknown>>();
  requestTimeMs = Date.UTC(2026, 10, 16, 12, 0, 0);

  constructor(private readonly profile: RulesProfile = 'current_v3') {}

  private resolveSentinels(
    value: unknown,
    requestTime: SimulatedTimestamp,
  ): unknown {
    if (value === SERVER_TIMESTAMP) {
      return requestTime;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.resolveSentinels(item, requestTime));
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined) {
          throw new Error(`Unsupported field value: undefined at key "${k}"`);
        }
        out[k] = this.resolveSentinels(v, requestTime);
      }
      return out;
    }
    return value;
  }

  private assertRule(condition: boolean, reason: string): void {
    if (!condition) {
      throw new Error(`PERMISSION_DENIED: ${reason}`);
    }
  }

  private evaluateRulesWriteBatch(
    auth: AuthContext | null,
    ops: Array<{
      kind: 'create' | 'update' | 'delete';
      path: string;
      rawData?: Record<string, unknown>;
    }>,
    extraRuleLookups = 0,
  ) {
    this.requestTimeMs += 1000;
    const reqTime = new SimulatedTimestamp(this.requestTimeMs);

    // Pre-computa estado "after" para getAfter()
    const afterMap = new Map(this.docs);
    const preparedWrites: Array<{
      kind: 'create' | 'update' | 'delete';
      path: string;
      existing: Record<string, unknown> | null;
      incoming: Record<string, unknown> | null;
    }> = [];

    for (const op of ops) {
      const existing = this.docs.get(op.path) ?? null;
      if (op.kind === 'create') {
        if (existing) throw new Error(`ALREADY_EXISTS: ${op.path}`);
        const incoming = this.resolveSentinels(op.rawData!, reqTime) as Record<string, unknown>;
        afterMap.set(op.path, incoming);
        preparedWrites.push({ kind: 'create', path: op.path, existing: null, incoming });
      } else if (op.kind === 'update') {
        if (!existing) throw new Error(`NOT_FOUND: ${op.path}`);
        const patch = this.resolveSentinels(op.rawData!, reqTime) as Record<string, unknown>;
        const incoming = { ...existing, ...patch };
        afterMap.set(op.path, incoming);
        preparedWrites.push({ kind: 'update', path: op.path, existing, incoming });
      } else {
        afterMap.delete(op.path);
        preparedWrites.push({ kind: 'delete', path: op.path, existing, incoming: null });
      }
    }

    const distinctLookupPaths = new Set<string>();
    const totalLookupEvaluations = extraRuleLookups;
    let lookupCalls = totalLookupEvaluations;

    const getBefore = (docPath: string) => {
      distinctLookupPaths.add(`before:${docPath}`);
      lookupCalls += 1;
      return this.docs.get(docPath) ?? null;
    };

    const getAfter = (docPath: string) => {
      distinctLookupPaths.add(`after:${docPath}`);
      lookupCalls += 1;
      return afterMap.get(docPath) ?? null;
    };

    const isSignedIn = () => auth !== null;
    const isVerified = () => Boolean(auth && auth.emailVerified === true);

    const isCampaignOwner = (campaignId: string) => {
      if (!isSignedIn() || !isVerified()) return false;
      const docData = getBefore(`campaigns/${campaignId}`);
      return docData !== null && docData.ownerId === auth!.uid;
    };

    const isCampaignOwnerAfter = (campaignId: string) => {
      if (!isSignedIn() || !isVerified()) return false;
      const docData = getAfter(`campaigns/${campaignId}`);
      return docData !== null && docData.ownerId === auth!.uid;
    };

    for (const w of preparedWrites) {
      const parts = w.path.split('/');
      if (parts.length === 2 && parts[0] === 'campaigns') {
        const campaignId = parts[1];
        this.assertRule(isSignedIn() && isVerified(), `Auth required/verified for ${w.path}`);
        this.assertRule(isValidId(campaignId), `Invalid campaignId: ${campaignId}`);

        if (w.kind === 'create') {
          this.validateCampaignDoc(w.incoming!, auth!, w.path);
          this.assertRule(w.incoming!.id === campaignId, `id mismatch on ${w.path}`);
          this.assertRule(
            w.incoming!.createdAt === reqTime && w.incoming!.updatedAt === reqTime,
            `createdAt/updatedAt must equal request.time on ${w.path}`,
          );
        } else if (w.kind === 'update') {
          const ex = w.existing!;
          const inc = w.incoming!;
          this.validateCampaignDoc(inc, auth!, w.path);
          this.assertRule(ex.ownerId === auth!.uid, `Non-owner update on ${w.path}`);
          this.assertRule(ex.status !== 'archived', `Archived campaign locked on ${w.path}`);
          this.assertRule(inc.id === ex.id, `Immutable id changed on ${w.path}`);
          this.assertRule(inc.ownerId === ex.ownerId, `Immutable ownerId changed on ${w.path}`);
          this.assertRule(
            deepEqualValues(inc.createdAt, ex.createdAt),
            `Immutable createdAt changed on ${w.path}`,
          );
          this.assertRule(inc.updatedAt === reqTime, `updatedAt != request.time on ${w.path}`);
          this.assertRule(
            isInt(ex.revision) && inc.revision === ex.revision + 1,
            `revision must increment by 1 on ${w.path}`,
          );

          const changed = affectedKeys(inc, ex);
          const allowedRestoreKeys =
            this.profile === 'current_v3'
              ? [
                  'protagonist',
                  'currency',
                  'worldTime',
                  'currentLocation',
                  'lastSequence',
                  'revision',
                  'updatedAt',
                  'activeTimelineId',
                  'timelineLineage',
                ]
              : [
                  'protagonist',
                  'currency',
                  'worldTime',
                  'currentLocation',
                  'lastSequence',
                  'revision',
                  'updatedAt',
                ];

          const actionAllowed =
            affectedKeysHasOnly(changed, [
              'worldTime',
              'lastSequence',
              'revision',
              'updatedAt',
              'currentLocation',
              'protagonist',
            ]) ||
            affectedKeysHasOnly(changed, ['lastSequence', 'revision', 'updatedAt']) ||
            affectedKeysHasOnly(changed, ['currency', 'lastSequence', 'revision', 'updatedAt']) ||
            affectedKeysHasOnly(changed, allowedRestoreKeys) ||
            (inc.status === 'archived' &&
              affectedKeysHasOnly(changed, ['status', 'revision', 'updatedAt']));

          this.assertRule(
            actionAllowed,
            `Disallowed affectedKeys [${changed.join(', ')}] on ${w.path} under profile ${this.profile}`,
          );
        } else {
          this.assertRule(w.existing !== null && w.existing.ownerId === auth!.uid, `Delete denied on ${w.path}`);
        }
      } else if (parts.length === 4 && parts[0] === 'campaigns') {
        const [, campaignId, sub, subId] = parts;
        this.assertRule(isValidId(campaignId) && isValidId(subId), `Invalid path IDs on ${w.path}`);

        if (sub === 'inventory') {
          if (w.kind === 'create') {
            this.validateInventoryDoc(w.incoming!, campaignId, auth!, w.path);
            this.assertRule(w.incoming!.id === subId, `id mismatch on ${w.path}`);
            this.assertRule(
              w.incoming!.createdAt === reqTime && w.incoming!.updatedAt === reqTime,
              `timestamp mismatch on ${w.path}`,
            );
            this.assertRule(
              isCampaignOwner(campaignId) || isCampaignOwnerAfter(campaignId),
              `Master Gate failed on ${w.path}`,
            );
          } else if (w.kind === 'update') {
            const ex = w.existing!;
            const inc = w.incoming!;
            this.validateInventoryDoc(inc, campaignId, auth!, w.path);
            this.assertRule(isCampaignOwner(campaignId), `Master Gate failed on ${w.path}`);
            this.assertRule(
              inc.id === ex.id &&
                inc.ownerId === ex.ownerId &&
                inc.campaignId === ex.campaignId &&
                deepEqualValues(inc.createdAt, ex.createdAt) &&
                inc.updatedAt === reqTime,
              `Immutable/timestamp check failed on ${w.path}`,
            );
            const changed = affectedKeys(inc, ex);
            this.assertRule(
              affectedKeysHasOnly(changed, [
                'quantity',
                'equipped',
                'description',
                'name',
                'category',
                'equipable',
                'updatedAt',
              ]),
              `Disallowed inventory update keys [${changed.join(', ')}] on ${w.path}`,
            );
          } else {
            this.assertRule(isCampaignOwner(campaignId), `Master Gate delete failed on ${w.path}`);
          }
        } else if (sub === 'npcs') {
          if (w.kind === 'create') {
            this.validateNpcDoc(w.incoming!, campaignId, auth!, w.path);
            this.assertRule(w.incoming!.id === subId, `id mismatch on ${w.path}`);
            this.assertRule(
              w.incoming!.createdAt === reqTime && w.incoming!.updatedAt === reqTime,
              `timestamp mismatch on ${w.path}`,
            );
            this.assertRule(
              isCampaignOwner(campaignId) || isCampaignOwnerAfter(campaignId),
              `Master Gate failed on ${w.path}`,
            );
          } else if (w.kind === 'update') {
            const ex = w.existing!;
            const inc = w.incoming!;
            this.validateNpcDoc(inc, campaignId, auth!, w.path);
            this.assertRule(isCampaignOwner(campaignId), `Master Gate failed on ${w.path}`);
            this.assertRule(
              inc.id === ex.id &&
                inc.ownerId === ex.ownerId &&
                inc.campaignId === ex.campaignId &&
                deepEqualValues(inc.createdAt, ex.createdAt) &&
                inc.updatedAt === reqTime,
              `Immutable/timestamp check failed on ${w.path}`,
            );
            const changed = affectedKeys(inc, ex);
            this.assertRule(
              affectedKeysHasOnly(changed, [
                'name',
                'role',
                'location',
                'relationship',
                'notes',
                'updatedAt',
              ]),
              `Disallowed npc update keys [${changed.join(', ')}] on ${w.path}`,
            );
          } else {
            this.assertRule(isCampaignOwner(campaignId), `Master Gate delete failed on ${w.path}`);
          }
        } else if (sub === 'narrative') {
          this.assertRule(w.kind !== 'update', `Append-only narrative cannot be updated: ${w.path}`);
          if (w.kind === 'create') {
            this.validateNarrativeDoc(w.incoming!, campaignId, auth!, w.path);
            this.assertRule(w.incoming!.id === subId, `id mismatch on ${w.path}`);
            this.assertRule(w.incoming!.createdAt === reqTime, `createdAt != request.time on ${w.path}`);
            this.assertRule(
              isCampaignOwner(campaignId) || isCampaignOwnerAfter(campaignId),
              `Master Gate failed on ${w.path}`,
            );
          } else {
            this.assertRule(isCampaignOwner(campaignId), `Master Gate delete failed on ${w.path}`);
          }
        } else if (sub === 'events') {
          this.assertRule(w.kind !== 'update', `Append-only event cannot be updated: ${w.path}`);
          if (w.kind === 'create') {
            this.validateEventDoc(w.incoming!, campaignId, auth!, w.path);
            this.assertRule(w.incoming!.id === subId, `id mismatch on ${w.path}`);
            this.assertRule(w.incoming!.createdAt === reqTime, `createdAt != request.time on ${w.path}`);
            this.assertRule(
              isCampaignOwner(campaignId) || isCampaignOwnerAfter(campaignId),
              `Master Gate failed on ${w.path}`,
            );
          } else {
            this.assertRule(isCampaignOwner(campaignId), `Master Gate delete failed on ${w.path}`);
          }
        } else if (sub === 'checkpoints') {
          this.assertRule(w.kind !== 'update', `Checkpoint cannot be updated in-place: ${w.path}`);
          if (w.kind === 'create') {
            this.validateCheckpointDoc(w.incoming!, campaignId, auth!, w.path);
            this.assertRule(w.incoming!.id === subId, `id mismatch on ${w.path}`);
            this.assertRule(w.incoming!.createdAt === reqTime, `createdAt != request.time on ${w.path}`);
            this.assertRule(
              isCampaignOwner(campaignId) || isCampaignOwnerAfter(campaignId),
              `Master Gate failed on ${w.path}`,
            );
          } else {
            this.assertRule(isCampaignOwner(campaignId), `Master Gate delete failed on ${w.path}`);
          }
        } else {
          this.assertRule(false, `Default deny on unknown collection path ${w.path}`);
        }
      } else {
        this.assertRule(false, `Default deny on unmatched path ${w.path}`);
      }
    }

    // Firestore limits: 20 get/exists/getAfter calls per multi-doc batch/transaction (cached by distinct doc path)
    this.assertRule(
      distinctLookupPaths.size <= 20,
      `Firestore distinct get/getAfter limit exceeded (${distinctLookupPaths.size} > 20)`,
    );
    // Even without path caching, our beta limit (18 sub ops + 1 checkpoint get) keeps total lookup calls <= 20
    assert.ok(lookupCalls <= 20, `Expected total lookup calls <= 20, got ${lookupCalls}`);

    this.docs = afterMap;
  }

  private validateCampaignDoc(data: Record<string, unknown>, auth: AuthContext, docPath: string) {
    const reqKeys = [
      'id',
      'ownerId',
      'name',
      'setting',
      'currentLocation',
      'status',
      'revision',
      'lastSequence',
      'protagonist',
      'currency',
      'worldTime',
      'createdAt',
      'updatedAt',
    ];
    const allowedKeys =
      this.profile === 'current_v3'
        ? [...reqKeys, 'activeTimelineId', 'timelineLineage']
        : reqKeys;

    this.assertRule(hasAll(data, reqKeys), `Missing required campaign keys on ${docPath}`);
    this.assertRule(
      hasOnly(data, allowedKeys),
      `Disallowed campaign keys on ${docPath} under ${this.profile}`,
    );
    this.assertRule(isValidId(data.id), `Invalid campaign.id on ${docPath}`);
    this.assertRule(isValidOwnerId(data.ownerId, auth), `Invalid campaign.ownerId on ${docPath}`);
    this.assertRule(
      typeof data.name === 'string' && data.name.length >= 1 && data.name.length <= 80,
      `Invalid campaign.name on ${docPath}`,
    );
    this.assertRule(
      typeof data.setting === 'string' && data.setting.length >= 1 && data.setting.length <= 240,
      `Invalid campaign.setting on ${docPath}`,
    );
    this.assertRule(
      typeof data.currentLocation === 'string' &&
        data.currentLocation.length >= 1 &&
        data.currentLocation.length <= 120,
      `Invalid campaign.currentLocation on ${docPath}`,
    );
    this.assertRule(
      data.status === 'active' || data.status === 'archived',
      `Invalid campaign.status on ${docPath}`,
    );
    this.assertRule(isInt(data.revision) && data.revision >= 1, `Invalid campaign.revision on ${docPath}`);
    this.assertRule(
      isInt(data.lastSequence) && data.lastSequence >= 0,
      `Invalid campaign.lastSequence on ${docPath}`,
    );
    this.assertRule(isValidProtagonist(data.protagonist), `Invalid campaign.protagonist on ${docPath}`);
    this.assertRule(isValidCurrency(data.currency), `Invalid campaign.currency on ${docPath}`);
    this.assertRule(isValidWorldTime(data.worldTime), `Invalid campaign.worldTime on ${docPath}`);

    if (this.profile === 'current_v3') {
      this.assertRule(
        !('activeTimelineId' in data) || isValidId(data.activeTimelineId),
        `Invalid campaign.activeTimelineId on ${docPath}`,
      );
      this.assertRule(
        !('timelineLineage' in data) ||
          (Array.isArray(data.timelineLineage) &&
            data.timelineLineage.length >= 1 &&
            data.timelineLineage.length <= 64 &&
            isValidTimelineSegment(data.timelineLineage[0]) &&
            (data.timelineLineage.length === 1 ||
              isValidTimelineSegment(data.timelineLineage[data.timelineLineage.length - 1]))),
        `Invalid campaign.timelineLineage on ${docPath}`,
      );
    }

    this.assertRule(
      data.createdAt instanceof SimulatedTimestamp && data.updatedAt instanceof SimulatedTimestamp,
      `createdAt/updatedAt must be timestamps on ${docPath}`,
    );
  }

  private validateInventoryDoc(
    data: Record<string, unknown>,
    campaignId: string,
    auth: AuthContext,
    docPath: string,
  ) {
    const keys = [
      'id',
      'ownerId',
      'campaignId',
      'name',
      'category',
      'quantity',
      'description',
      'equipable',
      'equipped',
      'createdAt',
      'updatedAt',
    ];
    this.assertRule(hasAll(data, keys) && hasOnly(data, keys), `Invalid inventory keys on ${docPath}`);
    this.assertRule(isValidId(data.id) && isValidOwnerId(data.ownerId, auth), `Invalid ID/owner on ${docPath}`);
    this.assertRule(data.campaignId === campaignId, `campaignId mismatch on ${docPath}`);
    this.assertRule(
      typeof data.name === 'string' && data.name.length >= 1 && data.name.length <= 80,
      `Invalid item name on ${docPath}`,
    );
    this.assertRule(
      ['equipamento', 'consumivel', 'documento', 'recurso', 'chave'].includes(
        String(data.category),
      ),
      `Invalid item category on ${docPath}`,
    );
    this.assertRule(
      isInt(data.quantity) && data.quantity >= 0 && data.quantity <= 99999,
      `Invalid item quantity on ${docPath}`,
    );
    this.assertRule(
      typeof data.description === 'string' && data.description.length <= 240,
      `Invalid item description on ${docPath}`,
    );
    this.assertRule(
      typeof data.equipable === 'boolean' &&
        typeof data.equipped === 'boolean' &&
        (!data.equipped || data.equipable),
      `Invalid equipable/equipped invariant on ${docPath}`,
    );
    this.assertRule(
      data.createdAt instanceof SimulatedTimestamp && data.updatedAt instanceof SimulatedTimestamp,
      `Timestamps invalid on ${docPath}`,
    );
  }

  private validateNpcDoc(
    data: Record<string, unknown>,
    campaignId: string,
    auth: AuthContext,
    docPath: string,
  ) {
    const keys = [
      'id',
      'ownerId',
      'campaignId',
      'name',
      'role',
      'location',
      'relationship',
      'notes',
      'createdAt',
      'updatedAt',
    ];
    this.assertRule(hasAll(data, keys) && hasOnly(data, keys), `Invalid npc keys on ${docPath}`);
    this.assertRule(isValidId(data.id) && isValidOwnerId(data.ownerId, auth), `Invalid ID/owner on ${docPath}`);
    this.assertRule(data.campaignId === campaignId, `campaignId mismatch on ${docPath}`);
    this.assertRule(
      typeof data.name === 'string' &&
        data.name.length >= 1 &&
        data.name.length <= 80 &&
        typeof data.role === 'string' &&
        data.role.length >= 1 &&
        data.role.length <= 80 &&
        typeof data.location === 'string' &&
        data.location.length >= 1 &&
        data.location.length <= 120 &&
        typeof data.relationship === 'string' &&
        data.relationship.length >= 1 &&
        data.relationship.length <= 80 &&
        typeof data.notes === 'string' &&
        data.notes.length <= 300,
      `Invalid npc string lengths on ${docPath}`,
    );
    this.assertRule(
      data.createdAt instanceof SimulatedTimestamp && data.updatedAt instanceof SimulatedTimestamp,
      `Timestamps invalid on ${docPath}`,
    );
  }

  private validateNarrativeDoc(
    data: Record<string, unknown>,
    campaignId: string,
    auth: AuthContext,
    docPath: string,
  ) {
    const reqKeys = [
      'id',
      'ownerId',
      'campaignId',
      'sequence',
      'authorRole',
      'content',
      'worldTimeLabel',
      'createdAt',
    ];
    const allowedKeys =
      this.profile === 'current_v3'
        ? [
            'id',
            'ownerId',
            'campaignId',
            'timelineId',
            'sequence',
            'authorRole',
            'content',
            'worldTimeLabel',
            'createdAt',
          ]
        : reqKeys;
    this.assertRule(hasAll(data, reqKeys), `Missing narrative keys on ${docPath}`);
    this.assertRule(
      hasOnly(data, allowedKeys),
      `Disallowed narrative keys on ${docPath} under ${this.profile}`,
    );
    this.assertRule(isValidId(data.id) && isValidOwnerId(data.ownerId, auth), `Invalid ID/owner on ${docPath}`);
    this.assertRule(data.campaignId === campaignId, `campaignId mismatch on ${docPath}`);
    if (this.profile === 'current_v3') {
      this.assertRule(
        !('timelineId' in data) || isValidId(data.timelineId),
        `Invalid narrative.timelineId on ${docPath}`,
      );
    }
    this.assertRule(isInt(data.sequence) && data.sequence >= 1, `Invalid sequence on ${docPath}`);
    this.assertRule(
      ['system_seed', 'player_action', 'engine_response'].includes(String(data.authorRole)),
      `Invalid authorRole on ${docPath}`,
    );
    this.assertRule(
      typeof data.content === 'string' && data.content.length >= 1 && data.content.length <= 2000,
      `Invalid content on ${docPath}`,
    );
    this.assertRule(
      typeof data.worldTimeLabel === 'string' &&
        data.worldTimeLabel.length >= 1 &&
        data.worldTimeLabel.length <= 120,
      `Invalid worldTimeLabel on ${docPath}`,
    );
    this.assertRule(data.createdAt instanceof SimulatedTimestamp, `createdAt invalid on ${docPath}`);
  }

  private validateEventDoc(
    data: Record<string, unknown>,
    campaignId: string,
    auth: AuthContext,
    docPath: string,
  ) {
    const reqKeys = [
      'id',
      'ownerId',
      'campaignId',
      'sequence',
      'type',
      'summary',
      'actor',
      'beforeSummary',
      'afterSummary',
      'worldTimeLabel',
      'createdAt',
    ];
    const allowedKeys =
      this.profile === 'current_v3'
        ? [
            'id',
            'ownerId',
            'campaignId',
            'timelineId',
            'sequence',
            'type',
            'summary',
            'actor',
            'beforeSummary',
            'afterSummary',
            'worldTimeLabel',
            'createdAt',
          ]
        : reqKeys;
    this.assertRule(hasAll(data, reqKeys), `Missing event keys on ${docPath}`);
    this.assertRule(
      hasOnly(data, allowedKeys),
      `Disallowed event keys on ${docPath} under ${this.profile}`,
    );
    this.assertRule(isValidId(data.id) && isValidOwnerId(data.ownerId, auth), `Invalid ID/owner on ${docPath}`);
    this.assertRule(data.campaignId === campaignId, `campaignId mismatch on ${docPath}`);
    if (this.profile === 'current_v3') {
      this.assertRule(
        !('timelineId' in data) || isValidId(data.timelineId),
        `Invalid event.timelineId on ${docPath}`,
      );
    }
    this.assertRule(isInt(data.sequence) && data.sequence >= 1, `Invalid sequence on ${docPath}`);
    this.assertRule(
      [
        'CAMPAIGN_CREATED',
        'PLAYER_ACTION',
        'INVENTORY_ADDED',
        'INVENTORY_UPDATED',
        'INVENTORY_REMOVED',
        'CURRENCY_UPDATED',
        'TIME_ADVANCED',
        'CHECKPOINT_SAVED',
        'CHECKPOINT_LOADED',
      ].includes(String(data.type)),
      `Invalid event type on ${docPath}`,
    );
    this.assertRule(
      typeof data.summary === 'string' &&
        data.summary.length >= 1 &&
        data.summary.length <= 240 &&
        typeof data.actor === 'string' &&
        data.actor.length >= 1 &&
        data.actor.length <= 80 &&
        typeof data.beforeSummary === 'string' &&
        data.beforeSummary.length <= 400 &&
        typeof data.afterSummary === 'string' &&
        data.afterSummary.length <= 400 &&
        typeof data.worldTimeLabel === 'string' &&
        data.worldTimeLabel.length >= 1 &&
        data.worldTimeLabel.length <= 120,
      `Invalid event strings on ${docPath}`,
    );
    this.assertRule(data.createdAt instanceof SimulatedTimestamp, `createdAt invalid on ${docPath}`);
  }

  private validateCheckpointDoc(
    data: Record<string, unknown>,
    campaignId: string,
    auth: AuthContext,
    docPath: string,
  ) {
    const reqKeys = [
      'id',
      'ownerId',
      'campaignId',
      'label',
      'note',
      'revision',
      'lastSequence',
      'currentLocation',
      'protagonist',
      'currency',
      'worldTime',
      'inventorySnapshot',
      'npcsSnapshot',
      'createdAt',
    ];
    const allowedKeys =
      this.profile === 'current_v3'
        ? [
            'id',
            'ownerId',
            'campaignId',
            'label',
            'note',
            'revision',
            'lastSequence',
            'timelineId',
            'narrativeCutoffSequence',
            'timelineLineageSnapshot',
            'currentLocation',
            'protagonist',
            'currency',
            'worldTime',
            'inventorySnapshot',
            'npcsSnapshot',
            'createdAt',
          ]
        : reqKeys;

    this.assertRule(hasAll(data, reqKeys), `Missing checkpoint keys on ${docPath}`);
    this.assertRule(
      hasOnly(data, allowedKeys),
      `Disallowed checkpoint keys on ${docPath} under ${this.profile}`,
    );
    this.assertRule(isValidId(data.id) && isValidOwnerId(data.ownerId, auth), `Invalid ID/owner on ${docPath}`);
    this.assertRule(data.campaignId === campaignId, `campaignId mismatch on ${docPath}`);
    this.assertRule(
      typeof data.label === 'string' && data.label.length >= 1 && data.label.length <= 80,
      `Invalid checkpoint.label on ${docPath}`,
    );
    this.assertRule(
      typeof data.note === 'string' && data.note.length <= 240,
      `Invalid checkpoint.note on ${docPath}`,
    );
    this.assertRule(
      isInt(data.revision) &&
        data.revision >= 1 &&
        isInt(data.lastSequence) &&
        data.lastSequence >= 0,
      `Invalid checkpoint revision/lastSequence on ${docPath}`,
    );

    if (this.profile === 'current_v3') {
      this.assertRule(
        !('timelineId' in data) || isValidId(data.timelineId),
        `Invalid checkpoint.timelineId on ${docPath}`,
      );
      this.assertRule(
        !('narrativeCutoffSequence' in data) ||
          (isInt(data.narrativeCutoffSequence) && data.narrativeCutoffSequence >= 0),
        `Invalid checkpoint.narrativeCutoffSequence on ${docPath}`,
      );
      this.assertRule(
        !('timelineLineageSnapshot' in data) ||
          (Array.isArray(data.timelineLineageSnapshot) &&
            data.timelineLineageSnapshot.length >= 1 &&
            data.timelineLineageSnapshot.length <= 64 &&
            isValidTimelineSegment(data.timelineLineageSnapshot[0]) &&
            (data.timelineLineageSnapshot.length === 1 ||
              isValidTimelineSegment(
                data.timelineLineageSnapshot[data.timelineLineageSnapshot.length - 1],
              ))),
        `Invalid checkpoint.timelineLineageSnapshot on ${docPath}`,
      );
    }

    this.assertRule(
      typeof data.currentLocation === 'string' &&
        data.currentLocation.length >= 1 &&
        data.currentLocation.length <= 120 &&
        isValidProtagonist(data.protagonist) &&
        isValidCurrency(data.currency) &&
        isValidWorldTime(data.worldTime) &&
        Array.isArray(data.inventorySnapshot) &&
        data.inventorySnapshot.length <= 100 &&
        (data.inventorySnapshot.length === 0 || isPlainObject(data.inventorySnapshot[0])) &&
        Array.isArray(data.npcsSnapshot) &&
        data.npcsSnapshot.length <= 100 &&
        (data.npcsSnapshot.length === 0 || isPlainObject(data.npcsSnapshot[0])),
      `Invalid checkpoint body on ${docPath}`,
    );
    this.assertRule(data.createdAt instanceof SimulatedTimestamp, `createdAt invalid on ${docPath}`);
  }

  getDoc(auth: AuthContext | null, docPath: string): Record<string, unknown> | null {
    const parts = docPath.split('/');
    this.assertRule(auth !== null && auth.emailVerified === true, `Unauthenticated/unverified GET ${docPath}`);
    const existing = this.docs.get(docPath) ?? null;
    if (parts.length === 2 && parts[0] === 'campaigns') {
      const campaignId = parts[1];
      this.assertRule(isValidId(campaignId), `Invalid campaignId ${campaignId}`);
      this.assertRule(existing === null || existing.ownerId === auth!.uid, `Forbidden GET ${docPath}`);
      return existing ? structuredClone(existing) : null;
    }
    if (parts.length === 4 && parts[0] === 'campaigns') {
      const [, campaignId, , subId] = parts;
      this.assertRule(isValidId(campaignId) && isValidId(subId), `Invalid IDs GET ${docPath}`);
      const parent = this.docs.get(`campaigns/${campaignId}`) ?? null;
      this.assertRule(parent !== null && parent.ownerId === auth!.uid, `Forbidden GET ${docPath}`);
      return existing ? structuredClone(existing) : null;
    }
    this.assertRule(false, `Default deny GET ${docPath}`);
    return null;
  }

  listCollection(
    auth: AuthContext | null,
    colPath: string,
    whereOwnerId?: string,
  ): Array<Record<string, unknown>> {
    this.assertRule(auth !== null && auth.emailVerified === true, `Unauthenticated LIST ${colPath}`);
    this.assertRule(
      whereOwnerId !== undefined && whereOwnerId === auth!.uid,
      `Query without matching where('ownerId', '==', auth.uid) on ${colPath}`,
    );
    const out: Array<Record<string, unknown>> = [];
    for (const [docPath, data] of this.docs.entries()) {
      const parentCol = docPath.split('/').slice(0, -1).join('/');
      if (parentCol === colPath && data.ownerId === whereOwnerId) {
        out.push(structuredClone(data));
      }
    }
    return out;
  }

  commitBatch(
    auth: AuthContext | null,
    ops: Array<{ kind: 'create' | 'update' | 'delete'; path: string; rawData?: Record<string, unknown> }>,
    extraLookups = 0,
  ) {
    this.evaluateRulesWriteBatch(auth, ops, extraLookups);
  }

  createCheckpointPort(auth: AuthContext): CheckpointTransactionPort {
    return {
      ensureVerifiedUser: async (expectedOwnerId: string) => {
        if (!auth.emailVerified || auth.uid !== expectedOwnerId) {
          throw new Error('Permissão negada na autenticação.');
        }
        return auth.uid;
      },
      fetchLiveInventoryAndNpcs: async (campaignId: string, ownerId: string) => ({
        inventory: this.listCollection(
          auth,
          `campaigns/${campaignId}/inventory`,
          ownerId,
        ) as unknown as InventoryItem[],
        npcs: this.listCollection(
          auth,
          `campaigns/${campaignId}/npcs`,
          ownerId,
        ) as unknown as NpcRecord[],
      }),
      serverTimestamp: () => SERVER_TIMESTAMP,
      runAtomicTransaction: async <T>(fn: (tx: CheckpointTransactionContext) => Promise<T>) => {
        const ops: Array<{
          kind: 'create' | 'update' | 'delete';
          path: string;
          rawData?: Record<string, unknown>;
        }> = [];
        let extraRuleLookups = 0;

        const tx: CheckpointTransactionContext = {
          getCampaign: async (cid) =>
            this.getDoc(auth, `campaigns/${cid}`) as unknown as Campaign | null,
          getCheckpoint: async (cid, cpId) => {
            extraRuleLookups += 1;
            return this.getDoc(
              auth,
              `campaigns/${cid}/checkpoints/${cpId}`,
            ) as unknown as Checkpoint | null;
          },
          updateCampaign: (cid, patch) => {
            ops.push({ kind: 'update', path: `campaigns/${cid}`, rawData: patch });
          },
          setCheckpoint: (cid, cpId, data) => {
            ops.push({
              kind: 'create',
              path: `campaigns/${cid}/checkpoints/${cpId}`,
              rawData: data,
            });
          },
          setInventoryItem: (cid, itemId, data) => {
            ops.push({ kind: 'create', path: `campaigns/${cid}/inventory/${itemId}`, rawData: data });
          },
          updateInventoryItem: (cid, itemId, patch) => {
            ops.push({
              kind: 'update',
              path: `campaigns/${cid}/inventory/${itemId}`,
              rawData: patch,
            });
          },
          deleteInventoryItem: (cid, itemId) => {
            ops.push({ kind: 'delete', path: `campaigns/${cid}/inventory/${itemId}` });
          },
          setNpc: (cid, npcId, data) => {
            ops.push({ kind: 'create', path: `campaigns/${cid}/npcs/${npcId}`, rawData: data });
          },
          updateNpc: (cid, npcId, patch) => {
            ops.push({ kind: 'update', path: `campaigns/${cid}/npcs/${npcId}`, rawData: patch });
          },
          deleteNpc: (cid, npcId) => {
            ops.push({ kind: 'delete', path: `campaigns/${cid}/npcs/${npcId}` });
          },
          setNarrativeEntry: (cid, entryId, data) => {
            ops.push({ kind: 'create', path: `campaigns/${cid}/narrative/${entryId}`, rawData: data });
          },
          setEvent: (cid, eventId, data) => {
            ops.push({ kind: 'create', path: `campaigns/${cid}/events/${eventId}`, rawData: data });
          },
        };

        const result = await fn(tx);
        this.commitBatch(auth, ops, extraRuleLookups);
        return result;
      },
    };
  }
}

function seedCampaignInSim(
  sim: FirestoreRulesSimulator,
  auth: AuthContext,
  bundle: ReturnType<typeof createEchoArcBundle>,
) {
  const cid = bundle.campaign.id;
  sim.commitBatch(auth, [
    {
      kind: 'create',
      path: `campaigns/${cid}`,
      rawData: {
        ...bundle.campaign,
        createdAt: SERVER_TIMESTAMP,
        updatedAt: SERVER_TIMESTAMP,
      },
    },
  ]);

  sim.commitBatch(auth, [
    ...bundle.inventory.map((item) => ({
      kind: 'create' as const,
      path: `campaigns/${cid}/inventory/${item.id}`,
      rawData: { ...item, createdAt: SERVER_TIMESTAMP, updatedAt: SERVER_TIMESTAMP },
    })),
    ...bundle.npcs.map((npc) => ({
      kind: 'create' as const,
      path: `campaigns/${cid}/npcs/${npc.id}`,
      rawData: { ...npc, createdAt: SERVER_TIMESTAMP, updatedAt: SERVER_TIMESTAMP },
    })),
    ...bundle.narrative.map((entry) => ({
      kind: 'create' as const,
      path: `campaigns/${cid}/narrative/${entry.id}`,
      rawData: { ...entry, createdAt: SERVER_TIMESTAMP },
    })),
    ...bundle.events.map((evt) => ({
      kind: 'create' as const,
      path: `campaigns/${cid}/events/${evt.id}`,
      rawData: { ...evt, createdAt: SERVER_TIMESTAMP },
    })),
  ]);
}

function seedLegacyCampaignDirectly(sim: FirestoreRulesSimulator, uid: string) {
  const bundle = createEchoArcBundle(uid);
  const cid = bundle.campaign.id;
  const ts = new SimulatedTimestamp(sim.requestTimeMs);

  const legacyCampaign: Record<string, unknown> = { ...bundle.campaign, createdAt: ts, updatedAt: ts };
  delete legacyCampaign.activeTimelineId;
  delete legacyCampaign.timelineLineage;
  sim.docs.set(`campaigns/${cid}`, legacyCampaign);

  for (const item of bundle.inventory) {
    sim.docs.set(`campaigns/${cid}/inventory/${item.id}`, { ...item, createdAt: ts, updatedAt: ts });
  }
  for (const npc of bundle.npcs) {
    sim.docs.set(`campaigns/${cid}/npcs/${npc.id}`, { ...npc, createdAt: ts, updatedAt: ts });
  }
  for (const entry of bundle.narrative) {
    const e: Record<string, unknown> = { ...entry, createdAt: ts };
    delete e.timelineId;
    sim.docs.set(`campaigns/${cid}/narrative/${entry.id}`, e);
  }
  for (const evt of bundle.events) {
    const e: Record<string, unknown> = { ...evt, createdAt: ts };
    delete e.timelineId;
    sim.docs.set(`campaigns/${cid}/events/${evt.id}`, e);
  }

  const legacyCp: Record<string, unknown> = {
    id: 'chk_legacy_browser_1',
    ownerId: uid,
    campaignId: cid,
    label: 'Checkpoint Antigo',
    note: 'Gravado antes da atualização',
    revision: 1,
    lastSequence: 2,
    currentLocation: bundle.campaign.currentLocation,
    protagonist: structuredClone(bundle.campaign.protagonist),
    currency: structuredClone(bundle.campaign.currency),
    worldTime: structuredClone(bundle.campaign.worldTime),
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
    createdAt: ts,
  };
  sim.docs.set(`campaigns/${cid}/checkpoints/${legacyCp.id}`, legacyCp);

  return { cid, legacyCpId: String(legacyCp.id) };
}

test('[Simulador de Regras] Criação de ação, inventário, moedas, avanço de tempo, checkpoint save e restore passam nas regras atuais', async () => {
  const auth: AuthContext = { uid: 'player_verified_1', emailVerified: true };
  const sim = new FirestoreRulesSimulator('current_v3');
  const bundle = createEchoArcBundle(auth.uid);
  seedCampaignInSim(sim, auth, bundle);

  const customBundle = createCustomCampaignBundle(auth.uid, {
    name: 'Crônicas de Arvend',
    setting: 'Academia arcana e vilas vizinhas',
    currentLocation: 'Portão Sul',
    protagonistName: 'Lucas',
    protagonistAge: 19,
    protagonistOrigin: 'Aprendiz de escriba',
    futureHook: 'Ingresso na academia',
  });
  seedCampaignInSim(sim, auth, customBundle);

  assert.equal(sim.getDoc(auth, 'campaigns/' + bundle.campaign.id)?.currentLocation, 'Vila de Freixo');
  assert.equal(sim.getDoc(auth, 'campaigns/' + customBundle.campaign.id)?.currentLocation, 'Portão Sul');

  const cid = bundle.campaign.id;

  // 1. Ação do jogador (commitPlayerAction)
  const campaign1 = sim.getDoc(auth, `campaigns/${cid}`) as unknown as Campaign;
  const inv1 = sim.listCollection(auth, `campaigns/${cid}/inventory`, auth.uid) as unknown as InventoryItem[];
  const npcs1 = sim.listCollection(auth, `campaigns/${cid}/npcs`, auth.uid) as unknown as NpcRecord[];
  const action1 = processPlayerAction(campaign1, inv1, npcs1, 'Samuel examina os recados na mesa.', 15);
  if (!action1.ok) assert.fail(action1.error);

  sim.commitBatch(auth, [
    {
      kind: 'update',
      path: `campaigns/${cid}`,
      rawData: {
        worldTime: action1.data.nextWorldTime,
        lastSequence: action1.data.nextLastSequence,
        revision: action1.data.nextRevision,
        updatedAt: SERVER_TIMESTAMP,
      },
    },
    {
      kind: 'create',
      path: `campaigns/${cid}/narrative/${action1.data.playerEntry.id}`,
      rawData: { ...action1.data.playerEntry, createdAt: SERVER_TIMESTAMP },
    },
    {
      kind: 'create',
      path: `campaigns/${cid}/narrative/${action1.data.engineEntry.id}`,
      rawData: { ...action1.data.engineEntry, createdAt: SERVER_TIMESTAMP },
    },
    {
      kind: 'create',
      path: `campaigns/${cid}/events/${action1.data.event.id}`,
      rawData: { ...action1.data.event, createdAt: SERVER_TIMESTAMP },
    },
  ]);

  // 2. Save checkpoint
  const campaign2 = sim.getDoc(auth, `campaigns/${cid}`) as unknown as Campaign;
  const builtCp = buildCheckpointPayload(campaign2, inv1, npcs1, 'Marco Freixo', 'Antes de sair');
  if (!builtCp.ok) assert.fail(builtCp.error);

  await executeSaveCheckpointTransaction(
    sim.createCheckpointPort(auth),
    cid,
    builtCp.data.checkpoint,
    builtCp.data.event,
    builtCp.data.expectedRevision,
    builtCp.data.nextRevision,
    builtCp.data.nextLastSequence,
  );

  // 3. Mutações pós-checkpoint (inventário add/update/delete, moedas, tempo)
  const campaign3 = sim.getDoc(auth, `campaigns/${cid}`) as unknown as Campaign;
  const addRes = processInventoryMutation(campaign3, inv1, {
    kind: 'add',
    name: 'Carta Selada',
    category: 'documento',
    quantity: 1,
    description: 'Envelope para Arvend.',
    equipable: false,
  });
  if (!addRes.ok) assert.fail(addRes.error);
  sim.commitBatch(auth, [
    {
      kind: 'update',
      path: `campaigns/${cid}`,
      rawData: {
        lastSequence: addRes.data.nextLastSequence,
        revision: addRes.data.nextRevision,
        updatedAt: SERVER_TIMESTAMP,
      },
    },
    {
      kind: 'create',
      path: `campaigns/${cid}/inventory/${addRes.data.item.id}`,
      rawData: { ...addRes.data.item, createdAt: SERVER_TIMESTAMP, updatedAt: SERVER_TIMESTAMP },
    },
    {
      kind: 'create',
      path: `campaigns/${cid}/events/${addRes.data.event.id}`,
      rawData: { ...addRes.data.event, createdAt: SERVER_TIMESTAMP },
    },
  ]);

  const campaign4 = sim.getDoc(auth, `campaigns/${cid}`) as unknown as Campaign;
  const currRes = processCurrencyMutation(campaign4, { silver: 3 });
  if (!currRes.ok) assert.fail(currRes.error);
  sim.commitBatch(auth, [
    {
      kind: 'update',
      path: `campaigns/${cid}`,
      rawData: {
        currency: currRes.data.nextCurrency,
        lastSequence: currRes.data.nextLastSequence,
        revision: currRes.data.nextRevision,
        updatedAt: SERVER_TIMESTAMP,
      },
    },
    {
      kind: 'create',
      path: `campaigns/${cid}/events/${currRes.data.event.id}`,
      rawData: { ...currRes.data.event, createdAt: SERVER_TIMESTAMP },
    },
  ]);

  const campaign5 = sim.getDoc(auth, `campaigns/${cid}`) as unknown as Campaign;
  const timeRes = processTimeAdvance(campaign5, 30);
  if (!timeRes.ok) assert.fail(timeRes.error);
  sim.commitBatch(auth, [
    {
      kind: 'update',
      path: `campaigns/${cid}`,
      rawData: {
        worldTime: timeRes.data.nextWorldTime,
        lastSequence: timeRes.data.nextLastSequence,
        revision: timeRes.data.nextRevision,
        updatedAt: SERVER_TIMESTAMP,
      },
    },
    {
      kind: 'create',
      path: `campaigns/${cid}/events/${timeRes.data.event.id}`,
      rawData: { ...timeRes.data.event, createdAt: SERVER_TIMESTAMP },
    },
  ]);

  // 4. Restore checkpoint via runTransaction
  const campaign6 = sim.getDoc(auth, `campaigns/${cid}`) as unknown as Campaign;
  const savedCp = sim.getDoc(
    auth,
    `campaigns/${cid}/checkpoints/${builtCp.data.checkpoint.id}`,
  ) as unknown as Checkpoint;
  const liveInv = sim.listCollection(auth, `campaigns/${cid}/inventory`, auth.uid) as unknown as InventoryItem[];
  const liveNpcs = sim.listCollection(auth, `campaigns/${cid}/npcs`, auth.uid) as unknown as NpcRecord[];

  const plan = await executeRestoreCheckpointTransaction(
    sim.createCheckpointPort(auth),
    campaign6,
    savedCp,
    liveInv,
    liveNpcs,
  );

  const restored = sim.getDoc(auth, `campaigns/${cid}`) as unknown as Campaign;
  assert.equal(restored.activeTimelineId, plan.nextTimelineId);
  assert.equal(restored.timelineLineage?.length, 2);
  assert.deepEqual(restored.currency, { gold: 0, silver: 2, copper: 15 });
});

test('[Simulador de Regras] Compatibilidade com campanha e checkpoint legados (sem campos de timeline)', async () => {
  const auth: AuthContext = { uid: 'legacy_user_1', emailVerified: true };
  const sim = new FirestoreRulesSimulator('current_v3');
  const { cid, legacyCpId } = seedLegacyCampaignDirectly(sim, auth.uid);

  // 1. Criar ação do jogador em campanha legada (sem activeTimelineId/timelineLineage)
  const legacyCamp = sim.getDoc(auth, `campaigns/${cid}`) as unknown as Campaign;
  const inv = sim.listCollection(auth, `campaigns/${cid}/inventory`, auth.uid) as unknown as InventoryItem[];
  const npcs = sim.listCollection(auth, `campaigns/${cid}/npcs`, auth.uid) as unknown as NpcRecord[];

  const action = processPlayerAction(legacyCamp, inv, npcs, 'Samuel verifica o poço da vila.', 20);
  if (!action.ok) assert.fail(action.error);

  sim.commitBatch(auth, [
    {
      kind: 'update',
      path: `campaigns/${cid}`,
      rawData: {
        worldTime: action.data.nextWorldTime,
        lastSequence: action.data.nextLastSequence,
        revision: action.data.nextRevision,
        updatedAt: SERVER_TIMESTAMP,
      },
    },
    {
      kind: 'create',
      path: `campaigns/${cid}/narrative/${action.data.playerEntry.id}`,
      rawData: { ...action.data.playerEntry, createdAt: SERVER_TIMESTAMP },
    },
    {
      kind: 'create',
      path: `campaigns/${cid}/narrative/${action.data.engineEntry.id}`,
      rawData: { ...action.data.engineEntry, createdAt: SERVER_TIMESTAMP },
    },
    {
      kind: 'create',
      path: `campaigns/${cid}/events/${action.data.event.id}`,
      rawData: { ...action.data.event, createdAt: SERVER_TIMESTAMP },
    },
  ]);

  // 2. Salvar novo checkpoint em campanha legada
  const campAfterAction = sim.getDoc(auth, `campaigns/${cid}`) as unknown as Campaign;
  const cpPayload = buildCheckpointPayload(campAfterAction, inv, npcs, 'CP Novo em Campanha Antiga', '');
  if (!cpPayload.ok) assert.fail(cpPayload.error);
  await executeSaveCheckpointTransaction(
    sim.createCheckpointPort(auth),
    cid,
    cpPayload.data.checkpoint,
    cpPayload.data.event,
    cpPayload.data.expectedRevision,
    cpPayload.data.nextRevision,
    cpPayload.data.nextLastSequence,
  );

  // 3. Restaurar checkpoint legado (sem timelineId/narrativeCutoffSequence/timelineLineageSnapshot)
  const campBeforeRestore = sim.getDoc(auth, `campaigns/${cid}`) as unknown as Campaign;
  const legacyCp = sim.getDoc(
    auth,
    `campaigns/${cid}/checkpoints/${legacyCpId}`,
  ) as unknown as Checkpoint;

  const restorePlan = await executeRestoreCheckpointTransaction(
    sim.createCheckpointPort(auth),
    campBeforeRestore,
    legacyCp,
    inv,
    npcs,
  );

  const restoredCamp = sim.getDoc(auth, `campaigns/${cid}`) as unknown as Campaign;
  assert.equal(restoredCamp.activeTimelineId, restorePlan.nextTimelineId);
  assert.equal(restoredCamp.timelineLineage?.length, 2);

  // 4. Salvar e restaurar novamente após migração da campanha para multi-linha
  const inv2 = sim.listCollection(auth, `campaigns/${cid}/inventory`, auth.uid) as unknown as InventoryItem[];
  const cp2 = buildCheckpointPayload(restoredCamp, inv2, npcs, 'CP Pós Restauração', '');
  if (!cp2.ok) assert.fail(cp2.error);
  await executeSaveCheckpointTransaction(
    sim.createCheckpointPort(auth),
    cid,
    cp2.data.checkpoint,
    cp2.data.event,
    cp2.data.expectedRevision,
    cp2.data.nextRevision,
    cp2.data.nextLastSequence,
  );
});

test('[Diagnóstico de Causa] Reprodução exata do PERMISSION_DENIED quando regras pré-atualização estão ativas', async () => {
  const auth: AuthContext = { uid: 'player_verified_1', emailVerified: true };
  const simOutdatedRules = new FirestoreRulesSimulator('legacy_v2_pre_timeline');
  const { cid, legacyCpId } = seedLegacyCampaignDirectly(simOutdatedRules, auth.uid);

  const legacyCamp = simOutdatedRules.getDoc(auth, `campaigns/${cid}`) as unknown as Campaign;
  const inv = simOutdatedRules.listCollection(auth, `campaigns/${cid}/inventory`, auth.uid) as unknown as InventoryItem[];
  const npcs = simOutdatedRules.listCollection(auth, `campaigns/${cid}/npcs`, auth.uid) as unknown as NpcRecord[];

  // Caso 1: commitPlayerAction falha nas regras antigas por causa de `timelineId` em narrative/events
  const action = processPlayerAction(legacyCamp, inv, npcs, 'Samuel olha o céu.', 10);
  if (!action.ok) assert.fail(action.error);

  assert.throws(
    () =>
      simOutdatedRules.commitBatch(auth, [
        {
          kind: 'update',
          path: `campaigns/${cid}`,
          rawData: {
            worldTime: action.data.nextWorldTime,
            lastSequence: action.data.nextLastSequence,
            revision: action.data.nextRevision,
            updatedAt: SERVER_TIMESTAMP,
          },
        },
        {
          kind: 'create',
          path: `campaigns/${cid}/narrative/${action.data.playerEntry.id}`,
          rawData: { ...action.data.playerEntry, createdAt: SERVER_TIMESTAMP },
        },
      ]),
    /PERMISSION_DENIED: Disallowed narrative keys/,
  );

  // Caso 2: restoreCheckpoint falha nas regras antigas por causa de `activeTimelineId` e `timelineLineage` em campaigns/{id}
  const legacyCp = simOutdatedRules.getDoc(
    auth,
    `campaigns/${cid}/checkpoints/${legacyCpId}`,
  ) as unknown as Checkpoint;

  await assert.rejects(
    () =>
      executeRestoreCheckpointTransaction(
        simOutdatedRules.createCheckpointPort(auth),
        legacyCamp,
        legacyCp,
        inv,
        npcs,
      ),
    /PERMISSION_DENIED: Disallowed campaign keys/,
  );
});

test('[Tratamento de Erro] Diagnóstico preserva operação e caminho específico que falhou em transações', async () => {
  const bundle = createEchoArcBundle('uid_1');
  const cid = bundle.campaign.id;
  const cp: Checkpoint = {
    id: 'chk_diag_1',
    ownerId: 'uid_1',
    campaignId: cid,
    label: 'CP Diag',
    note: '',
    revision: 1,
    lastSequence: 2,
    currentLocation: bundle.campaign.currentLocation,
    protagonist: bundle.campaign.protagonist,
    currency: bundle.campaign.currency,
    worldTime: bundle.campaign.worldTime,
    inventorySnapshot: [],
    npcsSnapshot: [],
  };

  const portWithGetCheckpointFailure: CheckpointTransactionPort = {
    ensureVerifiedUser: async () => 'uid_1',
    fetchLiveInventoryAndNpcs: async () => ({ inventory: [], npcs: [] }),
    serverTimestamp: () => SERVER_TIMESTAMP,
    runAtomicTransaction: async (fn) =>
      fn({
        getCampaign: async () => bundle.campaign,
        getCheckpoint: async () => {
          throw new Error('Missing or insufficient permissions.');
        },
        updateCampaign: () => {},
        setCheckpoint: () => {},
        setInventoryItem: () => {},
        updateInventoryItem: () => {},
        deleteInventoryItem: () => {},
        setNpc: () => {},
        updateNpc: () => {},
        deleteNpc: () => {},
        setNarrativeEntry: () => {},
        setEvent: () => {},
      }),
  };

  let captured: unknown;
  try {
    await executeRestoreCheckpointTransaction(portWithGetCheckpointFailure, bundle.campaign, cp, [], []);
  } catch (err) {
    captured = err;
  }
  const ctx = extractFirestoreContext(captured);
  assert.deepEqual(ctx, {
    operationType: 'get',
    path: `campaigns/${cid}/checkpoints/chk_diag_1`,
  });

  // Garante preservação do primeiro contexto se attachFirestoreContext for chamado novamente
  const wrapped = attachFirestoreContext(captured, {
    operationType: 'write',
    path: `campaigns/${cid}`,
  });
  assert.deepEqual(extractFirestoreContext(wrapped), {
    operationType: 'get',
    path: `campaigns/${cid}/checkpoints/chk_diag_1`,
  });
});

test('[Dirty Dozen & Red Team] Todos os 12 payloads adversariais e injeção em timelineLineage são bloqueados com PERMISSION_DENIED', () => {
  const owner: AuthContext = { uid: 'owner_1', emailVerified: true };
  const attacker: AuthContext = { uid: 'attacker_2', emailVerified: true };
  const unverified: AuthContext = { uid: 'owner_1', emailVerified: false };

  const sim = new FirestoreRulesSimulator('current_v3');
  const bundle = createEchoArcBundle(owner.uid);
  seedCampaignInSim(sim, owner, bundle);
  const cid = bundle.campaign.id;

  // 1. Leitura não autenticada
  assert.throws(() => sim.getDoc(null, `campaigns/${cid}`), /PERMISSION_DENIED/);

  // 2. Token com email_verified == false
  const bundleUnverified = createEchoArcBundle(owner.uid);
  assert.throws(
    () =>
      sim.commitBatch(unverified, [
        {
          kind: 'create',
          path: `campaigns/${bundleUnverified.campaign.id}`,
          rawData: { ...bundleUnverified.campaign, createdAt: SERVER_TIMESTAMP, updatedAt: SERVER_TIMESTAMP },
        },
      ]),
    /PERMISSION_DENIED/,
  );

  // 3. Listagem cross-tenant sem where('ownerId', '==', auth.uid)
  assert.throws(() => sim.listCollection(attacker, 'campaigns', owner.uid), /PERMISSION_DENIED/);

  // 4. Owner spoofing na criação
  const spoofBundle = createEchoArcBundle(owner.uid);
  assert.throws(
    () =>
      sim.commitBatch(attacker, [
        {
          kind: 'create',
          path: `campaigns/${spoofBundle.campaign.id}`,
          rawData: { ...spoofBundle.campaign, createdAt: SERVER_TIMESTAMP, updatedAt: SERVER_TIMESTAMP },
        },
      ]),
    /PERMISSION_DENIED/,
  );

  // 5. Shadow field injection (inclusive dentro de timelineLineage[tail])
  const shadowBundle = createEchoArcBundle(owner.uid);
  assert.throws(
    () =>
      sim.commitBatch(owner, [
        {
          kind: 'create',
          path: `campaigns/${shadowBundle.campaign.id}`,
          rawData: {
            ...shadowBundle.campaign,
            isAdmin: true,
            createdAt: SERVER_TIMESTAMP,
            updatedAt: SERVER_TIMESTAMP,
          },
        },
      ]),
    /PERMISSION_DENIED/,
  );

  const shadowSegmentCamp = sim.getDoc(owner, `campaigns/${cid}`) as unknown as Campaign;
  assert.throws(
    () =>
      sim.commitBatch(owner, [
        {
          kind: 'update',
          path: `campaigns/${cid}`,
          rawData: {
            protagonist: shadowSegmentCamp.protagonist,
            currency: shadowSegmentCamp.currency,
            worldTime: shadowSegmentCamp.worldTime,
            currentLocation: shadowSegmentCamp.currentLocation,
            lastSequence: shadowSegmentCamp.lastSequence + 1,
            revision: shadowSegmentCamp.revision + 1,
            activeTimelineId: 'tl_branch_1',
            timelineLineage: [
              { timelineId: 'tl_root', fromSequence: 0, toSequence: 2 },
              { timelineId: 'tl_branch_1', fromSequence: 3, toSequence: null, adminOverride: true },
            ],
            updatedAt: SERVER_TIMESTAMP,
          },
        },
      ]),
    /PERMISSION_DENIED/,
  );

  // 6. ID poisoning
  const badIdBundle = createEchoArcBundle(owner.uid);
  assert.throws(
    () =>
      sim.commitBatch(owner, [
        {
          kind: 'create',
          path: 'campaigns/bad$id',
          rawData: {
            ...badIdBundle.campaign,
            id: 'bad$id',
            createdAt: SERVER_TIMESTAMP,
            updatedAt: SERVER_TIMESTAMP,
          },
        },
      ]),
    /PERMISSION_DENIED/,
  );

  // 7. Client timestamp forgery
  const forgedTsBundle = createEchoArcBundle(owner.uid);
  assert.throws(
    () =>
      sim.commitBatch(owner, [
        {
          kind: 'create',
          path: `campaigns/${forgedTsBundle.campaign.id}`,
          rawData: {
            ...forgedTsBundle.campaign,
            createdAt: new SimulatedTimestamp(1577836800000),
            updatedAt: SERVER_TIMESTAMP,
          },
        },
      ]),
    /PERMISSION_DENIED/,
  );

  // 8. Negative inventory quantity
  assert.throws(
    () =>
      sim.commitBatch(owner, [
        {
          kind: 'create',
          path: `campaigns/${cid}/inventory/item_neg_1`,
          rawData: {
            id: 'item_neg_1',
            ownerId: owner.uid,
            campaignId: cid,
            name: 'Poção Quebrada',
            category: 'consumivel',
            quantity: -5,
            description: 'Inválida',
            equipable: false,
            equipped: false,
            createdAt: SERVER_TIMESTAMP,
            updatedAt: SERVER_TIMESTAMP,
          },
        },
      ]),
    /PERMISSION_DENIED/,
  );

  // 9. Negative currency update
  assert.throws(
    () =>
      sim.commitBatch(owner, [
        {
          kind: 'update',
          path: `campaigns/${cid}`,
          rawData: {
            currency: { gold: -10, silver: 0, copper: 0 },
            lastSequence: 3,
            revision: 2,
            updatedAt: SERVER_TIMESTAMP,
          },
        },
      ]),
    /PERMISSION_DENIED/,
  );

  // 10. Immutable ownerId tampering
  assert.throws(
    () =>
      sim.commitBatch(owner, [
        {
          kind: 'update',
          path: `campaigns/${cid}`,
          rawData: {
            ownerId: attacker.uid,
            lastSequence: 3,
            revision: 2,
            updatedAt: SERVER_TIMESTAMP,
          },
        },
      ]),
    /PERMISSION_DENIED/,
  );

  // 11. Terminal archived mutation lock
  sim.commitBatch(owner, [
    {
      kind: 'update',
      path: `campaigns/${cid}`,
      rawData: {
        status: 'archived',
        revision: 2,
        updatedAt: SERVER_TIMESTAMP,
      },
    },
  ]);
  assert.throws(
    () =>
      sim.commitBatch(owner, [
        {
          kind: 'update',
          path: `campaigns/${cid}`,
          rawData: {
            lastSequence: 3,
            revision: 3,
            updatedAt: SERVER_TIMESTAMP,
          },
        },
      ]),
    /PERMISSION_DENIED/,
  );

  // 12. Audit log tampering (update on append-only events)
  const evtId = bundle.events[0].id;
  assert.throws(
    () =>
      sim.commitBatch(owner, [
        {
          kind: 'update',
          path: `campaigns/${cid}/events/${evtId}`,
          rawData: { summary: 'Adulterado' },
        },
      ]),
    /PERMISSION_DENIED/,
  );

  // Verifica também que firestore.rules no disco contém a validação da cauda de timelineLineage
  const rulesText = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
  assert.match(rulesText, /isValidTimelineSegment\(lineage\[lineage\.size\(\)\s*-\s*1\]\)/);
  assert.match(rulesText, /isValidLineage\(data\.timelineLineage\)/);
  assert.match(rulesText, /isValidLineage\(after\.timelineLineage\)/);
  assert.match(rulesText, /timelineLineageSnapshot\.size\(\)\s*-\s*1/);
});
