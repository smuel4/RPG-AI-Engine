import type { CommandCase } from './pilotCommandCorpus';
import {
  familyYard as yard, freixoFamilyKitchen as kitchen, familyRoom as room,
  freixoWoodland as woods, freixoWoodWorkshop as shop, villageWell as well,
} from '../src/world/freixo';

export type BlindGroup = 'travel' | 'route-question' | 'hypothesis' | 'negative' |
  'ambiguous' | 'unknown-destination' | 'blocked-destination';

interface BlindCase extends CommandCase {
  group: BlindGroup;
  expectedProposal: 'travel' | 'clarify' | 'abstain';
}

type Entry = Omit<BlindCase, 'id' | 'split'>;
const travel = (text: string, location: string, target: string, minutes: number): Entry =>
  ({ text, scene: { location }, group: 'travel', expectedProposal: 'travel', expected: 'executar',
    steps: [{ kind: 'travel', target }], minutes, reason: 'Deslocamento afirmativo a um destino alcançável.' });
const question = (text: string, location: string, target: string, minutes: number): Entry =>
  ({ text, scene: { location }, group: 'route-question', expectedProposal: 'abstain', expected: 'consultar',
    steps: [{ kind: 'route-query', target }], answer: target + '. O percurso leva ' + minutes + ' min',
    minutes: 0, reason: 'Consulta factual de rota, sem ordem de partida.' });
const nonaffirmative = (group: 'hypothesis' | 'negative', text: string, location: string, target: string): Entry =>
  ({ text, scene: { location }, group, expectedProposal: 'abstain', expected: 'abster-se',
    steps: [{ kind: 'travel', target }], reason: 'A menção a um destino não autoriza uma partida.',
    refusal: { group: 'abstain', code: 'PILOT_ACTION_UNSUPPORTED' } });
const ambiguous = (text: string, location: string, first: string, second: string): Entry =>
  ({ text, scene: { location }, group: 'ambiguous', expectedProposal: 'clarify', expected: 'esclarecer',
    steps: [{ kind: 'travel', target: first }, { kind: 'travel', target: second }],
    reason: 'Duas alternativas explícitas e nenhuma escolha.',
    refusal: { group: 'clarify', code: 'PILOT_TRAVEL_UNAVAILABLE', reason: 'ambiguous-destination' } });
const unavailable = (text: string, location: string, target: string, blocked: boolean): Entry =>
  ({ text, scene: { location, ...(blocked ? { blockedDestination: target } : {}) },
    group: blocked ? 'blocked-destination' : 'unknown-destination', expectedProposal: 'abstain', expected: 'recusar',
    steps: [{ kind: 'travel', target }], reason: blocked ? 'A fixture fecha as rotas de entrada no destino.' : 'Destino ausente do mapa.',
    refusal: { group: blocked ? 'blocked' : 'missing', code: 'PILOT_TRAVEL_UNAVAILABLE',
      reason: blocked ? 'unknown-route' : 'unknown-destination' } });

// Frozen before collecting responses. The reserved partition is local-only.
const reserved = new Set([3, 6, 8, 12, 15, 19, 21, 24]);
export const blindCorpus: readonly BlindCase[] = [
  travel('Me mando pro quintal.', kitchen, yard, 2),
  question('É possível voltar para o quarto?', kitchen, room, 1),
  travel('Toco direto pro poço.', yard, well, 4),
  nonaffirmative('hypothesis', 'Talvez eu vá para a oficina mais tarde.', well, shop),
  travel('Pego o caminho de volta pra cozinha.', room, kitchen, 1),
  ambiguous('Vou até o quarto ou até o bosque.', kitchen, room, woods),
  travel('Parto daqui pra oficina.', well, shop, 8),
  unavailable('Vou até o farol.', kitchen, 'farol', false),
  travel('Bora pro bosque.', well, woods, 5),
  nonaffirmative('negative', 'Não vou voltar para o poço.', woods, well),
  travel('Pé na estrada até o quarto.', kitchen, room, 1),
  unavailable('Sigo para a oficina.', yard, shop, true),
  travel('Pego a trilha de volta pro poço.', woods, well, 5),
  question('Consigo voltar ao quintal por aqui?', shop, yard, 4),
  travel('Dou meia-volta rumo à cozinha.', yard, kitchen, 2),
  nonaffirmative('hypothesis', 'E se eu resolvesse ir até o bosque?', well, woods),
  travel('Caio na estrada em direção à oficina.', woods, shop, 13),
  ambiguous('Caminho para o quintal ou para a oficina.', kitchen, yard, shop),
  travel('Me ponho a caminho do quintal.', shop, yard, 4),
  unavailable('Caminho até o observatório.', well, 'observatório', false),
  travel('Sigo para a cozinha.', room, kitchen, 1),
  nonaffirmative('negative', 'Não quero atravessar até o bosque.', well, woods),
  travel('Caminho até o bosque.', room, woods, 12),
  unavailable('Vou até o quarto.', kitchen, room, true),
].map((entry, index) => ({ ...entry, id: 'b' + String(index + 1).padStart(2, '0'),
  split: reserved.has(index + 1) ? 'holdout' : 'development' }));
