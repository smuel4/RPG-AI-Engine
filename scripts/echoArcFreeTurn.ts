import { NarratorFailure } from '../server/narratorProvider';
import type { CampaignNarrationInput } from '../server/narratorService';
import { advanceContinuity, familyKitchen, type createContinuityFixture } from './echoArcContinuityFixture';
import { reviewEchoArcNarration } from './narrativeReview';
import { planTurn } from '../src/engine/turnPlanner';
import { createWellEncounterNpc } from '../src/engine/echoArcEncounters';
import { familyRoom, familyYard, localCatalog, villageWell } from '../src/world/freixo';
export { familyRoom, familyYard, freixoPlayableCatalog, localCatalog, villageWell } from '../src/world/freixo';

const destinations = [
  { location: familyYard, name: /\b(?:quintal|patio|fora)\b/ },
  { location: familyKitchen, name: /\b(?:cozinha|casa)\b/ },
  { location: villageWell, name: /\bpoco\b/ },
];
type FreeState = ReturnType<typeof createContinuityFixture>;
type Routine = { plan: FreeTurnPlan; fallback: string };
type FreeTurnNarration = 'review' | 'narrated-plan' | 'plan-fallback';

const normalize = (text: string) => text.trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

export function shouldEndFreeSession(input: string): boolean {
  return input.trim().toLowerCase() === ':sair';
}

export class FreeTurnClarification extends NarratorFailure {
  constructor(readonly question: string, readonly subject?: 'water' | 'destination') {
    super('TURN_NEEDS_CLARIFICATION', 'response');
  }
}

export function resumeFreeAction(answer: string, clarification?: FreeTurnClarification): string {
  const place = normalize(answer).replace(/^(?:no|na|ao|a|em|para o|para a)\s+/, '').replace(/[.!]$/, '');
  if (!/^(?:poco|quintal|patio|casa|cozinha|fora)$/.test(place)) return answer;
  if (clarification?.subject === 'water') return 'vou pegar água em ' + answer;
  if (clarification?.subject === 'destination') return 'vou para ' + answer;
  return answer;
}

function resolveRoutine(state: FreeState, declaredAction: string): Routine | undefined {
  const origin = state.campaign.currentLocation;
  const action = normalize(declaredAction);
  const plan = planFreeTurn(origin, declaredAction);
  const clarify = (message: string, subject?: FreeTurnClarification['subject']): never => {
    throw new FreeTurnClarification(message, subject);
  };
  const routine = (location: string, minutes: number, fallback: string): Routine =>
    ({ plan: { ...plan, kind: location === origin ? plan.kind : 'travel', location, minutes }, fallback });

  const followsRequest = /^(?:eu )?(?:faco|cumpro)\b.*\b(?:pediu|pedido)\b/.test(action);
  const wantsWater = /^(?:eu )?(?:vou (?:ao|ate o) poco\b.*?)?(?:vou )?(?:pego|pegar|busco|buscar|encher)\b.*\bagua\b/.test(action);
  if (followsRequest || wantsWater) {
    const recent = state.narrative.filter((entry) => entry.authorRole === 'engine_response').slice(-3);
    const reverseRequest = [...recent].reverse().findIndex(({ content }) =>
      content.split(/\n\s*\n/).some((paragraph) => {
        const words = normalize(paragraph);
        return /\bteresa\b/.test(words) && /\b(?:se puder|poderia|por favor)\b/.test(words) &&
          /\bpoco\b/.test(words) && /\b(?:cantil|agua|balde)\b/.test(words);
      }));
    const fulfilled = reverseRequest >= 0 && recent.slice(recent.length - reverseRequest)
      .some(({ content }) => /(?:Samuel|Ele) tira água\./.test(content));
    const motherRequestedWater = /\b(?:mae|teresa)\b/.test(action) && reverseRequest >= 0 && !fulfilled;
    if (followsRequest && !motherRequestedWater) return clarify('Qual pedido você quer atender?');
    if (!motherRequestedWater && !/\bpoco\b/.test(action) && origin !== villageWell) {
      return clarify('Onde você quer pegar água?', 'water');
    }
    if (/\b(?:ou|talvez|nao)\b|\?/.test(action)) return clarify('Qual é o seu plano para buscar a água?');
    const waterPlan = planTurn({ kind: 'travel', destination: villageWell }, { currentLocation: origin }, localCatalog);
    const minutes = waterPlan.status === 'planned' ? waterPlan.expectedMinutes ?? undefined : undefined;
    if (minutes === undefined) return clarify('Por onde você quer seguir até o poço?');
    const returnsHome = /\b(?:chego|volto|retorno)\s+(?:em|para)\s+casa\b/.test(action);
    const hasContainer = state.inventory.some(({ name, quantity }) => /\b(?:cantil|balde)\b/.test(normalize(name)) && quantity > 0);
    const opening = origin === villageWell ? 'Junto ao poço, ' : 'Samuel chega ao poço. ';
    if (!hasContainer) {
      return routine(villageWell, minutes, opening + 'Falta um recipiente confirmado para levar a água.');
    }
    return routine(returnsHome ? familyKitchen : villageWell, minutes + 2 + (returnsHome ? 6 : 0),
      opening + (origin === villageWell ? 'Samuel tira água.' : 'Ele tira água.') +
      (returnsHome ? ' Em seguida, volta para a cozinha.' : ''));
  }

  if (/\barrum[oa]r?\b.*\bquarto\b/.test(action) && /^(?:eu )?(?:vou|subo|arrumo)\b/.test(action)) {
    if (/\b(?:ou|talvez|nao)\b|\?/.test(action)) return clarify('Você quer subir para arrumar o quarto agora?');
    if (origin !== familyRoom && origin !== familyKitchen) return clarify('Por onde você quer entrar para subir ao quarto?');
    return routine(familyRoom, origin === familyRoom ? 5 : 6, 'Samuel arruma o quarto.');
  }

  if (plan.decision) return clarify('Para onde você quer ir?', 'destination');
  if (plan.kind === 'travel') {
    if (/(?:[,;]|\b(?:e|depois)\b)\s+(?!(?:olho|observo|vejo|examino)\b)\w+/.test(action)) return undefined;
    const detail = plan.location === familyYard && /\b(?:olho|vejo|observo|examino)\b/.test(action)
      ? ' Dali se vê o caminho que liga a casa à rua.' : '';
    const arrival = plan.location === familyYard ? 'Samuel chega ao quintal.'
      : plan.location === villageWell ? 'Samuel chega ao poço.' : 'Samuel chega à cozinha.';
    const presence = plan.location === villageWell && state.npcs.some(({ name, location }) => name === 'Lira' && location === villageWell)
      ? ' Lira está junto ao poço.' : '';
    return routine(plan.location, plan.minutes, arrival + detail + presence);
  }
  if (/^(?:bom dia|boa tarde|boa noite)[.!]?$/.test(action)) {
    const names = state.npcs.filter((npc) => npc.location === origin).map(({ name }) => name);
    const person = names[0];
    return routine(origin, 0, person ? person + ' retribui o cumprimento.' : 'O cumprimento de Samuel fica no ar.');
  }
  return undefined;
}

