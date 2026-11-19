import { checkTurnRevision, type TurnIdentity } from '../src/engine/turnIdentity';
import { planTurn, resolvePlannedOutcome, type TurnCatalog } from '../src/engine/turnPlanner';
import type { Campaign } from '../src/types/game';

export function readTurnPlanPilot(catalogJson: string | undefined, campaignId: string) {
  if (!catalogJson || !campaignId) return undefined;
  const catalog: TurnCatalog = JSON.parse(catalogJson);
  if (!Array.isArray(catalog?.places) || !Array.isArray(catalog?.routes) ||
      catalog.places.some((place) => !place || typeof place.id !== 'string' || !place.id.trim() ||
        !Array.isArray(place.aliases) || place.aliases.some((alias: unknown) => typeof alias !== 'string')) ||
      catalog.routes.some((route) => !route || !Number.isSafeInteger(route.minutes) ||
        route.minutes < 1 || route.minutes > 720 ||
        (route.blocked !== undefined && typeof route.blocked !== 'boolean'))) {
    throw new Error('Catálogo do piloto de turnos inválido.');
  }
  const places = new Set(catalog.places.map(({ id }) => id));
  if (places.size !== catalog.places.length || catalog.routes.some(({ from, to }, index) =>
    !places.has(from) || !places.has(to) || from === to ||
    catalog.routes.slice(0, index).some((route) => route.from === from && route.to === to))) {
    throw new Error('Locais ou rotas do piloto de turnos inválidos.');
  }
  return { campaignId, catalog };
}

export function evaluatePilotTurn(
  pilot: ReturnType<typeof readTurnPlanPilot>,
  turn: TurnIdentity,
  playerId: string,
  campaign: Campaign,
  // Reserved for a result produced by a trusted server rule, never by the request or prose.
  confirmed?: Parameters<typeof resolvePlannedOutcome>[1],
) {
  if (pilot?.campaignId !== campaign.id || turn.campaignId !== campaign.id ||
      campaign.ownerId !== playerId || !checkTurnRevision(turn, campaign)) return undefined;
  const plan = planTurn(turn.declaredAction, campaign, pilot.catalog);
  const outcome = confirmed && plan.status === 'planned' && plan.intent.kind === 'travel'
    ? resolvePlannedOutcome(plan, confirmed) : null;
  return {
    mode: 'preview-only' as const,
    origin: { campaignId: turn.campaignId, turnId: turn.turnId, expectedRevision: turn.expectedRevision,
      baseTimelineId: turn.baseTimelineId, location: campaign.currentLocation },
    declaredAction: turn.declaredAction,
    plan,
    confirmed: outcome ? confirmed : null,
    allowedEffects: outcome,
  };
}
