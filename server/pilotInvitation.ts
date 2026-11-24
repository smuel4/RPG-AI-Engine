import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import { permitsStagingPlayer } from './staging';

export async function hasPilotInvitation(db: Firestore, ownerId: string, tx?: Transaction) {
  const ref = db.collection('stagingAccess').doc('pilot');
  const invitation = await (tx ? tx.get(ref) : ref.get());
  return invitation.data()?.ownerId === ownerId;
}

export async function verifyInvitedPilotPlayer(auth: Auth, db: Firestore, projectId: string,
  ownerId: string, authorization?: string) {
  const token = /^Bearer\s+(\S+)$/iu.exec(authorization ?? '')?.[1];
  if (!token) return null;
  const decoded = await auth.verifyIdToken(token);
  if (!permitsStagingPlayer(decoded, projectId, ownerId)) return null;
  return await hasPilotInvitation(db, decoded.uid) ? decoded.uid : null;
}
