import { isolatedFirestore } from '../scripts/isolated-firestore.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  getFirestore, connectFirestoreEmulator, doc,
  setDoc, getDoc, runTransaction, serverTimestamp, terminate
} from 'firebase/firestore';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';

const isolatedPort = await isolatedFirestore();

test('Restauracao: atualizar somente campanha', async () => {
  const app = initializeApp({
    projectId: 'demo-rpg-ai-engine',
    apiKey: 'demo',
    appId: 'demo'
  }, 'restore-update-only');

  const db = getFirestore(
    app,
    'ai-studio-31936b9f-7516-468c-9cf4-6dd4da7fb704'
  );

  connectFirestoreEmulator(db, '127.0.0.1', isolatedPort, {
    mockUserToken: {
      user_id: 'dono_restore_update',
      email: 'local@example.com',
      email_verified: true
    }
  });

  try {
    const { campaign } = createEchoArcBundle('dono_restore_update');
    const ref = doc(db, 'campaigns', campaign.id);

    await setDoc(ref, {
      ...campaign,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    console.log('OK: campanha ficticia criada.');

    await runTransaction(db, async tx => {
      const atual = await tx.get(ref);
      assert.equal(atual.exists(), true);

      tx.update(ref, {
        protagonist: campaign.protagonist,
        currency: campaign.currency,
        worldTime: campaign.worldTime,
        currentLocation: campaign.currentLocation,
        lastSequence: campaign.lastSequence + 2,
        revision: campaign.revision + 1,
        activeTimelineId: 'tl_restore_isolado',
        timelineLineage: [
          {
            timelineId: 'tl_root',
            fromSequence: 0,
            toSequence: campaign.lastSequence
          },
          {
            timelineId: 'tl_restore_isolado',
            fromSequence: campaign.lastSequence + 1,
            toSequence: null
          }
        ],
        updatedAt: serverTimestamp()
      });
    }, { maxAttempts: 1 });

    const depois = await getDoc(ref);
    assert.equal(depois.data()?.revision, campaign.revision + 1);

    console.log('OK: atualizacao isolada permitida.');
  } finally {
    await terminate(db);
    await deleteApp(app);
  }
});