import { type Firestore, FieldValue } from 'firebase-admin/firestore';
import { isDeepStrictEqual } from 'node:util';
import { advanceWorldTime, getActiveTimelineId, processPlayerAction } from '../src/engine/rulesEngine';
import { advanceNpcRoutines, isNpcOccupied, routineScene, type NpcRoutineState } from '../src/engine/npcRoutine';
import { MAX_NPC_MEMORY_LENGTH, recordNpcMemories } from '../src/engine/npcMemory';
import { PLAYER_CHARACTER_ID, recordFirstEncounters, recordPersonalDisclosure, relationshipsInScene } from '../src/engine/npcRelationship';
import { checkTurnRevision, isTurnId, readCommittedTurn, turnDocumentIds, type TurnIdentity } from '../src/engine/turnIdentity';
import { planTurn, resolvePlannedOutcome, type TurnCatalog } from '../src/engine/turnPlanner';
import type { Campaign, GameEvent, NarrativeEntry, NpcRecord } from '../src/types/game';
import { validateNarration } from './narratorProvider';

export const SERVER_PILOT_ID = 'echo-arc-server-pilot';
const speechIntent = /^(?:eu\s+)?(?:digo|falo|conto|confidencio)\b/iu;
const directedSpeech = /^(?:eu\s+)?(digo|falo|conto|confidencio)\s+(?:a|ao|à|para)\s+([\p{L}\p{M}\p{Zs}'’-]+)\s*[:：]\s*([\s\S]+)$/iu;
const travelIntent = /^(?:eu\s+)?(?:vou|caminho|sigo)\b/iu;
const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const dialogueSyntax = (text: string) => text.normalize('NFKC')
  .replace(/[\u200B\uFEFF]/gu, '').replace(/\s+/gu, ' ').trim();

function naturalSpeech(action: string, here: readonly NpcRecord[], records: readonly NpcRecord[],
  history: readonly NarrativeEntry[]) {
  const inquiry = /^(?:eu\s+)?(?:quero|gostaria de|vou)\s+(?:conversar|falar)\s+com\s+(.+?)[.!?]?$/iu.exec(action);
  const indirectGreeting = /^(?:eu\s+)?(?:cumprimento\s+|dou\s+(?:bom dia|boa tarde|boa noite)\s+(?:a|ao|à|para)\s+)([^,.!?]+)[.!?]*$/iu.exec(action);
  const indirectQuestion = /^(?:eu\s+)?(?:pergunto|(?:quero|queria|gostaria de) saber)(?:\s+(?:a|ao|à|para)\s+(.+?))?\s+((?:como|se|onde|quando|por que|qual|quanto|o que)\b.+)$/iu.exec(action);
  const report = /^(?:eu\s+)?(digo|falo|conto|confidencio)\s+(?:a|ao|à|para)\s+(.+?)\s+que\s+(.+)$/iu.exec(action);
  const greeting = /^(bom dia|boa tarde|boa noite|oi|ol[aá]|tchau|at[ée] logo|at[ée] mais)(?:(?:\s*[,–—]\s*|\s+)([^,.!?]+))?[.!?…]*$/iu.exec(action);
  const vocative = /^([\p{L}\p{M}\p{Zs}'’-]+?)\s*,\s*(.+)$/iu.exec(action);
  const directQuestion = action.endsWith('?') && !travelIntent.test(action);
  const recognized = Boolean(inquiry || indirectGreeting || indirectQuestion || greeting || report);
  const question = indirectQuestion?.[2];
  const pronoun = question && /\b(ela|ele|dela|dele)\b/u.exec(normalize(question))?.[1];
  const mentioned = question && records.filter(({ name }) =>
    (' ' + normalize(question).replace(/[^\p{L}]+/gu, ' ') + ' ').includes(' ' + normalize(name) + ' '));
  if (indirectQuestion && !indirectQuestion[1] && mentioned && mentioned.length > 1) {
    throw new PilotTurnError('PILOT_SPEECH_UNAVAILABLE');
  }
  const address = inquiry?.[1] ?? indirectGreeting?.[1] ?? indirectQuestion?.[1] ??
    report?.[2] ?? greeting?.[2] ?? (recognized
      ? (mentioned || [])[0]?.name ?? pronoun?.replace(/^d/, '') : vocative?.[1]) ?? '';
  if (!recognized && !vocative && !directQuestion) return null;
  const reference = normalize(address.trim());
  const matches = ({ name, role }: NpcRecord) => [normalize(name), normalize(role),
    normalize(role).replace(/\s+adotiv[oa]$/, '')].includes(reference);
  const feminine = /^(?:ela|(?:essa|aquela) (?:garota|moca|mulher))$/u.test(reference);
  const masculine = /^(?:ele|(?:esse|aquele) (?:rapaz|moco|homem))$/u.test(reference);
  const deictic = !reference || feminine || masculine || /^(?:esse|essa|aquele|aquela) (?:npc|pessoa)$/u.test(reference);
  if (!recognized && !deictic && !records.some(matches)) return null;
  const eligible = deictic ? here.filter(({ role }) => {
    const label = normalize(role);
    if (feminine) return /^(?:mae|filha|irma|tia|avo feminina|moradora|garota|moca|mulher|artesa|professora)\b/u.test(label);
    if (masculine) return /^(?:pai|filho|irmao|tio|morador|rapaz|moco|homem|artesao|professor)\b/u.test(label);
    return true;
  }) : here.filter(matches);
  const previous = history.filter((item) => item.authorRole === 'player_action' && item.privateRecipientId)
    .sort((a, b) => b.sequence - a.sequence)[0]?.privateRecipientId;
  const candidates = deictic && eligible.length > 1 ? eligible.filter(({ id }) => id === previous) : eligible;
  if (candidates.length !== 1) throw new PilotTurnError('PILOT_SPEECH_UNAVAILABLE');
  return { recipient: candidates[0], indirect: Boolean(indirectGreeting || indirectQuestion || report),
    verb: report?.[1] ?? 'digo',
    statement: inquiry ? null : report?.[3] ?? question ?? (recognized || !vocative ? action : vocative[2].trim()) };
}

function removeRouteMenu(text: string, destinations: readonly { id: string }[]) {
  const lines = text.split(/\r?\n/);
  const heading = lines.findIndex((line) =>
    /^\s*(?:\*\*)?destinos disponiveis(?: agora)?\s*:\s*(?:\*\*)?\s*$/.test(normalize(line)));
  if (heading < 0) return text;
  const items = lines.slice(heading + 1).filter((line) => line.trim());
  if (!heading || !items.length || items.some((line) => {
    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    return !bullet || !destinations.some(({ id }) => normalize(id) === normalize(bullet[1]));
  })) throw new PilotTurnError('PILOT_NARRATION_CONFLICT', 'invalid-route-menu');
  return lines.slice(0, heading).join('\n').trim();
}

function arrivalProse(text: string, location: string, catalog: TurnCatalog) {
  const arrival = /^Samuel cheg(?:a|ou) (?:a|ao|à|até (?:o |a )?)([^.!?\n]+)(?:[.!?]|$)/iu.exec(text);
  const place = catalog.places.find(({ id }) => id === location);
  const name = (value: string) => normalize(value.trim()).replace(/^(?:o|a) +/, '');
  const prose = arrival && [location, ...(place?.aliases ?? [])].some((alias) => name(alias) === name(arrival[1]))
    ? text.slice(arrival[0].length).trim()
    : text;
  const checked = normalize(prose).replace(/\b(?:ao redor de|perto de|diante de|ao lado de) (?:samuel|voce|do protagonista)\b/g, '');
  if (/^\s*[-—–]|["“”]/mu.test(checked)) throw new PilotTurnError('PILOT_NARRATION_CONFLICT', 'arrival-dialogue');
  if (/\b(?:passam|passaram|decorrem|decorreram|depois de|apos)\b[^.!?\n]{0,40}\b(?:minutos?|horas?)\b/u.test(checked)) {
    throw new PilotTurnError('PILOT_NARRATION_CONFLICT', 'arrival-time-advance');
  }
  if (/\b(?:samuel|voce|protagonista|cheg\p{L}*|partiu|retorn\p{L}*|volt\p{L}*|imped\p{L}*|bloque\p{L}*)\b|(?:^|[.!?]\s+)(?:abandona|sai|vai|segue|caminha|entra|dirige-se)\b/mu.test(checked)) {
    throw new PilotTurnError('PILOT_NARRATION_CONFLICT', 'arrival-agency-or-movement');
  }
  return prose;
}

function validateObservationProse(text: string) {
  const checked = normalize(text);
  const conflict = (reason: string) => {
    throw new PilotTurnError('PILOT_NARRATION_CONFLICT', reason);
  };
  if (/\b(?:passam|passaram|decorrem|decorreram|depois de|apos)\b[^.!?\n]{0,40}\b(?:minutos?|horas?)\b|\b(?:relogio|hora|tempo)\s+(?:avanca|avancou|passa|passou|marca agora)\b|\b(?:minutos?|horas?)\s+(?:depois|mais tarde|se passam|passam|passaram)\b/u.test(checked)) {
    conflict('observation-time-advance');
  }
  // Match actions attributed to the player, not mentions of the player or verbs attached to NPCs.
  const actor = String.raw`(?:\b(?:samuel|voce|o protagonista)\s+(?:(?:entao|ja|logo|tambem)\s+)?(?:(?:olha|observa|nota|ve)\b[^.!?;\n,]{0,80}\s+e\s+)?|(?:^|[.!?;\n])\s*(?:ele\s+)?)`;
  const action = String.raw`(?:chega|chegou|vai|foi|sai|saiu|entra|entrou|atravessa|atravessou|abandona|abandonou|dirige-se|se dirige|retorna|retornou|volta|voltou|caminha|caminhou|decide|decidiu|escolhe|escolheu|promete|prometeu|aceita|aceitou|recusa|recusou|pega|pegou|recebe|recebeu|ganha|ganhou|adquire|adquiriu|entrega|entregou|guarda|guardou|diz|disse|responde|respondeu)`;
  if (new RegExp(actor + action + String.raw`\b`, 'u').test(checked)) {
    conflict('observation-agency-or-movement');
  }
  return text;
}

function visibleHistory(entries: NarrativeEntry[], present: readonly NpcRecord[]) {
  const bySequence = new Map(entries.map((entry) => [entry.sequence, entry]));
  return entries.filter((entry) => {
    const player = entry.authorRole === 'engine_response' ? bySequence.get(entry.sequence - 1) : entry;
    if (!player || (entry.authorRole === 'engine_response' && (player.authorRole !== 'player_action' ||
        entry.timelineId !== player.timelineId))) return false;
    const recipient = player.privateRecipientId;
    if (recipient) return present.length === 1 && present[0].id === recipient;
    // Older conversation records lack a trusted recipient identifier.
    return player.authorRole !== 'player_action' || !speechIntent.test(player.content.trim());
  });
}

export class PilotTurnError extends Error {
  constructor(readonly code: string, readonly reason?: string, readonly step?: number) { super(code); }
}

function splitPilotActions(action: string): string[] {
  const steps: string[] = [];
  let remaining = action;
  while (true) {
    // Preserve the literal contents of a colon-delimited utterance.
    const separator = directedSpeech.test(dialogueSyntax(remaining)) ? null
      : /\s*;\s*|\s*,?\s+\b(?:e\s+depois|depois|em seguida)\s+|\s+e\s+(?=(?:eu\s+)?(?:vou|caminho|sigo|olho|observo|examino|inspeciono|ajudo|quero|pergunto|digo|falo|conto|confidencio|cumprimento|se)\b)/iu.exec(remaining);
    if (!separator) return [...steps, remaining.trim()];
    steps.push(remaining.slice(0, separator.index).trim().replace(/,$/u, ''));
    if (steps.length === 2) throw new PilotTurnError('PILOT_SEQUENCE_LIMIT', undefined, 3);
    remaining = remaining.slice(separator.index + separator[0].length);
  }
}

export async function persistPilotTurn(db: Firestore, catalog: TurnCatalog, ownerId: string,
  turn: TurnIdentity, narrate: (campaign: Campaign, sceneIntent: string, npcs: ReturnType<typeof routineScene>,
    relationships: ReturnType<typeof relationshipsInScene>, narrative: NarrativeEntry[], declaredAction: string) => Promise<string>) {
  if (!ownerId || turn.campaignId !== SERVER_PILOT_ID || !isTurnId(turn.turnId)) {
    throw new PilotTurnError('CAMPAIGN_ACCESS_DENIED');
  }
  const campaignRef = db.collection('campaigns').doc(turn.campaignId);
  const ids = await turnDocumentIds(turn);
  const eventRef = campaignRef.collection('events').doc(ids.event);
  const playerRef = campaignRef.collection('narrative').doc(ids.player);
  const engineRef = campaignRef.collection('narrative').doc(ids.engine);
  const receiptRef = campaignRef.collection('turnReceipts').doc(turn.turnId);
  const npcCollection = campaignRef.collection('npcs');
  async function read(tx: FirebaseFirestore.Transaction, withHistory = false) {
    const [campaignDoc, event, player, engine, receipt] = await tx.getAll(campaignRef, eventRef, playerRef, engineRef, receiptRef);
    const campaign = campaignDoc.data() as Campaign | undefined;
    if (!campaign || campaign.ownerId !== ownerId || campaign.id !== turn.campaignId) {
      throw new PilotTurnError('CAMPAIGN_ACCESS_DENIED');
    }
    if (getActiveTimelineId(campaign) !== turn.baseTimelineId) {
      throw new PilotTurnError('CONCURRENT_STATE_CONFLICT');
    }
    if (event.exists || player.exists || engine.exists || receipt.exists) {
      const entry = event.exists && receipt.data()?.playerEntryId === ids.player
        ? readCommittedTurn(turn, ownerId, event.data() as GameEvent,
          player.data() as NarrativeEntry | undefined, engine.data() as NarrativeEntry | undefined) : null;
      if (!entry) throw new PilotTurnError('TURN_ID_CONFLICT');
      return { campaign, entry };
    }
    if (!checkTurnRevision(turn, campaign) || campaign.status !== 'active') {
      throw new PilotTurnError('CONCURRENT_STATE_CONFLICT');
    }
    const routineRef = campaignRef.collection('npcRoutineState').doc(getActiveTimelineId(campaign));
    const runtime = (await tx.get(routineRef)).data() as NpcRoutineState | undefined;
    const snapshot = await tx.get(npcCollection.where('ownerId', '==', ownerId).limit(31));
    const records = snapshot.docs.map((doc) => doc.data() as NpcRecord)
      .filter((npc, index) => npc.id === snapshot.docs[index].id && npc.campaignId === campaign.id && npc.ownerId === ownerId);
    const history = withHistory ? await tx.get(campaignRef.collection('narrative')
      .orderBy('sequence', 'desc').limit(24)) : undefined;
    const narrative = (history?.docs ?? []).map((doc) => doc.data() as NarrativeEntry)
      .filter((item) => item.campaignId === campaign.id && item.ownerId === ownerId &&
        item.timelineId === turn.baseTimelineId && item.sequence <= campaign.lastSequence);
    return { campaign, entry: null, routineRef, runtime, records, complete: snapshot.size <= 30, narrative };
  }
  const { campaign, entry, runtime, records = [], complete, narrative = [] } =
    await db.runTransaction((tx) => read(tx, true));
  if (entry) return { mode: 'replay' as const, narration: entry.content, expectedLastSequence: entry.sequence - 2 };

  const action = turn.declaredAction.trim();
  const actions = splitPilotActions(action);
  const turnSequence = campaign.lastSequence + 3;
  const projectStep = (action: string, campaign: Campaign, records: NpcRecord[], runtime: NpcRoutineState | undefined) => {
    const syntax = dialogueSyntax(action).replace(/^(?:"(.+)"|“(.+)”)$/u, '$1$2').trim();
    const observation = /^(?:eu\s+)?(?:(?:quero|vou)\s+(?:observar|examinar|olhar|inspecionar)|observo|examino|olho|inspeciono)\s+(?:mais\s+de\s+perto\s+)?(.+?)[.!]?$/iu.exec(syntax);
    const help = /^(?:eu\s+)?(?:ajudo|(?:quero|vou|tento)\s+ajudar)\s+(.+?)\s+a\s+(\p{L}+)\s+(.+?)[.!]?$/iu.exec(syntax);
    const explicitSpeech = directedSpeech.exec(action) ?? directedSpeech.exec(syntax);
    const here = records.filter((npc) => npc.location === campaign.currentLocation);
    const natural = explicitSpeech || observation || help ? null : naturalSpeech(syntax, here, records, narrative);
    if (!explicitSpeech && !natural && speechIntent.test(syntax)) throw new PilotTurnError('PILOT_SPEECH_UNAVAILABLE');
    const speech = Boolean(explicitSpeech || natural);
    if (!speech && !observation && !help && (!travelIntent.test(action) ||
        /^(?:eu\s+)?vou\s+(?:observar|olhar|examinar|inspecionar|ajudar|mexer|pegar|interagir)\b/iu.test(action))) {
      throw new PilotTurnError('PILOT_ACTION_UNSUPPORTED');
    }
    const travelAction = action.replace(/^(?:eu\s+)?vou\s+dar\s+uma\s+volta\s+(?=at[eé]\s|ao\s|à\s|para\s)/iu, 'Vou ');
    const targetKey = (value: string) => normalize(value).replace(/^(?:o|a|os|as)\s+/u, '').trim();
    const selectOutcome = () => {
      if (speech) {
        const [, verb, name, content] = explicitSpeech ?? ['', natural!.verb, natural!.recipient.name, natural!.statement ?? ''];
        const recipients = here.filter((npc) =>
          npc.name.toLocaleLowerCase('pt-BR') === name.trim().toLocaleLowerCase('pt-BR'));
        const statement = content.trim();
        const personal = verb.toLowerCase() === 'confidencio' &&
          !/^(?:olá|oi|bom dia|boa tarde|boa noite|tudo bem|obrigad[oa]|até logo)[\s.!?,]*$/iu.test(statement);
        const remember = personal || verb.toLowerCase() === 'conto';
        if (!complete || recipients.length !== 1 || (!statement && !natural) || (remember && statement.length > MAX_NPC_MEMORY_LENGTH)) {
          throw new PilotTurnError('PILOT_SPEECH_UNAVAILABLE');
        }
        return {
          plan: { kind: 'speech' as const, recipientId: recipients[0].id, statement, remember, personal },
          resolution: { completed: true, elapsedMinutes: 0 },
          outcome: { location: campaign.currentLocation, elapsedMinutes: 0 },
        };
      }
      if (observation) {
        const current = catalog.places.find(({ id }) => id === campaign.currentLocation);
        const focusKey = targetKey(observation[1]);
        const npcKey = /^que (.+?) (?:esta fazendo|faz)$/u.exec(focusKey)?.[1];
        const matches = here.filter(({ name }) => targetKey(name) === (npcKey ?? focusKey));
        const surroundings = /^(?:ao (?:meu )?redor|em volta|ambiente|local)$/u.test(focusKey);
        const local = current && [current.id, ...current.aliases].some((name) => targetKey(name) === focusKey);
        const visibleNpc = complete && matches.length === 1;
        const objectKey = focusKey.replace(/^(?:est[ea]s?|ess[ea]s?|aquel[ea]s?)\s+/u, '');
        const objects = (catalog.objects ?? []).filter(({ name, aliases }) =>
          [name, ...aliases].some((alias) => targetKey(alias) === objectKey));
        const nearbyObjects = objects.filter(({ location }) => location === campaign.currentLocation);
        if (!surroundings && !local && !visibleNpc && !npcKey && catalog.objects) {
          if (nearbyObjects.length > 1 || /^(?:objeto|coisa)$/u.test(objectKey)) {
            throw new PilotTurnError('PILOT_OBJECT_AMBIGUOUS');
          }
          if (!nearbyObjects.length) throw new PilotTurnError(objects.length
            ? 'PILOT_OBJECT_OUT_OF_REACH' : 'PILOT_OBJECT_UNREGISTERED');
        }
        const object = !surroundings && !local && !visibleNpc && !npcKey ? nearbyObjects[0] : undefined;
        const condition = object?.condition;
        const objectFact = object && [object.description, condition &&
          (runtime?.completedActivities?.includes(condition.activityId)
            ? catalog.activities?.find(({ id }) => id === condition.activityId)?.result
            : condition.initial)].filter(Boolean).join(' ');
        if (!current || (!surroundings && !local && !visibleNpc && !object)) {
          throw new PilotTurnError('PILOT_OBSERVATION_UNAVAILABLE');
        }
        return {
          plan: { kind: 'observation' as const, focus: object?.name ?? (surroundings || local ? current.id : matches[0].name),
            ...(objectFact === undefined ? {} : { objectFact }) },
          resolution: { completed: true, elapsedMinutes: 0 },
          outcome: { location: campaign.currentLocation, elapsedMinutes: 0 },
        };
      }
      if (help) {
        const [, participant, verb, target] = help;
        const available = (catalog.activities ?? []).filter((activity) =>
          activity.location === campaign.currentLocation && !activity.blocked &&
          targetKey(activity.participant) === targetKey(participant) &&
          targetKey(activity.verb) === targetKey(verb) && targetKey(activity.target) === targetKey(target) &&
          Number.isSafeInteger(activity.minutes) && activity.minutes > 0 && activity.minutes <= 720 &&
          !(runtime?.completedActivities ?? []).includes(activity.id));
        const helpers = here.filter(({ name }) => targetKey(name) === targetKey(participant));
        if (!complete || available.length !== 1 || helpers.length !== 1 ||
            isNpcOccupied(runtime, helpers[0].id, campaign.worldTime)) {
          throw new PilotTurnError('PILOT_ACTIVITY_UNAVAILABLE');
        }
        const activity = available[0];
        return {
          plan: { kind: 'activity' as const, activityId: activity.id, participantId: helpers[0].id,
            participant: helpers[0].name, result: activity.result },
          resolution: { completed: true, elapsedMinutes: activity.minutes },
          outcome: { location: campaign.currentLocation, elapsedMinutes: activity.minutes },
        };
      }
      if (!/^(?:eu\s+)?(?:vou|caminho|sigo)\s+(?:até|ate|ao|à|para)\s+[\p{L}\p{M}\s-]+[.!]?$/iu.test(travelAction) ||
          /\b(?:e|depois|mas)\b/iu.test(travelAction)) throw new PilotTurnError('PILOT_TRAVEL_UNAVAILABLE');
      const plan = planTurn(travelAction, campaign, catalog);
      if (plan.status !== 'planned' || plan.intent.kind !== 'travel' || plan.expectedMinutes === null ||
          plan.origin === plan.destination) throw new PilotTurnError('PILOT_TRAVEL_UNAVAILABLE');
      const resolution = { completed: true, elapsedMinutes: plan.expectedMinutes };
      const outcome = resolvePlannedOutcome(plan, resolution);
      if (!outcome) throw new PilotTurnError('PILOT_TRAVEL_UNAVAILABLE');
      return { plan, resolution, outcome };
    };
    const { plan, resolution, outcome } = selectOutcome();
    const activity = 'kind' in plan && plan.kind === 'activity' ? plan : null;
    const observationPlan = 'kind' in plan && plan.kind === 'observation' ? plan : null;
    const arrival = { ...campaign, currentLocation: outcome.location,
      worldTime: advanceWorldTime(campaign.worldTime, outcome.elapsedMinutes) };
    const eventSequence = turnSequence;
    const simulation = advanceNpcRoutines(campaign, arrival.worldTime, complete ? records : [], catalog, runtime,
      { turnId: turn.turnId, sequence: eventSequence });
    if (activity && simulation.moves.some(({ npcId }) => npcId === activity.participantId)) {
      throw new PilotTurnError('PILOT_ACTIVITY_UNAVAILABLE');
    }
    const origin = { turnId: turn.turnId, timelineId: turn.baseTimelineId, sequence: eventSequence };
    const speechState = 'kind' in plan && plan.kind === 'speech' && plan.remember ? {
      ...simulation.state,
      ...(plan.personal ? { relationships: recordPersonalDisclosure(simulation.state.relationships ?? [],
        records.find(({ id }) => id === plan.recipientId)!, PLAYER_CHARACTER_ID, origin) } : {}),
      memories: recordNpcMemories(simulation.state.memories ?? [], [{
        npcId: plan.recipientId, ...origin,
        occurredAt: campaign.worldTime, fact: plan.statement,
        origin: { kind: 'reported', reporterId: 'player', speakerName: campaign.protagonist.name },
      }]),
    } : simulation.state;
    const nextRecords = records.map((npc) => {
      const move = simulation.moves.find(({ npcId }) => npcId === npc.id);
      return move ? { ...npc, location: move.to } : npc;
    });
    const present = routineScene(arrival, nextRecords, simulation.state, eventSequence);
    const relationships = speechState.relationships ?? [];
    const encounters = !('kind' in plan) && complete ? recordFirstEncounters(relationships, present.npcs, origin) : relationships;
    const state = activity ? { ...speechState,
      completedActivities: [...(speechState.completedActivities ?? []), activity.activityId] }
      : encounters === relationships ? speechState : { ...speechState, relationships: encounters };
    const visibleNewcomers = encounters.filter((relation) => relation.firstEncounter?.turnId === turn.turnId && !relationships.includes(relation))
      .map((relation) => present.npcs.find((npc) => npc.id === relation.from)!.name);
    const destinations = catalog.routes.filter((route) => route.from === arrival.currentLocation && !route.blocked)
      .map((route) => catalog.places.find((place) => place.id === route.to))
      .filter((place) => place !== undefined).map(({ id, aliases }) => ({ id, aliases }));
    return { plan, outcome, activity, observationPlan, arrival, state, nextRecords,
      speech, explicitSpeech, natural, present, visibleNewcomers, destinations };
  };

  const steps: ReturnType<typeof projectStep>[] = [];
  for (const [index, declared] of actions.entries()) {
    const previous = steps.at(-1);
    try {
      if (actions.length > 1 && /^(?:se|caso)\b/iu.test(declared)) throw new PilotTurnError('PILOT_SEQUENCE_NEEDS_REPLY');
      const step = projectStep(declared, previous?.arrival ?? campaign, previous?.nextRecords ?? records,
        previous?.state ?? runtime);
      if (step.speech && index < actions.length - 1) throw new PilotTurnError('PILOT_SEQUENCE_NEEDS_REPLY');
      steps.push(step);
    } catch (error) {
      if (actions.length > 1 && error instanceof PilotTurnError) {
        throw new PilotTurnError(error.code, error.reason, index + 1);
      }
      throw error;
    }
  }
  const last = steps.at(-1)!;
  const elapsedMinutes = steps.reduce((total, step) => total + step.outcome.elapsedMinutes, 0);
  if (elapsedMinutes > 720) throw new PilotTurnError('PILOT_ACTION_INVALID', undefined, 2);
  const outcome = { location: last.outcome.location, elapsedMinutes };
  const plan = steps.length === 1 ? last.plan : { kind: 'sequence' as const, steps: steps.map(({ plan }) => plan) };
  const resolution = { completed: true, elapsedMinutes };
  const narrateStep = async (step: typeof last, declared: string) => {
    const { outcome, activity, observationPlan, arrival, state, speech, explicitSpeech, natural, present,
      visibleNewcomers, destinations } = step;
    const destinationContext = ` Contexto operacional de rotas: ${JSON.stringify(destinations)}. Escreva somente prosa narrativa, sem menus, listas ou cabeçalhos técnicos. Locais podem ser citados naturalmente. Só indique como caminho confirmado uma rota deste contexto; lugares fora dele podem aparecer como referências ainda não verificadas.`;
    const scene = await narrate(arrival,
      (speech ? `Mostre a reação de ${explicitSpeech?.[2].trim() ?? natural?.recipient.name} em até quatro frases. ${natural?.statement === null ? 'Abra espaço para conversar; Samuel ainda não disse nada.' : 'Reaja à fala declarada; só o destinatário ouviu a informação. Trate-a como relato, sem confirmar fatos, compromissos ou objetivos.'} ${natural?.indirect ? 'O jogador declarou a interação em discurso indireto; não invente uma fala literal de Samuel.' : ''} Mantenha a posição e os objetos da última cena ou mostre como mudaram. Não repita propostas sem motivo nem atribua novas falas ou ações a Samuel.`
        : observationPlan ? `Descreva somente o que pode ser percebido de ${observationPlan.focus} neste local. Use detalhes sensoriais passageiros; não revele informações privadas, invente ações, posse ou mudanças permanentes. Nenhum tempo relevante se passou.`
          : activity ? `A tentativa de ajudar ${activity.participant} foi concluída em ${outcome.elapsedMinutes} minutos. Resultado confirmado: ${activity.result} Descreva apenas um detalhe visível desse resultado, sem criar recompensas, mudanças de relacionamento, falas ou ações novas.`
            : `Descreva o que é visível em ${outcome.location}, em até três frases. Samuel já chegou após ${outcome.elapsedMinutes} minutos. Pode mostrar atividades locais observáveis. Use apenas traços físicos já estabelecidos para personagens nomeados. Não atribua falas ou ações a Samuel e não narre deslocamentos adicionais.`)
        + (observationPlan?.objectFact ? ' O motor já apresenta estes fatos ao jogador: ' + observationPlan.objectFact +
          ' Complemente sem repetir ou contradizer esses fatos e sem atribuir novas propriedades ao objeto.' : '')
        + destinationContext,
      observationPlan || activity ? { ...present, knowledge: [], memories: [] } : present,
      observationPlan || activity ? [] : relationshipsInScene(present.npcs, turn.baseTimelineId, state.relationships ?? []),
      visibleHistory(narrative, observationPlan || activity ? [] : present.npcs), declared);
    const description = removeRouteMenu(validateNarration(scene, 'groq'), destinations);
    const prose = speech ? description
      : observationPlan ? validateObservationProse(description)
      : arrivalProse(description, outcome.location, catalog);
    const words = (text: string) => (normalize(text).match(/\p{L}+/gu) ?? []).join(' ');
    const sceneWords = ' ' + words(prose) + ' ';
    const encounterCue = visibleNewcomers.filter((name) => !sceneWords.includes(' ' + words(name) + ' '))
      .map((name) => `Ali perto está ${name}.`).join(' ');
    return validateNarration([activity?.result, observationPlan?.objectFact, prose, encounterCue].filter(Boolean).join(' ') ||
      `A caminhada termina em ${outcome.location}.`, 'groq');
  };
  const descriptions: string[] = [];
  for (const [index, step] of steps.entries()) {
    try {
      descriptions.push(await narrateStep(step, actions[index]));
    } catch (error) {
      if (steps.length > 1 && error instanceof PilotTurnError) {
        throw new PilotTurnError(error.code, error.reason, index + 1);
      }
      throw error;
    }
  }
  const narration = validateNarration(descriptions.join('\n\n'), 'groq');
  const { state } = last;
  const result = processPlayerAction(campaign, [], [], action, outcome.elapsedMinutes, narration);
  if (!result.ok) throw new PilotTurnError('PILOT_ACTION_INVALID');
  const { data } = result;
  return db.runTransaction(async (tx) => {
    const current = await read(tx);
    if (current.entry) return { mode: 'replay' as const, narration: current.entry.content, expectedLastSequence: current.entry.sequence - 2 };
    if (current.campaign.currentLocation !== campaign.currentLocation || current.campaign.lastSequence !== campaign.lastSequence ||
        !isDeepStrictEqual(current.records, records) || !isDeepStrictEqual(current.runtime, runtime) || current.complete !== complete) {
      throw new PilotTurnError('CONCURRENT_STATE_CONFLICT');
    }
    const stamp = FieldValue.serverTimestamp();
    tx.update(campaignRef, { currentLocation: outcome.location, worldTime: data.nextWorldTime,
      lastSequence: data.nextLastSequence, revision: data.nextRevision, updatedAt: stamp });
    const visibility = 'kind' in last.plan && last.plan.kind === 'speech' ? { privateRecipientId: last.plan.recipientId } : {};
    tx.create(playerRef, { ...data.playerEntry, ...visibility, id: ids.player, createdAt: stamp });
    tx.create(engineRef, { ...data.engineEntry, ...visibility, id: ids.engine, createdAt: stamp });
    tx.create(eventRef, { ...data.event, id: ids.event, afterSummary:
      `${steps.map(({ activity }) => activity?.result).filter(Boolean).map((result) => result + ' ').join('')}${outcome.location} (+${outcome.elapsedMinutes} min)`, createdAt: stamp });
    for (const [index, npc] of last.nextRecords.entries()) {
      if (npc.location !== records[index].location) {
        tx.update(npcCollection.doc(npc.id), { location: npc.location, updatedAt: stamp });
      }
    }
    if (state !== runtime && current.routineRef &&
        (state.activities.length || state.memories?.length || state.relationships?.length || state.completedActivities?.length)) {
      tx.set(current.routineRef, state);
    }
    tx.create(receiptRef, { ownerId, turn, plan, resolution, outcome, playerEntryId: ids.player, createdAt: stamp });
    return { mode: 'replay' as const, narration, expectedLastSequence: campaign.lastSequence };
  });
}
