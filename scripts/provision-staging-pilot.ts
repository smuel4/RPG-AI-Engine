import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readStagingConfig } from '../server/staging';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { createWellEncounterNpc } from '../src/engine/echoArcEncounters';
import { SERVER_PILOT_ID } from '../src/engine/pilotCampaign';
import { freixoFamilyKitchen, freixoWorldPack } from '../src/world/freixo';

const staging = readStagingConfig(process.env);
const [apply, project, ...extra] = process.argv.slice(2);
if (!staging || apply !== '--apply' || project !== staging.web.projectId || extra.length) {
  throw new Error('Informe --apply e o ID exato do projeto de staging configurado.');
}

const app = initializeApp({ projectId: staging.web.projectId, credential: cert(staging.credential) }, 'provision-staging');
try {
  const db = getFirestore(app);
  const bundle = createEchoArcBundle(staging.ownerUid);
  const ref = db.collection('campaigns').doc(SERVER_PILOT_ID);
  const batch = db.batch();
  batch.create(db.doc('stagingAccess/pilot'), { ownerId: staging.ownerUid });
  batch.create(ref, { ...bundle.campaign, id: ref.id, currentLocation: freixoFamilyKitchen });
  for (const npc of bundle.npcs) {
    const identity = freixoWorldPack.npcs.find(({ name }) => name === npc.name);
    if (!identity) throw new Error('NPC do piloto ausente no WorldPack.');
    batch.create(ref.collection('npcs').doc(npc.id), { ...npc, campaignId: ref.id, location: identity.location });
  }
  const lira = createWellEncounterNpc(staging.ownerUid, ref.id);
  batch.create(ref.collection('npcs').doc(lira.id), lira);
  await batch.commit();
  console.log('Campanha e convite de staging provisionados.');
} catch {
  throw new Error('Não foi possível provisionar staging. Confira a autorização e a existência prévia do piloto.');
} finally {
  await deleteApp(app);
}
