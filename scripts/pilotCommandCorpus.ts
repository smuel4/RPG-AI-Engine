import {
  familyYard as yard, freixoFamilyKitchen as kitchen, familyRoom as room,
  freixoWoodland as woods, freixoWoodWorkshop as shop, villageWell as well,
} from '../src/world/freixo';

export const targets = {
  lira: 'freixo-local-lira', teresa: 'echo-arc:teresa', henrique: 'echo-arc:henrique',
  marker: 'freixo-bosque-marco-pedra', cupboard: 'demo-armario-cozinha',
  block: 'demo-bloco-madeira', bench: 'demo-bancada-cozinha',
};

type Outcome = 'executar' | 'consultar' | 'recusar' | 'esclarecer' | 'abster-se';
export interface CommandStep {
  kind: string;
  target?: string;
  statement?: string;
  to?: string;
  containerId?: string;
  recipientId?: string;
}
export interface CommandCase {
  id: string;
  split: 'original' | 'development' | 'holdout';
  text: string;
  scene: { location: string; setup?: readonly string[]; withoutRoutes?: boolean; blockedDestination?: string; clock?: [number, number] };
  expected: Outcome;
  steps: readonly CommandStep[];
  reason: string;
  minutes?: number;
  answer?: string;
  refusal?: { group: 'blocked' | 'missing' | 'clarify' | 'unsupported' | 'abstain'; code?: string;
    reason?: string; step?: number; absentNpcName?: string; objectName?: string };
}

const { lira, teresa, henrique, marker, cupboard, block, bench } = targets;
const step = (kind: string, target?: string, extra?: Omit<CommandStep, 'kind' | 'target'>): CommandStep =>
  ({ kind, ...(target === undefined ? {} : { target }), ...extra });
const travel = (target: string) => step('travel', target);
const speech = (target: string, statement?: string) => step('speech', target, statement === undefined ? {} : { statement });
const observe = (target: string) => step('observation', target);
const open = step('open-close', cupboard, { to: 'aberto' });
const close = step('open-close', cupboard, { to: 'fechado' });
const wait = step('wait');
const pickup = step('pickup', block);
const where = (location: string, setup?: readonly string[]): CommandCase['scene'] => ({ location, setup });
const atHome = where(kitchen), atWell = where(well), inWoods = where(woods), inYard = where(yard);
const run = (text: string, scene: CommandCase['scene'], steps: CommandStep[], minutes: number, reason: string) =>
  ({ text, scene, steps, minutes, reason, expected: 'executar' } as const);
const ask = (text: string, scene: CommandCase['scene'], intention: CommandStep, answer: string, reason: string) =>
  ({ text, scene, steps: [intention], answer, minutes: 0, reason, expected: 'consultar' } as const);
const refuse = (text: string, scene: CommandCase['scene'], steps: CommandStep[], refusal: NonNullable<CommandCase['refusal']>,
  reason: string): Omit<CommandCase, 'id' | 'split'> => ({ text, scene, steps, refusal, reason,
  expected: refusal.group === 'clarify' ? 'esclarecer' : refusal.group === 'abstain' ? 'abster-se' : 'recusar' });
const blocked = (code: string, details?: Partial<CommandCase['refusal']>) => ({ group: 'blocked' as const, code, ...details });
const missing = (code: string, reason?: string) => ({ group: 'missing' as const, code, reason });
const clarify = (code?: string, reason?: string) => ({ group: 'clarify' as const, code, reason });
const unsupported = { group: 'unsupported', code: 'PILOT_ACTION_UNSUPPORTED' } as const;
const abstain = { group: 'abstain', code: 'PILOT_ACTION_UNSUPPORTED' } as const;
const travelError = 'PILOT_TRAVEL_UNAVAILABLE';
const rows = (split: CommandCase['split'], entries: Omit<CommandCase, 'id' | 'split'>[]): CommandCase[] =>
  entries.map((entry, i) => ({ id: split + '-' + String(i + 1).padStart(2, '0'), split, ...entry }));

