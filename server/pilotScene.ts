import type { Firestore } from 'firebase-admin/firestore';
import { isNpcOccupied, type NpcRoutineState } from '../src/engine/npcRoutine';
import { getActiveTimelineId } from '../src/engine/rulesEngine';
import { planTurn, type TurnCatalog } from '../src/engine/turnPlanner';
import type { Campaign, NpcRecord, PilotScene } from '../src/types/game';
import { SERVER_PILOT_ID } from './persistPilotTurn';

export async function readPilotScene(db: Firestore, catalog: TurnCatalog, ownerId: string): Promise<PilotScene | null> {
  const ref = db.collection('campaigns').doc(SERVER_PILOT_ID);
  return db.runTransaction(async (tx) => {
    const campaign = (await tx.get(ref)).data() as Campaign | undefined;
    if (campaign?.ownerId !== ownerId || campaign.id !== ref.id || campaign.status !== 'active') return null;
    const timelineId = getActiveTimelineId(campaign);
    const [npcs, runtime] = await Promise.all([
      tx.get(ref.collection('npcs').where('ownerId', '==', ownerId).limit(31)),
      tx.get(ref.collection('npcRoutineState').doc(timelineId)),
    ]);
    const state = runtime.data() as NpcRoutineState | undefined;
    return {
      revision: campaign.revision,
      timelineId,
      location: campaign.currentLocation,
      exits: catalog.places.filter(({ id }) => id !== campaign.currentLocation &&
        planTurn({ kind: 'travel', destination: id }, campaign, catalog).status === 'planned')
        .map(({ id, aliases }) => ({ id, label: aliases[0] ?? id })),
      people: npcs.size > 30 ? [] : npcs.docs.flatMap((doc) => {
        const npc = doc.data() as NpcRecord;
        if (npc.id !== doc.id || npc.campaignId !== campaign.id || npc.ownerId !== ownerId ||
            npc.location !== campaign.currentLocation) return [];
        return [{ id: npc.id, name: npc.name, available: !isNpcOccupied(state, npc.id, campaign.worldTime) }];
      }),
      // Portable objects can be carried, stored or delivered. Only fixed landmarks are advertised here.
      landmarks: (catalog.objects ?? []).filter(({ location, portable }) => !portable && location === campaign.currentLocation)
        .map(({ id, name }) => ({ id, name })),
    };
  }, { readOnly: true });
}