export function placeWellEncounter(state: ReturnType<typeof createContinuityFixture>) {
  state.npcs.push(createWellEncounterNpc(state.npcs[0].ownerId, state.npcs[0].campaignId));
}

export interface FreeTurnPlan {
  kind: 'travel' | 'observe' | 'work' | 'open';
  origin: string;
  location: string;
  minutes: number;
  focus: string;
  requiredObjects?: string;
  decision?: string;
}

function contradictsRoutine(state: FreeState, routine: Routine, narration: string): boolean {
  const text = normalize(narration);
  const { plan, fallback } = routine;
  const elsewhere = destinations.filter(({ location }) => location !== plan.location);
  const movement = /\b(?:vai|segue|caminha|chega|entra|volta|retorna|dirige-se|se dirige)\b[^.!?\n]{0,45}/g;
  const plannedEffects = normalize(fallback);
  const knownElsewhere = state.npcs.filter(({ location }) => location !== plan.location);
  const inventedPresence = knownElsewhere.some(({ name }) => {
    const npc = normalize(name);
    return text.split(/[.!?\n]/).some((sentence) =>
      sentence.trim().startsWith(npc + ' ') &&
      /^\s*(?:esta|se aproxima|aproxima-se|diz|pergunta|responde|retruca|acena)\b/.test(sentence.trim().slice(npc.length)));
  });
  return [...text.matchAll(movement)].some(([move]) =>
    elsewhere.some(({ name }) => name.test(move) && !name.test(plannedEffects))) ||
    inventedPresence ||
    reviewEchoArcNarration(narration).includes('revisar_acao_com_consequencia') ||
    /\bsamuel\b[^.!?\n]{0,45}\b(?:entrega|entregou|bebe|bebeu|promete|prometeu|decide|decidiu|compra|comprou|vende|vendeu|diz|disse|responde|respondeu|pergunta|perguntou)\b/.test(text);
}

