import { test } from 'node:test';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  getFirestore, connectFirestoreEmulator, doc,
  setDoc, getDoc, runTransaction, serverTimestamp, terminate
} from 'firebase/firestore';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';

test('Diagnostico oficial: regras de restauracao', async () => {
  const app = initializeApp({
    projectId: 'demo-rpg-ai-engine',
    apiKey: 'demo',
    appId: 'demo'
  }, 'diagnostico-restore');

  const db = getFirestore(
    app,
    'ai-studio-31936b9f-7516-468c-9cf4-6dd4da7fb704'
  );

  connectFirestoreEmulator(db, '127.0.0.1', 8080, {
    mockUserToken: {
      user_id: 'dono_restore_local',
      email: 'local@example.com',
      email_verified: true
    }
  });

  try {
    const bundle = createEchoArcBundle('dono_restore_local');
    const camp = bundle.campaign;
    const base = 'campaigns/' + camp.id;
    const campaignRef = doc(db, base);
    const sword = {
      ...bundle.inventory[0],
      id: 'item_espada_teste',
      name: 'Espada de Teste',
      equipped: false
    };
    const itemRef = doc(db, base, 'inventory', sword.id);
    const timeline = 'tl_restore_test';
    const narrativeRef = doc(db, base, 'narrative', 'nar_restore_test');
    const eventRef = doc(db, base, 'events', 'evt_restore_test');

    await setDoc(campaignRef, {
      ...camp,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    await setDoc(itemRef, {
      ...sword,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    console.log('OK: campanha e item ficticios preparados.');

    await runTransaction(db, async tx => {
      const atual = await tx.get(campaignRef);
      if (!atual.exists()) throw new Error('Campanha nao encontrada');

      tx.update(campaignRef, {
        protagonist: camp.protagonist,
        currency: camp.currency,
        worldTime: camp.worldTime,
        currentLocation: camp.currentLocation,
        lastSequence: camp.lastSequence + 2,
        revision: camp.revision + 1,
        activeTimelineId: timeline,
        timelineLineage: [
          { timelineId: 'tl_root', fromSequence: 0, toSequence: camp.lastSequence },
          { timelineId: timeline, fromSequence: camp.lastSequence + 1, toSequence: null }
        ],
        updatedAt: serverTimestamp()
      });

      tx.delete(itemRef);

      tx.set(narrativeRef, {
        id: 'nar_restore_test',
        ownerId: camp.ownerId,
        campaignId: camp.id,
        timelineId: timeline,
        sequence: camp.lastSequence + 1,
        authorRole: 'system_seed',
        content: 'Restauracao ficticia de checkpoint.',
        worldTimeLabel: 'Primavera, dia 14',
        createdAt: serverTimestamp()
      });

      tx.set(eventRef, {
        id: 'evt_restore_test',
        ownerId: camp.ownerId,
        campaignId: camp.id,
        timelineId: timeline,
        sequence: camp.lastSequence + 2,
        type: 'CHECKPOINT_LOADED',
        summary: 'Checkpoint restaurado',
        actor: 'Sistema',
        beforeSummary: 'Inventario com espada',
        afterSummary: 'Inventario sem espada',
        worldTimeLabel: 'Primavera, dia 14',
        createdAt: serverTimestamp()
      });
    }, { maxAttempts: 1 });

    if ((await getDoc(itemRef)).exists()) {
      throw new Error('A espada continuou no inventario');
    }

    console.log('OK: transacao de restauracao permitida no emulador.');
    console.log('OK: espada ficticia removida.');
  } finally {
    await terminate(db);
    await deleteApp(app);
  }
});