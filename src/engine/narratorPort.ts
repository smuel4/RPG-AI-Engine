import type { Campaign, InventoryItem, NpcRecord } from '../types/game';
import { formatWorldClock } from './constants';

export interface NarratorContext {
  campaign: Campaign;
  inventory: InventoryItem[];
  npcs: NpcRecord[];
  declaredAction: string;
}

export interface NarratorAdapter {
  readonly mode: 'fixed-milestone-1' | 'gemini-stage-2';
  respondToPlayerAction(context: NarratorContext): string;
}

/**
 * Implementação fixa para o Primeiro Marco Funcional.
 * Regra estrita: nunca inventar escolhas, diálogos ou decisões irreversíveis em nome do protagonista.
 * Apenas confirma o registro da ação declarada dentro da ambientação atual.
 */
export class FixedMilestoneNarrator implements NarratorAdapter {
  public readonly mode = 'fixed-milestone-1' as const;

  public respondToPlayerAction(context: NarratorContext): string {
    const { campaign, declaredAction } = context;
    const protagonistName = campaign.protagonist.name;
    const clock = formatWorldClock(campaign.worldTime);

    return (
      `[Narrativa fixa de teste · ${campaign.currentLocation}, ${clock}] ` +
      `A ação declarada para ${protagonistName} foi registrada ("${declaredAction}"). ` +
      `O ambiente de ${campaign.currentLocation} permanece estável e aguardando a próxima decisão exclusiva do jogador — ` +
      `nenhum acontecimento canônico irreversível ou escolha não autorizada foi gerado nesta etapa.`
    );
  }
}

export const defaultNarratorAdapter: NarratorAdapter = new FixedMilestoneNarrator();
