import type { RequestHandler } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { listPilotCheckpoints, mutatePilotCheckpoint, PilotCheckpointError } from './pilotCheckpoints';

export function pilotCheckpointRoute(config: {
  enabled: boolean;
  requireInvitation: boolean;
  verifyPlayer: (authorization?: string) => Promise<string | null>;
  database: () => Firestore;
}): RequestHandler {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!config.enabled) {
      res.sendStatus(404);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.sendStatus(405);
      return;
    }
    const ownerId = await config.verifyPlayer(req.get('Authorization')).catch(() => null);
    if (!ownerId) {
      res.sendStatus(401);
      return;
    }
    try {
      const db = config.database();
      if (req.method === 'GET') res.json(await listPilotCheckpoints(db, ownerId, config.requireInvitation));
      else res.json(await mutatePilotCheckpoint(db, ownerId, req.body, config.requireInvitation));
    } catch (error) {
      if (error instanceof PilotCheckpointError) res.status(error.status).json({ message: error.message });
      else res.status(503).json({ message: 'Não foi possível confirmar a operação de checkpoint.' });
    }
  };
}