export const commandCorpus: readonly CommandCase[] = [
  ...rows('original', [
    run('Volto ao poço.', inYard, [travel(well)], 4, 'Retorno direto pelo quintal.'),
    run('Quero retornar para o poço.', inWoods, [travel(well)], 5, 'Retorno direto pelo bosque.'),
    run('Vou até a oficina.', inYard, [travel(shop)], 4, 'Oficina ligada ao quintal.'),
    run('Quero conversar com Lira.', atWell, [speech(lira)], 0, 'Lira presente.'),
    ask('Será que consigo ir ao bosque?', atWell, step('route-query', woods), woods + '. O percurso leva 5 min', 'Pergunta sobre acesso.'),
    run('Aguardo cinco minutos.', atHome, [wait], 5, 'Duração explícita.'),
    run('Abro o armário.', atHome, [open], 0, 'Armário local e fechado.'),
    run('Examino o marco.', inWoods, [observe(marker)], 0, 'Marco fixo ao alcance.'),
    run('Examino aquele marco.', where(woods, ['Examino o marco.']), [observe(marker)], 0, 'Foco do turno anterior.'),
    run('Vou ao poço e converso com Lira.', atHome, [travel(well), speech(lira)], 6, 'Lira presente na chegada.'),
    refuse('Quero conversar com Lira.', atHome, [speech(lira)], blocked('PILOT_SPEECH_UNAVAILABLE', { absentNpcName: 'Lira' }), 'Lira está no poço.'),
    refuse('Vou ao bosque e converso com Lira.', atHome, [travel(woods), speech(lira)],
      blocked('PILOT_SPEECH_UNAVAILABLE', { step: 2, absentNpcName: 'Lira' }), 'A ausência no bosque invalida também a viagem.'),
    refuse('Vou ao castelo.', atHome, [travel('castelo')], missing(travelError, 'unknown-destination'), 'Castelo ausente do mapa.'),
    refuse('Pego o cetro.', atHome, [step('pickup', 'cetro')], missing('PILOT_OBJECT_UNREGISTERED'), 'Cetro ausente do catálogo.'),
    refuse('Vou ao poço ou à oficina.', atHome, [travel(well), travel(shop)], clarify(travelError, 'ambiguous-destination'), 'Duas alternativas sem escolha.'),
    refuse('Lanço uma magia.', atHome, [step('magic')], unsupported, 'Mecânica inexistente.'),
    run('Bato perna rumo ao poço.', inYard, [travel(well)], 4, 'Deslocamento coloquial com destino único. Na etapa anterior media recusa segura.'),
    refuse('Não quero sair daqui.', atHome, [], abstain, 'Negativa sem ação afirmativa.'),
    refuse('Se eu voltar ao poço.', atHome, [travel(well)], abstain, 'Hipótese incompleta.'),
  ]),
  ...rows('development', [
    run('Quero regressar ao poço.', inWoods, [travel(well)], 5, 'Sinônimo de retornar.'),
    run('Vou dar uma passada na oficina.', inYard, [travel(shop)], 4, 'Expressão coloquial de deslocamento deliberado.'),
    ask('Dá para chegar ao bosque por aqui?', atWell, step('route-query', woods), woods + '. O percurso leva 5 min', 'Viabilidade da rota, sem partida.'),
    run('Vou ao poço e depois falo com Lira.', atHome, [travel(well), speech(lira)], 6, 'Ordem explícita, fala após a chegada.'),
    run('Examino melhor aquele marco.', where(woods, ['Examino o marco.']), [observe(marker)], 0, 'O advérbio aprofunda a inspeção do foco.'),
    refuse('Não vou sair daqui.', atHome, [], abstain, 'Negativa explícita.'),
    refuse('Talvez eu devesse procurar Teresa.', atHome, [step('npc-query', teresa)], abstain, 'Consideração, sem ordem.'),
    ask('Onde está Henrique?', atHome, step('npc-query', henrique), 'nem confirmar onde encontrá-la', 'Henrique ausente; resposta limitada à presença local.'),
    refuse('Pego o marco de pedra.', inWoods, [step('pickup', marker)], blocked('PILOT_OBJECT_FIXED'), 'Marco fixo.'),
    refuse('Vou para a Academia de Arvend.', atHome, [travel('Academia de Arvend')], missing(travelError, 'uncatalogued-destination'), 'Citável na ambientação, ausente do mapa.'),
    run('Caminho até o quarto.', atHome, [travel(room)], 1, 'Rota curta disponível.'),
    refuse('Vou ao poço.', { ...atHome, withoutRoutes: true }, [travel(well)], blocked(travelError, { reason: 'unknown-route' }), 'Destino catalogado em fixture sem rotas.'),
    ask('Como chego ao poço?', atHome, step('route-query', well), well + '. O percurso leva 6 min', 'Instrução de rota não autoriza partida.'),
    ask('Onde posso encontrar Lira?', atWell, step('npc-query', lira), 'Lira está aqui', 'Confirma presença no local atual.'),
    run('Digo a Lira: A água está fria.', atWell, [speech(lira, 'A água está fria.')], 0, 'Preserva a fala literal e a destinatária.'),
    run('Dou uma olhada nos arredores.', inWoods, [observe(woods)], 0, 'Inspeção do ambiente atual.'),
    refuse('Examino.', atHome, [step('observation')], clarify('PILOT_OBJECT_AMBIGUOUS'), 'Vários objetos, nenhum alvo.'),
    refuse('Examino o marco.', atHome, [observe(marker)], blocked('PILOT_OBJECT_OUT_OF_REACH', { objectName: 'marco' }), 'Marco fora do alcance.'),
    run('Pego o bloco de madeira.', atHome, [pickup], 0, 'Bloco livre e disponível na cozinha.'),
    refuse('Largo o bloco.', atHome, [step('drop', block)], blocked('PILOT_OBJECT_NOT_HELD'), 'Nenhum bloco no inventário.'),
    run('Largo o bloco.', where(kitchen, ['Pego o bloco.']), [step('drop', block)], 0, 'Posse estabelecida antes do turno.'),
    refuse('Guardo o bloco no armário.', where(kitchen, ['Pego o bloco.']), [step('store', block, { containerId: cupboard })],
      blocked('PILOT_STORAGE_CLOSED'), 'Bloco em mãos, armário fechado.'),
    run('Guardo o bloco no armário.', where(kitchen, ['Pego o bloco.', 'Abro o armário.']),
      [step('store', block, { containerId: cupboard })], 0, 'Bloco em mãos, armário aberto.'),
    run('Fecho o armário.', where(kitchen, ['Abro o armário.']), [close], 0, 'O armário começa aberto.'),
    run('Arrumo a bancada.', atHome, [step('organize', bench)], 5, 'Organização local ainda não concluída.'),
    run('Deixo dez minutos passarem.', atWell, [wait], 10, 'Intervalo expresso em linguagem natural.'),
    refuse('Espero.', atHome, [wait], clarify('PILOT_WAIT_UNAVAILABLE', 'unspecified'), 'Espera sem duração.'),
    refuse('Espero duas horas.', atHome, [wait], blocked('PILOT_WAIT_UNAVAILABLE', { reason: 'limit' }), 'Acima de 60 minutos.'),
    refuse('Vou ao poço; espero dez minutos.', atHome, [travel(well), wait], blocked('PILOT_WAIT_SEQUENCE', { step: 2 }), 'Espera exige turno próprio.'),
    refuse('Vou ao poço; olho os arredores; volto para casa.', atHome,
      [travel(well), observe(well), travel(kitchen)], blocked('PILOT_SEQUENCE_LIMIT'), 'Três ações excedem o limite.'),
  ]),
  ...rows('holdout', [
    run('Tomo o rumo do bosque.', atWell, [travel(woods)], 5, 'Deslocamento afirmativo sem verbo padrão.'),
    run('Dou um pulo no quarto.', atHome, [travel(room)], 1, 'Ida breve em linguagem coloquial.'),
    run('Sigo ao poço.', inWoods, [travel(well)], 5, 'Percurso conhecido pelo verbo padrão.'),
    run('Escancaro o armário.', atHome, [open], 0, 'Sinônimo de abertura; estado inicial fechado.'),
    run('Converso com ela sobre a trilha.', where(well, ['Quero conversar com Lira.']), [speech(lira)], 0, 'O foco recente resolve o pronome.'),
    refuse('Quero conversar com alguém.', atHome, [step('speech')], clarify('PILOT_SPEECH_UNAVAILABLE'), 'Destinatário indeterminado.'),
    refuse('Abro o armário?', atHome, [open], clarify('PILOT_INTENT_CLARIFICATION'), 'Pergunta sobre ação com efeito; esclarecer confirmação.'),
    refuse('Pego o bloco?', atHome, [pickup], clarify('PILOT_INTENT_CLARIFICATION'), 'Pergunta de confirmação; ainda não há autorização.'),
    refuse('Vou ao poço?', atHome, [travel(well)], clarify('PILOT_INTENT_CLARIFICATION'), 'Pergunta interrogativa sem declaração inequívoca.'),
    refuse('Se encontrar Lira, falo com ela.', atWell, [speech(lira)], abstain, 'A fala está condicionada a um encontro.'),
    refuse('Não pego o bloco.', atHome, [pickup], abstain, 'Negativa sobre a transferência.'),
    refuse('Talvez eu abra o armário.', atHome, [open], abstain, 'Hipótese sobre abertura.'),
    refuse('Espero até as 10h20.', { ...atHome, clock: [10, 30] }, [wait], blocked('PILOT_WAIT_UNAVAILABLE', { reason: 'past' }), 'Horário acabado de passar.'),
    run('Espero até as 10h40.', { ...atHome, clock: [10, 30] }, [wait], 10, 'Horário futuro no mesmo dia.'),
    refuse('Espero dez minutos.', { ...atHome, clock: [23, 55] }, [wait], blocked('PILOT_WAIT_UNAVAILABLE', { reason: 'midnight' }), 'A espera atravessaria a meia-noite.'),
    refuse('Escancaro o armário.', where(kitchen, ['Abro o armário.']), [open], blocked('PILOT_OPEN_CLOSE_ALREADY_SET', { reason: 'aberto' }), 'Armário já aberto.'),
    run('Retiro o bloco do armário.', where(kitchen, ['Pego o bloco.', 'Abro o armário.', 'Guardo o bloco no armário.']),
      [step('retrieve', block, { containerId: cupboard })], 0, 'Recipiente aberto e item armazenado.'),
    refuse('Entrego o bloco para Henrique.', where(kitchen, ['Pego o bloco.']),
      [step('delivery', block, { recipientId: henrique })], blocked('PILOT_DELIVERY_RECIPIENT', { absentNpcName: 'Henrique' }), 'Henrique está na oficina.'),
    run('Entrego o bloco para Henrique.', where(kitchen, ['Pego o bloco.', 'Vou até a oficina.']),
      [step('delivery', block, { recipientId: henrique })], 0, 'Item em mãos e destinatário autorizado na oficina.'),
    refuse('Compro pão de Teresa.', atHome, [step('purchase', teresa)], unsupported, 'Comércio não implementado.'),
    refuse('Vou ao porto.', atHome, [travel('porto')], missing(travelError, 'unknown-destination'), 'Destino ausente da Vila.'),
  ]),
];
