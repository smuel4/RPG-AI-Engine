export type TurnIntent =
  | { kind: 'travel'; destination: string }
  | { kind: 'observe' | 'talk' | 'open' };

export interface TurnCatalog {
  places: readonly { id: string; aliases: readonly string[] }[];
  routes: readonly { from: string; to: string; minutes: number; blocked?: boolean }[];
  objects?: readonly { id: string; name: string; aliases: readonly string[]; location: string;
    description: string; condition?: { activityId: string; initial: string } }[];
  activities?: readonly { id: string; location: string; participant: string; verb: string;
    target: string; minutes: number; result: string; blocked?: boolean }[];
}

export interface TurnPlan {
  status: 'planned';
  intent: TurnIntent;
  origin: string;
  destination?: string;
  expectedMinutes: number | null;
  conditions: readonly string[];
  authorized: { location?: string; maxMinutes: number };
}

export type TurnPlanningResult = TurnPlan | {
  status: 'clarification';
  origin: string;
  reason: 'ambiguous-destination' | 'unknown-destination' | 'unknown-route' | 'unmet-conditions';
};

function words(value: string): string[] {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function contains(tokens: string[], alias: string): boolean {
  const key = words(alias);
  return key.length > 0 && tokens.some((_, i) => key.every((word, j) => tokens[i + j] === word));
}

export function planTurn(
  action: string | TurnIntent,
  state: { currentLocation: string },
  catalog: TurnCatalog,
  conditions: readonly { description: string; met: boolean }[] = [],
): TurnPlanningResult {
  const origin = state.currentLocation;
  const clarify = (reason: Extract<TurnPlanningResult, { status: 'clarification' }>['reason']): TurnPlanningResult =>
    ({ status: 'clarification', origin, reason });
  let intent: TurnIntent;
  if (typeof action !== 'string') {
    intent = action;
  } else {
    const tokens = words(action);
    if (tokens[0] === 'eu') tokens.shift();
    const [first, second] = tokens;
    const travel = ['sigo', 'caminho', 'ando', 'volto', 'retorno', 'entro', 'chego', 'saio', 'sair'].includes(first) ||
      (first === 'vou' && ['ao', 'a', 'para', 'ate', 'fora', 'la', 'ali', 'aqui', 'so', 'apenas'].includes(second));
    if (travel) {
      if (action.includes('?') || ['ou', 'talvez', 'se', 'nao'].some((word) => tokens.includes(word))) {
        return clarify('ambiguous-destination');
      }
      const matches = catalog.places.filter(({ id, aliases }) =>
        [id, ...aliases].some((alias) => contains(tokens.slice(1), alias)));
      if (matches.length !== 1) return clarify(matches.length ? 'ambiguous-destination' : 'unknown-destination');
      intent = { kind: 'travel', destination: matches[0].id };
    } else {
      intent = { kind: ['olho', 'observo', 'examino', 'inspeciono'].includes(first) ? 'observe'
        : ['bom', 'boa', 'ola', 'falo', 'converso', 'pergunto', 'digo'].includes(first) ? 'talk' : 'open' };
    }
  }
  if (conditions.some(({ met }) => !met)) return clarify('unmet-conditions');
  const destination = intent.kind === 'travel' ? intent.destination : undefined;
  if (destination !== undefined && !catalog.places.some(({ id }) => id === destination)) return clarify('unknown-destination');
  const route = catalog.routes.find(({ from, to }) => from === origin && to === destination);
  if (destination !== undefined && destination !== origin && route?.blocked) return clarify('unmet-conditions');
  const expectedMinutes = destination === undefined
    ? intent.kind === 'observe' ? 1 : null
    : destination === origin ? 0 : route?.minutes;
  if (expectedMinutes === undefined || (expectedMinutes !== null &&
      (!Number.isSafeInteger(expectedMinutes) || expectedMinutes < 0 || expectedMinutes > 720))) return clarify('unknown-route');
  return { status: 'planned', origin, intent, destination, expectedMinutes,
    conditions: conditions.map(({ description }) => description),
    authorized: { location: destination, maxMinutes: expectedMinutes ?? 0 } };
}

export function resolvePlannedOutcome(plan: TurnPlan, result: { completed: boolean; elapsedMinutes: number }) {
  const { elapsedMinutes, completed } = result;
  if (!Number.isSafeInteger(elapsedMinutes) || elapsedMinutes < 0 || elapsedMinutes > plan.authorized.maxMinutes) return null;
  if (completed && plan.intent.kind === 'travel' && elapsedMinutes !== plan.expectedMinutes) return null;
  return { location: completed ? plan.authorized.location ?? plan.origin : plan.origin, elapsedMinutes };
}