export function planFreeTurn(origin: string, declaredAction: string): FreeTurnPlan {
  const action = normalize(declaredAction).replace(/^eu\s+/, '').replace(/^vou\s+(?:apenas|so)\s+/, 'vou ');
  const movement = /^(?:vou\s+(?:ao|a|para|ate|(?:(?:la|ali|aqui)\s+)?fora)\b|(?:sigo|caminho|ando|volto|retorno|entro|chego|saio|sair)\b)/.test(action);
  const work = /^(?:(?:vou|comeco a) cortar|corto) (?:a lenha|lenha|madeira|as madeiras)\b/.test(action);
  if (movement && !work) {
    // Read the destination from the movement clause, independently of what the player does on arrival.
    const leg = action.split(/\s+e\s+(?=(?:vejo|olho|observo|examino|falo|converso)\b)|[,;]/, 1)[0];
    const target = leg.replace(/\b(?:da|do|de) (?:casa|cozinha|quintal|patio|poco)\b/g, '');
    const matches = destinations.filter(({ name }) => name.test(target));
    const destination = matches.length === 1 ? matches[0].location
      : /^sai[ro][.!]?$/.test(target.trim()) && origin === familyKitchen && matches.length === 0
        ? familyYard : undefined;
    const sharedPlan = destination && planTurn({ kind: 'travel', destination }, { currentLocation: origin }, localCatalog);
    if (!/\b(?:se|talvez|ou|tento|nao)\b|\?/.test(action)) {
      if (sharedPlan && sharedPlan.status === 'planned' && destination !== origin && sharedPlan.expectedMinutes !== null) {
        return { kind: 'travel', origin, location: sharedPlan.destination!, minutes: sharedPlan.expectedMinutes,
          focus: 'Descreva a chegada prevista e responda ao restante da ação a partir do destino.' };
      }
      if (destination === origin) {
        return { kind: 'observe', origin, location: origin, minutes: 0,
          focus: 'Samuel já está no destino. Mostre o que está ao alcance dele, sem repetir o percurso.' };
      }
    }
    return { kind: 'open', origin, location: origin, minutes: 0,
      focus: 'O deslocamento ainda não está confirmado. Mantenha a situação atual.',
      decision: 'Deixe o jogador esclarecer a intenção ou escolher o próximo trecho.' };
  }
  const sharedPlan = planTurn(declaredAction, { currentLocation: origin }, localCatalog);
  if (sharedPlan.status === 'planned' && sharedPlan.intent.kind === 'observe') {
    return { kind: 'observe', origin, location: origin, minutes: 1,
      focus: 'Comece pelo que Samuel pode observar daqui, com foco no alvo indicado.' };
  }
  if (work) {
    return { kind: 'work', origin, location: origin, minutes: 10,
      focus: 'Mostre o começo da atividade se houver condições, ou o obstáculo visível. Deixe o restante da tarefa em aberto.',
      requiredObjects: 'Madeira disponível e ferramenta apropriada confirmada' };
  }
  return { kind: 'open', origin, location: origin, minutes: 5, focus: 'Responda primeiro à intenção da ação mais recente.' };
}

export async function runFreeTurn(
  state: ReturnType<typeof createContinuityFixture>,
  declaredAction: string,
  sceneIntent: string,
  generate: (input: CampaignNarrationInput) => Promise<string>,
  confirm?: (plan: FreeTurnPlan, narration: string, source: FreeTurnNarration) => Promise<boolean>,
  useLocalPlanning = false,
): Promise<string> {
  const routine = useLocalPlanning ? resolveRoutine(state, declaredAction) : undefined;
  const plan = routine?.plan ?? planFreeTurn(state.campaign.currentLocation, declaredAction);
  const input = {
    ...state,
    campaign: { ...state.campaign, currentLocation: plan.location },
    declaredAction,
    sceneIntent: [sceneIntent, plan.focus, plan.decision,
      'O local e a presença informados são os previstos para o fim da ação; não crie outro deslocamento.',
      routine && 'Resultado do plano: ' + routine.fallback +
        ' Use-o como referência, sem repetir sua formulação. Enriqueça com voz dos NPCs, reações ou detalhes do local, sem dar novas falas ou ações relevantes a Samuel.',
      plan.requiredObjects && 'Pré-condições para executar: ' + plan.requiredObjects + '.',
      'Em ações simples, use um momento breve: uma reação e um detalhe novo se couber. Em cena complexa, dê espaço ao que muda.'].filter(Boolean).join(' '),
  };
  let narration: string;
  try {
    narration = await generate(input);
  } catch (error) {
    if (!(error instanceof NarratorFailure) || error.code !== 'NARRATION_EXCEEDS_LIMIT') throw error;
    narration = await generate({ ...input, compact: true });
  }
  let source: FreeTurnNarration = routine ? 'narrated-plan' : 'review';
  if (routine && contradictsRoutine(state, routine, narration)) {
    narration = routine.fallback;
    source = 'plan-fallback';
  }
  if (confirm && !await confirm(plan, narration, source)) throw new NarratorFailure('TURN_NOT_CONFIRMED', 'response');
  advanceContinuity(state, declaredAction, narration, plan);
  return narration;
}
