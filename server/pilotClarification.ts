import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TurnIdentity } from '../src/engine/turnIdentity';

const key = randomBytes(32);

function signature(ownerId: string, turn: TurnIdentity, prefix: string) {
  return createHmac('sha256', key).update(JSON.stringify([
    ownerId, turn.campaignId, turn.turnId, turn.expectedRevision, turn.baseTimelineId, turn.advanceMinutes, prefix,
  ])).digest();
}

export function issuePilotClarification(ownerId: string, turn: TurnIdentity, prefix: string) {
  return Buffer.from(prefix).toString('base64url') + '.' + signature(ownerId, turn, prefix).toString('base64url');
}

export function readPilotClarification(ownerId: string, turn: TurnIdentity, token: unknown) {
  const parts = readClarificationParts(token);
  if (parts && timingSafeEqual(parts.mac, signature(ownerId, turn, parts.prefix))) return parts.prefix;
}

export function readClarificationParts(token: unknown) {
  if (typeof token !== 'string' || !/^[\w-]{1,512}\.[\w-]{43}$/.test(token)) return;
  const [encoded, mac] = token.split('.');
  return { prefix: Buffer.from(encoded, 'base64url').toString(), mac: Buffer.from(mac, 'base64url'), token };
}

export function clarificationReceiptBinding(ownerId: string, turn: TurnIdentity, token: string) {
  return createHash('sha256').update(JSON.stringify([
    ownerId, turn.campaignId, turn.turnId, turn.expectedRevision, turn.baseTimelineId, turn.advanceMinutes,
    turn.declaredAction, token,
  ])).digest('hex');
}
