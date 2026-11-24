import type {
  Campaign,
  InventoryItem,
  NarrativeEntry,
  NpcRecord,
} from '../src/types/game';

import { buildNarratorContext, type NarratorMemoryInput } from './narratorMemory';
import {
  geminiNarrator,
  generateGeminiNarration,
  type GeminiContentGenerator,
} from './geminiNarrator';
import { groqNarrator } from './groqNarrator';
import type { NarrationInput, NarratorMode, NarratorProvider, NarratorProviderName } from './narratorProvider';

const providers: Record<NarratorProviderName, NarratorProvider> = {
  gemini: geminiNarrator,
  groq: groqNarrator,
};

// The lock is local to this server process; the Firestore revision check guards commits.
const activeCampaignTurns = new Set<string>();

export function tryAcquireNarratorTurn(campaignId: string): (() => void) | null {
  if (activeCampaignTurns.has(campaignId)) return null;
  activeCampaignTurns.add(campaignId);
  return () => { activeCampaignTurns.delete(campaignId); };
}

export function selectNarratorMode(
  configured: string | undefined, developmentFixedRequested = false,
): NarratorMode | null {
  const mode = configured?.trim() || 'gemini';
  if (mode === 'fixed' || mode === 'groq') return mode;
  if (mode === 'gemini') return developmentFixedRequested ? 'fixed' : mode;
  return null;
}

export interface CampaignNarrationInput extends Pick<NarratorMemoryInput,
  'sceneKnowledge' | 'npcActivities' | 'npcMemories' | 'npcRelationships' | 'publicOnly'> {
  campaign: Campaign;
  inventory: InventoryItem[];
  npcs: NpcRecord[];
  narrative: NarrativeEntry[];
  declaredAction: string;
  sceneIntent?: string;
  compact?: boolean;
}

export async function generateCampaignNarration(
  input: CampaignNarrationInput,
  provider: NarratorProviderName | GeminiContentGenerator = 'gemini',
): Promise<string> {
  const action = input.declaredAction.trim();

  if (!action || action.length > 800) {
    throw new Error('Acao do jogador invalida.');
  }

  if (input.campaign.status === 'archived') {
    throw new Error('Campanha arquivada nao aceita novas acoes.');
  }

  const narrationInput: NarrationInput = {
    declaredAction: input.declaredAction,
    context: buildNarratorContext(input),
    sceneIntent: input.sceneIntent,
    compact: input.compact,
  };
  if (typeof provider === 'function') return generateGeminiNarration(narrationInput, provider);
  return providers[provider].generate(narrationInput);
}
