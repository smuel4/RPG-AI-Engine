import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { freixoFamilyKitchen } from '../src/engine/npcIdentity';
import { formatWorldTimeLabel } from '../src/engine/constants';
import { advanceWorldTime, processPlayerAction } from '../src/engine/rulesEngine';

export const referenceTurns = [
  {
    action: 'Samuel pergunta a Teresa e Henrique como querem repartir a farinha.',
    response: '— Reservem metade para o pão de hoje — diz Teresa. — Separei uma tigela para isso.\nHenrique responde: — Guarde o restante em duas porções, uma para o fim da semana.',
  },
  {
    action: 'Samuel pergunta se uma das porções pode ficar na despensa.',
    response: '— A segunda, sim — responde Henrique. — A primeira fica à mão.\nTeresa aponta para a tigela. — E a metade do pão continua aqui.',
  },
  {
    action: 'Samuel pergunta a Teresa se ela precisa de mais alguma coisa.',
    response: '— Por enquanto, só da tigela — diz Teresa.\nHenrique abre a porta da despensa. — Vou arranjar espaço para a segunda porção.',
  },
] as const;

export const independentActions = [
  ...referenceTurns.map(({ action }) => action),
  'Samuel pergunta a Henrique se ele tem algum trabalho para esta manhã.',
  'Samuel pergunta a Teresa como está o restante dos preparativos em casa.',
  'Samuel fica à escuta por um momento, sem interromper.',
  'Samuel pergunta se algum dos dois precisa sair antes do almoço.',
  'Samuel oferece ajuda, caso haja algo pendente.',
  'Samuel pergunta a Teresa o que pretende servir no almoço.',
  'Samuel pede aos dois que digam como querem organizar o resto da manhã.',
];

export const familyKitchen = freixoFamilyKitchen;

export function createContinuityFixture() {
  const state = createEchoArcBundle('validation-continuity-local');
  const location = familyKitchen;
  const worldTime = advanceWorldTime(state.campaign.worldTime, 0);
  state.campaign = { ...state.campaign, currentLocation: location, worldTime };
  state.npcs = state.npcs.map((npc) =>
    npc.name === 'Teresa' || npc.name === 'Henrique' ? { ...npc, location } : npc,
  );
  state.narrative = [{
    ...state.narrative[0],
    content: 'Samuel, Teresa e Henrique estão juntos na cozinha da casa da família, na Vila de Freixo. A farinha está sobre a mesa e sua divisão ainda está em aberto.',
    worldTimeLabel: formatWorldTimeLabel(worldTime),
  }];
  return state;
}

export function advanceContinuity(
  state: ReturnType<typeof createContinuityFixture>,
  action: string,
  narration: string,
  { minutes = 5, location = state.campaign.currentLocation } = {},
): void {
  const result = processPlayerAction(state.campaign, state.inventory, state.npcs, action, minutes, narration);
  if (!result.ok) throw new Error('Falha ao aplicar o turno de teste em memória.');
  state.narrative.push(result.data.playerEntry, result.data.engineEntry);
  state.campaign = {
    ...state.campaign,
    currentLocation: location,
    worldTime: result.data.nextWorldTime,
    revision: result.data.nextRevision,
    lastSequence: result.data.nextLastSequence,
  };
}
