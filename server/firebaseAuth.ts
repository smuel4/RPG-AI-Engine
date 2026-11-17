import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export async function verifyFirebasePlayer(
  authorization?: string
): Promise<string | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!match) return null;

  const projectId =
    process.env.FIREBASE_PROJECT_ID ??
    process.env.VITE_FIREBASE_PROJECT_ID;

  if (!projectId) {
    throw new Error('Firebase Project ID não configurado no servidor.');
  }

  const app =
    getApps().find((item) => item.name === 'rpg-narrator') ??
    initializeApp(
      { projectId },
      'rpg-narrator'
    );

  const decoded = await getAuth(app).verifyIdToken(match[1]);
  return decoded.uid;
}

