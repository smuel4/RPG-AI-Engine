import { getNpcIdentity } from '../src/engine/npcIdentity';
import { routineScene, type NpcRoutineState } from '../src/engine/npcRoutine';
import { getActiveTimelineId } from '../src/engine/rulesEngine';
import type { TurnCatalog } from '../src/engine/turnPlanner';
import type { Campaign, NpcRecord } from '../src/types/game';

const key = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
  .replace(/\s+/gu, ' ').replace(/[.!?]+$/u, '');
const fact = (text: string) => text[0].toLowerCase() + text.slice(1);

export function answerPilotQuestion(statement: string, campaign: Campaign, recipient: NpcRecord,
  records: readonly NpcRecord[], state: NpcRoutineState | undefined, catalog: TurnCatalog,
  portable: readonly { id: string; npcId?: string }[]) {
  if (recipient.location !== campaign.currentLocation) return;
  const identity = getNpcIdentity(campaign, recipient);
  if (!identity) return;
  const question = key(statement);
  const reply = (text: string) => recipient.name + ': “' + text + '”';
  const unknown = () => reply('Não sei te dizer com certeza.');
  const memories = state?.memories?.filter(({ npcId, timelineId, sequence }) => npcId === recipient.id &&
    timelineId === getActiveTimelineId(campaign) && sequence <= campaign.lastSequence) ?? [];
  if (/^(?:lembra (?:do|de receber o) bloco(?: de madeira)? que (?:eu )?te entreguei|o que (?:eu )?te entreguei)$/u.test(question)) {
    const block = catalog.objects?.find(({ id }) => id === 'demo-bloco-madeira');
    if (!block) return unknown();
    const delivered = memories.some(({ origin }) => origin.kind === 'participated' &&
      origin.event === 'delivery' && origin.subjectId === block.id);
    const legacyDelivery = portable.some(({ id, npcId }) => id === block.id && npcId === recipient.id);
    return delivered || legacyDelivery ? reply('Você me entregou o ' + block.name + '.') : unknown();
  }
  if (/^lembra que (?:eu )?organizei a bancada(?: da cozinha)?$/u.test(question)) {
    const bench = catalog.objects?.find(({ id }) => id === 'demo-bancada-cozinha');
    if (!bench) return unknown();
    if (memories.some(({ origin }) => origin.kind === 'participated' &&
      origin.event === 'organization' && origin.subjectId === bench.id)) return reply('Organizamos a bancada juntos.');
    if (memories.some(({ origin }) => origin.kind === 'observed' &&
      origin.event === 'organization' && origin.subjectId === bench.id)) return reply('Vi você organizar a bancada.');
    if (memories.some(({ origin, fact }) => origin.kind === 'reported' && origin.reporterId === 'player' &&
      /^(?:eu )?organizei a bancada(?: da cozinha)?$/u.test(key(fact)))) {
      return reply('Você me contou que organizou a bancada.');
    }
    return unknown();
  }
  if (/^(?:quem (?:e voce|voce e)|qual (?:e )?(?:o )?seu nome)$/u.test(question)) {
    return reply('Sou ' + recipient.name + '.');
  }
  if (/^(?:qual (?:e )?(?:o )?seu oficio|(?:com que|em que) voce trabalha)$/u.test(question)) {
    return reply(identity.occupation.startsWith('Cuida ')
      ? identity.occupation.replace(/^Cuida /, 'Cuido ') : 'Trabalho como ' + fact(identity.occupation));
  }
  const currentQuestion = /^(?:no que|em que|com que|o que) (?:voce |ele |ela )?esta (trabalhando|fazendo)(?: agora)?$/u.exec(question);
  const stillWorking = /^(?:se )?(?:voce |ele |ela )?ainda esta trabalhando$/u.test(question);
  const activityDialogue = (activity: string, location: string) =>
    [identity.routine, identity.nextRoutine].find((stage) =>
      stage?.activity === activity && stage.location === location)?.dialogue;
  if (currentQuestion || stillWorking) {
    const current = state && routineScene(campaign, [recipient], state).activities[0];
    const asksAboutWork = stillWorking || currentQuestion?.[1] === 'trabalhando';
    if (!current) {
      const wasWorking = state?.activities.some(({ npcId, activity, location }) =>
        npcId === recipient.id && activityDialogue(activity, location)?.kind === 'work');
      return asksAboutWork && wasWorking ? reply('Já não estou nessa atividade.') : unknown();
    }
    const description = activityDialogue(current.activity, recipient.location);
    if (!asksAboutWork) return reply(description?.present ?? 'Minha atividade agora é ' + fact(current.activity));
    if (!description) return unknown();
    if (description.kind === 'work') return reply((stillWorking ? 'Sim. ' : '') + description.present);
    return reply((stillWorking ? 'Não. ' : 'Agora não estou trabalhando. ') + description.present);
  }
  if (/^o que (?:voce |ele |ela )?(?:estava fazendo|fez) antes$/u.test(question)) {
    const current = state && routineScene(campaign, [recipient], state).activities[0];
    const prior = state?.activities.filter(({ npcId, activity }) =>
      npcId === recipient.id && activity !== current?.activity).at(-1);
    if (!prior) return unknown();
    const description = activityDialogue(prior.activity, prior.location);
    return reply(description?.past ?? 'Minha atividade anterior era ' + fact(prior.activity));
  }
  if (/^(?:como esta |se esta organizada )a bancada(?: da cozinha)?$|^a bancada(?: da cozinha)? (?:esta organizada|como esta)$/u.test(question)) {
    const benches = (catalog.objects ?? []).filter(({ location, condition, name }) =>
      location === recipient.location && condition?.organize && condition.knownBy?.includes(identity.key) &&
      key(name) === 'bancada');
    if (benches.length > 1) return reply('De qual bancada você está falando?');
    if (!benches.length) return unknown();
    const condition = benches[0].condition!;
    return reply(state?.completedActivities?.includes(condition.activityId)
      ? condition.organize!.completed : condition.initial);
  }
  const witness = /^(?:se )?(?:voce |ele |ela )?viu ([\p{L} -]+) sair$/u.exec(question);
  if (witness) {
    const subjects = records.filter(({ name }) => key(name) === witness[1]);
    if (subjects.length !== 1) return unknown();
    const subject = subjects[0];
    const logged = memories.some(({ origin, fact }) =>
      origin.kind === 'observed' && origin.subjectId === subject.id && fact === 'Viu ' + subject.name + ' sair.');
    return logged ? reply('Vi ' + subject.name + ' sair.') : unknown();
  }
  if (records.some(({ name }) => question === 'onde esta ' + key(name) || question === 'onde ' + key(name) + ' esta')) {
    return unknown();
  }
}
