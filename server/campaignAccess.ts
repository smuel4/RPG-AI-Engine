import type {
  Campaign,
  InventoryItem,
  NarrativeEntry,
  NpcRecord,
} from '../src/types/game';

import { readCommittedTurn, turnDocumentIds, type TurnIdentity } from '../src/engine/turnIdentity';
import type { GameEvent } from '../src/types/game';

export type FetchFunction = typeof fetch;

export function decodeFirestoreValue(val: unknown): unknown {
  if (!val || typeof val !== 'object') return val;

  const v = val as Record<string, unknown>;

  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return Boolean(v.booleanValue);
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;

  if ('mapValue' in v) {
    const fields = (v.mapValue as { fields?: Record<string, unknown> })?.fields ?? {};
    const res: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(fields)) {
      res[k] = decodeFirestoreValue(child);
    }
    return res;
  }

  if ('arrayValue' in v) {
    const values = (v.arrayValue as { values?: unknown[] })?.values ?? [];
    return values.map(decodeFirestoreValue);
  }

  return val;
}

export function decodeFirestoreDocument<T>(doc: {
  name?: string;
  fields?: Record<string, unknown>;
}): T {
  const fields = doc.fields ?? {};
  const res: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    res[k] = decodeFirestoreValue(v);
  }
  return res as T;
}

export async function canReadCampaign(
  campaignId: string,
  playerToken: string,
  playerUid: string,
  fetchFn: FetchFunction = fetch,
): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(campaignId)) {
    return false;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const databaseId = process.env.FIRESTORE_DATABASE_ID;

  if (!projectId || !databaseId) {
    throw new Error('Configuracao Firestore incompleta no servidor.');
  }

  const url =
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}` +
    `/databases/${encodeURIComponent(databaseId)}` +
    `/documents/campaigns/${encodeURIComponent(campaignId)}`;

  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${playerToken}`,
    },
    signal: AbortSignal.timeout(10000),
  });

  if ([401, 403, 404].includes(response.status)) {
    return false;
  }

  if (!response.ok) {
    throw new Error(`Falha ao consultar Firestore: HTTP ${response.status}`);
  }

  const document = (await response.json()) as {
    fields?: {
      ownerId?: { stringValue?: string };
    };
  };

  return document.fields?.ownerId?.stringValue === playerUid;
}

export interface LoadedCampaignContext {
  campaign: Campaign;
  inventory: InventoryItem[];
  npcs: NpcRecord[];
  narrative: NarrativeEntry[];
}

export async function fetchCommittedTurn(turn: TurnIdentity, playerToken: string, ownerId: string,
  fetchFn: FetchFunction = fetch) {
  const ids = await turnDocumentIds(turn);
  const project = encodeURIComponent(process.env.FIREBASE_PROJECT_ID ?? '');
  const database = encodeURIComponent(process.env.FIRESTORE_DATABASE_ID ?? '');
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/${database}/documents/campaigns/${encodeURIComponent(turn.campaignId)}`;
  async function read<T>(collection: string, id: string): Promise<T | undefined> {
    const response = await fetchFn(`${base}/${collection}/${id}`, {
      headers: { Authorization: `Bearer ${playerToken}` }, signal: AbortSignal.timeout(10000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error('Falha ao ler turno confirmado: HTTP ' + response.status);
    return decodeFirestoreDocument<T>(await response.json());
  }
  const event = await read<GameEvent>('events', ids.event);
  if (!event) return { status: 'new' as const };
  const [player, engine] = await Promise.all([
    read<NarrativeEntry>('narrative', ids.player), read<NarrativeEntry>('narrative', ids.engine),
  ]);
  const entry = readCommittedTurn(turn, ownerId, event, player, engine);
  return entry ? { status: 'replayed' as const, entry } : { status: 'conflict' as const };
}

export async function fetchCampaignContext(
  campaignId: string,
  playerToken: string,
  playerUid: string,
  fetchFn: FetchFunction = fetch,
): Promise<LoadedCampaignContext | null> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(campaignId)) {
    return null;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const databaseId = process.env.FIRESTORE_DATABASE_ID;

  if (!projectId || !databaseId) {
    throw new Error('Configuracao Firestore incompleta no servidor.');
  }

  const baseUrl =
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}` +
    `/databases/${encodeURIComponent(databaseId)}/documents`;

  const campaignUrl = `${baseUrl}/campaigns/${encodeURIComponent(campaignId)}`;

  // 1. Carrega documento da campanha
  const campaignRes = await fetchFn(campaignUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${playerToken}` },
    signal: AbortSignal.timeout(10000),
  });

  if ([401, 403, 404].includes(campaignRes.status)) {
    return null;
  }

  if (!campaignRes.ok) {
    throw new Error(`Falha ao carregar campanha: HTTP ${campaignRes.status}`);
  }

  const campaignRaw = (await campaignRes.json()) as {
    fields?: Record<string, unknown>;
  };
  const campaign = decodeFirestoreDocument<Campaign>(campaignRaw);

  if (campaign.ownerId !== playerUid) {
    return null;
  }

  // Helper para consultar subcoleções filtradas estritamente por ownerId
  const querySubcollection = async <T>(
    collectionId: string,
    limit: number,
  ): Promise<T[]> => {
    const queryUrl = `${campaignUrl}:runQuery`;
    const body = {
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'ownerId' },
            op: 'EQUAL',
            value: { stringValue: playerUid },
          },
        },
        limit,
      },
    };

    const res = await fetchFn(queryUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${playerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      // Se subcoleção estiver vazia ou indisponível, não quebrar todo o turno se for 404
      if (res.status === 404) return [];
      throw new Error(`Falha ao consultar ${collectionId}: HTTP ${res.status}`);
    }

    const items = (await res.json()) as Array<{
      document?: { name?: string; fields?: Record<string, unknown> };
    }>;

    return items
      .filter((item) => Boolean(item.document?.fields))
      .map((item) => decodeFirestoreDocument<T>(item.document!));
  };

  const [inventory, npcs, narrative] = await Promise.all([
    querySubcollection<InventoryItem>('inventory', 50),
    querySubcollection<NpcRecord>('npcs', 40),
    querySubcollection<NarrativeEntry>('narrative', 40),
  ]);

  return {
    campaign,
    inventory,
    npcs,
    narrative,
  };
}

