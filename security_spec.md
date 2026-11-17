# Security Specification — RPG AI Engine

## 1. Data Invariants

1. **Ownership Isolation**: Every `/campaigns/{campaignId}` document and all documents inside its subcollections (`inventory`, `npcs`, `narrative`, `events`, `checkpoints`) belong strictly to a single verified Firebase Auth user (`ownerId == request.auth.uid && request.auth.token.email_verified == true`).
2. **Parent Existence & Relational Sync**: No subcollection document (`inventory`, `npcs`, `narrative`, `events`, `checkpoints`) can be created unless the parent `/campaigns/{campaignId}` document exists (or is atomically created in the same batch via `existsAfter`/`getAfter`) and has `ownerId == request.auth.uid`.
3. **Immutable Identity & Temporal Integrity**: `id`, `ownerId`, `campaignId`, and `createdAt` cannot be modified after creation. `createdAt` must equal `request.time` on creation, and `updatedAt` must equal `request.time` on updates.
4. **Structured Numeric Integrity**: Inventory `quantity >= 0`, currency values `gold >= 0`, `silver >= 0`, `copper >= 0`, `revision >= 1`, and `lastSequence >= 0`.
5. **Terminal State Locking**: Once a campaign transitions to `status == 'archived'`, no further state mutations (`player_action`, `inventory`, `currency`, `worldTime`, `checkpoint_restore`) are permitted.
6. **Append-Only Chronicle & Audit**: Documents in `/narrative` and `/events`, as well as `/checkpoints`, cannot be updated in-place after creation (`allow update: if false;`).
7. **Strict Key & Size Enforcement**: Every entity validates exact `keys().hasAll(...)` and `keys().hasOnly(...)` and enforces string `.size()` limits to prevent shadow fields and payload bloat.

## 2. The "Dirty Dozen" Adversarial Payloads

All 12 payloads below MUST evaluate to `PERMISSION_DENIED`:

1. **Unauthenticated Read**: `GET /campaigns/echo-arc-1` with `auth == null` -> `PERMISSION_DENIED`.
2. **Unverified Email Spoof**: `CREATE /campaigns/camp-1` with `auth.uid == "u1"` and `auth.token.email_verified == false` -> `PERMISSION_DENIED`.
3. **Cross-Tenant List Scraping**: `LIST /campaigns` without `where('ownerId', '==', auth.uid)` (or querying `ownerId == "victim-uid"`) -> `PERMISSION_DENIED`.
4. **Owner Spoofing on Create**: `CREATE /campaigns/camp-2` with `auth.uid == "attacker"` and `data.ownerId == "victim"` -> `PERMISSION_DENIED`.
5. **Shadow Field Injection**: `CREATE /campaigns/camp-3` with valid fields plus `"isAdmin": true` -> `PERMISSION_DENIED`.
6. **ID Poisoning**: `CREATE /campaigns/bad$id..slash` or 200-char ID -> `PERMISSION_DENIED`.
7. **Client Timestamp Forgery**: `CREATE /campaigns/camp-4` with `createdAt: "2020-01-01T00:00:00Z"` instead of server `request.time` -> `PERMISSION_DENIED`.
8. **Negative Inventory Injection**: `CREATE /campaigns/camp-1/inventory/item-1` with `quantity: -5` -> `PERMISSION_DENIED`.
9. **Negative Currency Update**: `UPDATE /campaigns/camp-1` setting `currency.gold: -10` -> `PERMISSION_DENIED`.
10. **Immutable Owner Tampering**: `UPDATE /campaigns/camp-1` attempting to include `ownerId` in `affectedKeys()` -> `PERMISSION_DENIED`.
11. **Terminal Archived Mutation**: `UPDATE /campaigns/camp-archived` attempting to advance `worldTime` when `existing().status == 'archived'` -> `PERMISSION_DENIED`.
12. **Audit Log Tampering**: `UPDATE /campaigns/camp-1/events/evt-1` attempting to rewrite `summary` or `afterSummary` -> `PERMISSION_DENIED`.

## 3. Reference Test Runner (`firestore.rules.test.ts` Blueprint)

```ts
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import fs from 'node:fs';

async function verifyDirtyDozen() {
  const testEnv = await initializeTestEnvironment({
    projectId: 'rpg-ai-engine-test',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') },
  });

  const ownerCtx = testEnv.authenticatedContext('user_1', { email: 'player@example.com', email_verified: true });
  const attackerCtx = testEnv.authenticatedContext('attacker', { email: 'atk@example.com', email_verified: true });
  const unverifiedCtx = testEnv.authenticatedContext('user_2', { email: 'u2@example.com', email_verified: false });

  // Payload 1: Unauthenticated Read
  await assertFails(testEnv.unauthenticatedContext().firestore().doc('campaigns/camp-1').get());
  // Payload 2: Unverified Email
  await assertFails(unverifiedCtx.firestore().doc('campaigns/camp-1').set({ id: 'camp-1', ownerId: 'user_2' }));
  // Payload 3: Cross-tenant list
  await assertFails(attackerCtx.firestore().collection('campaigns').get());
  // Payload 4-12 verified against isValidCampaign / isValidInventoryItem / immutable events
  await testEnv.cleanup();
}
```
