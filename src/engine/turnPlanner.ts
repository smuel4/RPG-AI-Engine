import type { WorldTime } from '../types/game';

export type TurnIntent =
  | { kind: 'travel'; destination: string }
  | { kind: 'observe' | 'talk' | 'open' };

export interface TurnCatalog {
  places: readonly { id: string; aliases: readonly string[] }[];
  routes: readonly { from: string; to: string; minutes: number; blocked?: boolean }[];
  objects?: readonly { id: string; name: string; aliases: readonly string[]; location: string;
    description: string; condition?: { activityId: string; initial: string; organize?: { completed: string };
      knownBy?: readonly string[] };
    openable?: { aberto: string; fechado: string };
    portable?: { storageId?: string; ownerNpcId?: string; delivery?: { recipientKey: string; location: string } } }[];
  activities?: readonly { id: string; location: string; participant: string; verb: string;
    target: string; minutes: number; result: string; blocked?: boolean }[];
}

export interface TurnPlan {
  status: 'planned';
  intent: TurnIntent;
  origin: string;
  destination?: string;
  expectedMinutes: number | null;
  routePath?: readonly string[];
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

function labelKey(text: string) {
  return words(text).join(' ').replace(/^(?:a|o|as|os) /u, '');
}

function oneSmallEdit(input: string, label: string) {
  if (!/^[a-z]{5,}$/u.test(label) || !/^[a-z]{4,}$/u.test(input) ||
      Math.abs(input.length - label.length) > 1) return false;
  const mismatch = input.split('').findIndex((letter, index) => letter !== label[index]);
  if (mismatch < 0) return input.length + 1 === label.length;
  const from = input.slice(mismatch);
  const to = label.slice(mismatch);
  if (from.length < to.length) return from === to.slice(1);
  if (from.length > to.length) return to === from.slice(1);
  return from.slice(1) === to.slice(1) ||
    (from[0] === to[1] && from[1] === to[0] && from.slice(2) === to.slice(2));
}

export function matchCatalogLabels<T>(text: string, entries: readonly T[],
  labels: (entry: T) => readonly string[], allowTypo = false) {
  const key = labelKey(text);
  const exact = entries.filter((entry) => labels(entry).some((label) => key === labelKey(label)));
  if (exact.length || !allowTypo || !key) return exact;
  const input = key.split(' ');
  return entries.filter((entry) => labels(entry).some((label) => {
    const tokens = labelKey(label).split(' ');
    if (tokens.length !== input.length) return false;
    const different = tokens.map((token, index) => token === input[index] ? -1 : index).filter((index) => index >= 0);
    return different.length === 1 && oneSmallEdit(input[different[0]], tokens[different[0]]);
  }));
}

export function planTurn(
  action: string | TurnIntent,
  state: { currentLocation: string },
  catalog: TurnCatalog,
  conditions: readonly { description: string; met: boolean }[] = [],
  routeLimits?: { maxHops: number; maxMinutes: number },
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
  const path = routeLimits && destination !== undefined && origin !== destination
    ? findRoute(origin, destination, catalog, routeLimits) : undefined;
  if (destination !== undefined && destination !== origin && route?.blocked && !path) return clarify('unmet-conditions');
  const expectedMinutes = destination === undefined
    ? intent.kind === 'observe' ? 1 : null
    : destination === origin ? 0 : routeLimits ? path?.minutes : route?.minutes;
  if (expectedMinutes === undefined || (expectedMinutes !== null &&
      (!Number.isSafeInteger(expectedMinutes) || expectedMinutes < 0 || expectedMinutes > 720))) return clarify('unknown-route');
  return { status: 'planned', origin, intent, destination, expectedMinutes,
    ...(path ? { routePath: path.places } : {}),
    conditions: conditions.map(({ description }) => description),
    authorized: { location: destination, maxMinutes: expectedMinutes ?? 0 } };
}

function findRoute(origin: string, destination: string, catalog: TurnCatalog,
  limits: { maxHops: number; maxMinutes: number }) {
  const known = new Set(catalog.places.map(({ id }) => id));
  if (!known.has(origin)) return;
  let best: { places: string[]; minutes: number } | undefined;
  function visit(places: string[], minutes: number) {
    const current = places.at(-1);
    if (current === destination) {
      if (!best || minutes < best.minutes || (minutes === best.minutes && places.length < best.places.length)) {
        best = { places, minutes };
      }
      return;
    }
    if (places.length > limits.maxHops || (places.length > 1 && minutes > limits.maxMinutes)) return;
    for (const edge of catalog.routes) {
      if (edge.from !== current || edge.blocked || !known.has(edge.to) || places.includes(edge.to) ||
          !Number.isSafeInteger(edge.minutes) || edge.minutes < 1 || edge.minutes > 720) continue;
      const total = minutes + edge.minutes;
      if (places.length > 1 && total > limits.maxMinutes) continue;
      visit([...places, edge.to], total);
    }
  }
  visit([origin], 0);
  return best;
}

export function planPilotTravel(action: string, state: { currentLocation: string }, catalog: TurnCatalog): TurnPlanningResult {
  const source = action.normalize('NFD').replace(/\p{M}/gu, '').trim().replace(/\s+/gu, ' ').toLowerCase();
  const command = /^(?:eu )?(?:vou(?: dar uma volta)?|caminho|sigo|quero ir) (?:(?:da|do|de) ([\p{L}\p{N} -]+?) para |(?:ate|ao|a|para) )([\p{L}\p{N} -]+?)[.!]*$/u.exec(source);
  const refuse = (reason: 'unknown-destination' | 'ambiguous-destination' | 'unknown-route'): TurnPlanningResult =>
    ({ status: 'clarification', origin: state.currentLocation, reason });
  if (/\bou\b/u.test(source)) return refuse('ambiguous-destination');
  if (!command || /\b(?:talvez|se|nao|depois|mas)\b/u.test(source)) return refuse('unknown-destination');
  const labels = ({ id, aliases }: TurnCatalog['places'][number]) => [id, ...aliases];
  const destinations = matchCatalogLabels(command[2], catalog.places, labels, true);
  if (destinations.length !== 1) return refuse(destinations.length ? 'ambiguous-destination' : 'unknown-destination');
  if (command[1]) {
    const origins = matchCatalogLabels(command[1], catalog.places, labels);
    if (origins.length !== 1 || origins[0].id !== state.currentLocation) return refuse('unknown-route');
  }
  // Keep the pilot's existing full-interval routine simulation to short trips.
  return planTurn({ kind: 'travel', destination: destinations[0].id }, state, catalog, [], { maxHops: 3, maxMinutes: 30 });
}

export const WAIT_MAX_MINUTES = 60;

export function planPilotWait(action: string, time: WorldTime) {
  const text = action.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/gu, ' ');
  const command = /^(?:eu )?(?:espero|aguardo|fico aqui esperando)(?:\s+|[.?!]*$)/u.exec(text);
  if (!command) return;
  const period = text.slice(command[0].length).replace(/[.!]+$/u, '').trim();
  const clock = /^ate (?:as )?(\d{1,2})(?:h(\d{2})?|:(\d{2}))$/u.exec(period);
  const current = time.hour * 60 + time.minute;
  let minutes: number;
  if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2] ?? clock[3] ?? 0);
    if (hour > 23 || minute > 59) return { status: 'refused', reason: 'invalid' } as const;
    minutes = hour * 60 + minute - current;
    if (minutes <= 0) return { status: 'refused', reason: 'past' } as const;
  } else {
    const duration = /^([+-]?\d+) (minutos?|min|horas?)$/u.exec(period);
    if (period === 'meia hora') minutes = 30;
    else if (period === 'uma hora') minutes = 60;
    else if (duration) minutes = Number(duration[1]) * (duration[2].startsWith('hora') ? 60 : 1);
    else return { status: 'refused', reason: period.startsWith('ate ') ? 'invalid' : 'unspecified' } as const;
  }
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > WAIT_MAX_MINUTES) {
    return { status: 'refused', reason: 'limit' } as const;
  }
  if (current + minutes >= 24 * 60) return { status: 'refused', reason: 'midnight' } as const;
  return { status: 'planned', minutes } as const;
}

export function resolvePlannedOutcome(plan: TurnPlan, result: { completed: boolean; elapsedMinutes: number }) {
  const { elapsedMinutes, completed } = result;
  if (!Number.isSafeInteger(elapsedMinutes) || elapsedMinutes < 0 || elapsedMinutes > plan.authorized.maxMinutes) return null;
  if (completed && plan.intent.kind === 'travel' && elapsedMinutes !== plan.expectedMinutes) return null;
  return { location: completed ? plan.authorized.location ?? plan.origin : plan.origin, elapsedMinutes };
}
