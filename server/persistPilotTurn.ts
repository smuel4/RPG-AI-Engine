import { type Firestore, FieldValue } from 'firebase-admin/firestore';
import { isDeepStrictEqual } from 'node:util';
import { advanceWorldTime, getActiveTimelineId, processPlayerAction } from '../src/engine/rulesEngine';
import { advanceNpcRoutines, isNpcOccupied, routineScene, type NpcRoutineState } from '../src/engine/npcRoutine';
import { MAX_NPC_MEMORY_LENGTH, recordNpcMemories } from '../src/engine/npcMemory';
import { getNpcIdentity } from '../src/engine/npcIdentity';
import { PLAYER_CHARACTER_ID, recordFirstEncounters, recordPersonalDisclosure, relationshipsInScene } from '../src/engine/npcRelationship';
import { checkTurnRevision, isTurnId, readCommittedTurn, turnDocumentIds, type TurnIdentity } from '../src/engine/turnIdentity';
import { matchCatalogLabels, planPilotTravel, planPilotWait, resolvePlannedOutcome, type TurnCatalog } from '../src/engine/turnPlanner';
import { formatWorldClock } from '../src/engine/constants';
import type { Campaign, GameEvent, InventoryItem, NarrativeEntry, NpcRecord, PilotFocus } from '../src/types/game';
import { validateNarration } from './narratorProvider';
import { answerPilotQuestion } from './pilotFactualDialogue';
import { claimsUnconfirmedPlayerConsequence } from './pilotNarrativeIntegrity';

export const SERVER_PILOT_ID = 'echo-arc-server-pilot';
const speechIntent = /^(?:eu\s+)?(?:digo|falo|conto|confidencio)\b/iu;
const directedSpeech = /^(?:eu\s+)?(digo|falo|conto|confidencio)\s+(?:a|ao|à|para)\s+([\p{L}\p{M}\p{Zs}'’-]+)\s*[:：]\s*([\s\S]+)$/iu;
const travelIntent = /^(?:eu\s+)?(?:vou|caminho|sigo|quero\s+ir)\b/iu;
const transferIntent = /^(?:eu\s+)?(?:(pego|recolho|largo|deixo)|(?:quero|vou)\s+(pegar|recolher|largar|deixar))\s+(.+?)[.!?]?$/iu;
const deliveryIntent = /^(?:eu\s+)?(entrego|dou(?!\s+(?:bom dia|boa tarde|boa noite)\b)|ofereço)\s+(.+?)\s+(?:para|ao|à|a)\s+(.+?)[.!]?$/iu;
const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function storageIntent(action: string) {
  const store = /^(?:eu )?(?:guardo|coloco|(?:tento|quero|vou) (?:guardar|colocar)) (.+?) (?:dentro do|no) (.+?)[.!]?$/iu.exec(action);
  const match = store ?? /^(?:eu )?(?:retiro|tiro|pego|(?:tento|quero|vou) (?:retirar|tirar|pegar)) (.+?) (?:de dentro do|do) (.+?)[.!]?$/iu.exec(action);
  return match && { kind: store ? 'store' as const : 'retrieve' as const, item: match[1], container: match[2] };
}
const dialogueSyntax = (text: string) => text.normalize('NFKC')
  .replace(/[\u200B\uFEFF]/gu, '').replace(/\s+/gu, ' ').trim();

function naturalSpeech(action: string, here: readonly NpcRecord[], records: readonly NpcRecord[],
  focus: readonly PilotFocus[]) {
  const inquiry = /^(?:eu\s+)?(?:quero|gostaria de|vou)\s+(?:conversar|falar)\s+com\s+(.+?)[.!?]?$/iu.exec(action);
  const indirectGreeting = /^(?:eu\s+)?(?:cumprimento\s+|dou\s+(?:bom dia|boa tarde|boa noite)\s+(?:a|ao|à|para)\s+)([^,.!?]+)[.!?]*$/iu.exec(action);
  const indirectQuestion = /^(?:eu\s+)?(?:pergunto|(?:quero|queria|gostaria de) saber)(?:\s+(?:a|ao|à|para)\s+(.+?))?\s+((?:como|se|onde|quando|por que|qual|quanto|o que|no que|em que|com que|quem)\b.+)$/iu.exec(action);
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
  const candidates = resolveNpc(address, here, records, focus);
  if (!recognized && !candidates.contextual && !candidates.named) return null;
  if (!candidates.npc) throw new PilotTurnError('PILOT_SPEECH_UNAVAILABLE', undefined, undefined, candidates.absentNpcName);
  return { recipient: candidates.npc, indirect: Boolean(indirectGreeting || indirectQuestion || report),
    verb: report?.[1] ?? 'digo',
    question: Boolean(indirectQuestion || (!recognized && (directQuestion || vocative))),
    statement: inquiry ? null : report?.[3] ?? question ?? (recognized || !vocative ? action : vocative[2].trim()) };
}

function resolveNpc(address: string, here: readonly NpcRecord[], records: readonly NpcRecord[],
  focus: readonly PilotFocus[]) {
  const reference = normalize(address.trim());
  const matches = ({ name, role }: NpcRecord) => [normalize(name), normalize(role),
    normalize(role).replace(/\s+adotiv[oa]$/, '')].includes(reference);
  const feminine = /^(?:ela|(?:essa|aquela) (?:garota|moca|mulher))$/u.test(reference);
  const masculine = /^(?:ele|(?:esse|aquele) (?:rapaz|moco|homem))$/u.test(reference);
  const deictic = !reference || feminine || masculine || /^(?:esse|essa|aquele|aquela) (?:npc|pessoa)$/u.test(reference);
  const compatible = ({ role }: NpcRecord) => {
    const label = normalize(role);
    if (feminine) return /^(?:mae|filha|irma|tia|avo feminina|moradora|garota|moca|mulher|artesa|professora)\b/u.test(label);
    if (masculine) return /^(?:pai|filho|irmao|tio|morador|rapaz|moco|homem|artesao|professor)\b/u.test(label);
    return true;
  };
  const previous = deictic && focus.find(({ kind, id }) => {
    if (kind !== 'npc') return false;
    const npc = records.find((record) => record.id === id);
    return !npc || compatible(npc);
  });
  const candidates = here.filter(deictic
    ? (npc) => compatible(npc) && (!previous || npc.id === previous.id)
    : matches);
  const named = deictic ? [] : records.filter(({ name }) => normalize(name) === reference);
  return { contextual: deictic, named: !deictic && records.some(matches),
    npc: candidates.length === 1 ? candidates[0] : undefined,
    absentNpcName: !candidates.length ? previous
      ? records.find(({ id }) => id === previous.id)?.name
      : named.length === 1 && !here.includes(named[0]) ? named[0].name : undefined : undefined };
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

function visibleHistory(entries: NarrativeEntry[], recipientId?: string) {
  const bySequence = new Map(entries.map((entry) => [entry.sequence, entry]));
  return entries.filter((entry) => {
    const player = entry.authorRole === 'engine_response' ? bySequence.get(entry.sequence - 1) : entry;
    if (!player || (entry.authorRole === 'engine_response' && (player.authorRole !== 'player_action' ||
        entry.timelineId !== player.timelineId))) return false;
    const recipient = player.privateRecipientId;
    if (recipient) return recipient === recipientId;
    // Legacy unscoped prose has no reliable audience for a directed conversation.
    if (recipientId) return entry.authorRole === 'system_seed';
    // Older conversation records lack a trusted recipient identifier.
    return player.authorRole !== 'player_action' || !speechIntent.test(player.content.trim());
  });
}

export class PilotTurnError extends Error {
  constructor(readonly code: string, readonly reason?: string, readonly step?: number,
    readonly absentNpcName?: string, readonly clarificationPrefix?: string,
    readonly feedback?: { objectName: string; projectedPlace?: string; pickup?: boolean; organize?: boolean;
      openClose?: 'abrir' | 'fechar' }) { super(code); }
}

function splitPilotActions(action: string): string[] {
  const steps: string[] = [];
  let remaining = action;
  while (true) {
    // Preserve the literal contents of a colon-delimited utterance.
    const separator = directedSpeech.test(dialogueSyntax(remaining)) ? null
      : /\s*;\s*|\s*,?\s+\b(?:e\s+depois|depois|em seguida)\s+|\s+e\s+(?=(?:eu\s+)?(?:vou|caminho|sigo|olho|observo|examino|inspeciono|organizo|arrumo|abro|fecho|espero|aguardo|fico\s+aqui\s+esperando|ajudo|quero|pergunto|digo|falo|conto|confidencio|cumprimento|guardo|coloco|retiro|tiro|tento|pego|recolho|largo|deixo|entrego|ofereço|dou(?!\s+(?:bom dia|boa tarde|boa noite)\b)|se)\b)/iu.exec(remaining);
    if (!separator) return [...steps, remaining.trim()];
    steps.push(remaining.slice(0, separator.index).trim().replace(/,$/u, ''));
    if (steps.length === 2) throw new PilotTurnError('PILOT_SEQUENCE_LIMIT', undefined, 3);
    remaining = remaining.slice(separator.index + separator[0].length);
  }
}

export async function persistPilotTurn(db: Firestore, catalog: TurnCatalog, ownerId: string,
  turn: TurnIdentity, narrate: (campaign: Campaign, sceneIntent: string, npcs: ReturnType<typeof routineScene>,
    relationships: ReturnType<typeof relationshipsInScene>, narrative: NarrativeEntry[], declaredAction: string) => Promise<string>,
  objectAnswer?: string, clarification?: { binding: string; replayOnly: boolean }) {
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
  const catalogObjects = catalog.objects ?? [];
  const portableRefs = catalogObjects.filter(({ portable }) => portable).map((object) => ({
    object,
    inventory: campaignRef.collection('inventory').doc(object.id),
    ground: campaignRef.collection('pilotObjectLocations').doc(object.id),
  }));
  async function read(tx: FirebaseFirestore.Transaction, withHistory = false) {
    const [campaignDoc, event, player, engine, receipt] = await tx.getAll(campaignRef, eventRef, playerRef, engineRef, receiptRef);
    const campaign = campaignDoc.data() as Campaign | undefined;
    if (!campaign || campaign.ownerId !== ownerId || campaign.id !== turn.campaignId) {
      throw new PilotTurnError('CAMPAIGN_ACCESS_DENIED');
    }
    if (getActiveTimelineId(campaign) !== turn.baseTimelineId) {
      throw new PilotTurnError('CONCURRENT_STATE_CONFLICT');
    }
    const storedBinding = receipt.data()?.clarificationBinding;
    // An unverified token can only recover the exact request previously committed.
    if (clarification?.replayOnly && typeof storedBinding !== 'string') {
      throw new PilotTurnError('PILOT_CLARIFICATION_EXPIRED');
    }
    if (storedBinding !== undefined && (storedBinding !== clarification?.binding || receipt.data()?.ownerId !== ownerId)) {
      throw new PilotTurnError('TURN_ID_CONFLICT');
    }
    if (event.exists || player.exists || engine.exists || receipt.exists) {
      const entry = event.exists && receipt.data()?.playerEntryId === ids.player
        ? readCommittedTurn(turn, ownerId, event.data() as GameEvent,
          player.data() as NarrativeEntry | undefined, engine.data() as NarrativeEntry | undefined) : null;
      if (!entry) throw new PilotTurnError('TURN_ID_CONFLICT');
      return { campaign, entry };
    }
    if (clarification?.replayOnly) throw new PilotTurnError('PILOT_CLARIFICATION_EXPIRED');
    if (!checkTurnRevision(turn, campaign) || campaign.status !== 'active') {
      throw new PilotTurnError('CONCURRENT_STATE_CONFLICT');
    }
    const portableState = await Promise.all(portableRefs.map(async ({ object, inventory, ground }) => {
      const [item, placement] = await tx.getAll(inventory, ground);
      const held = item.data();
      const placed = placement.data();
      const placedOnGround = typeof placed?.location === 'string' && placed.npcId === undefined && placed.containerId === undefined &&
        catalog.places.some(({ id }) => id === placed.location);
      const placedWithNpc = typeof placed?.npcId === 'string' && placed.npcId.length > 0 && placed.location === undefined &&
        placed.containerId === undefined;
      const stored = typeof placed?.containerId === 'string' && placed.containerId === object.portable?.storageId &&
        placed.npcId === undefined && placed.location === undefined;
      if ((item.exists && (!held || held.id !== object.id || held.ownerId !== ownerId ||
          held.campaignId !== campaign.id || held.quantity !== 1 || placement.exists)) ||
          (placement.exists && (!placed || placed.ownerId !== ownerId || placed.campaignId !== campaign.id ||
            placed.timelineId !== turn.baseTimelineId || (!placedOnGround && !placedWithNpc && !stored)))) {
        throw new PilotTurnError('PILOT_TURN_FAILED', 'portable-state-conflict');
      }
      return { id: object.id, npcId: placedWithNpc ? placed.npcId as string : undefined,
        containerId: stored ? placed.containerId as string : undefined,
        location: item.exists ? null : placedWithNpc || stored ? undefined : (placed?.location as string | undefined) ?? object.location };
    }));
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
    return { campaign, entry: null, routineRef, runtime, records, complete: snapshot.size <= 30, narrative, portableState };
  }
  const { campaign, entry, runtime, records = [], complete, narrative = [], portableState = [] } =
    await db.runTransaction((tx) => read(tx, true));
  if (entry) return { mode: 'replay' as const, narration: entry.content, expectedLastSequence: entry.sequence - 2 };

  const action = turn.declaredAction.trim();
  const actions = splitPilotActions(action);
  const objectLocation = (object: typeof catalogObjects[number]) => object.portable
    ? portableState.find(({ id }) => id === object.id)!.location : object.location;
  if (objectAnswer !== undefined && actions.length !== 1) throw new PilotTurnError('PILOT_OBJECT_UNREGISTERED');
  const turnSequence = campaign.lastSequence + 3;
  // Context comes from committed player actions, with legacy speech recipients as a fallback.
  const recentFocus = narrative.filter(({ authorRole }) => authorRole === 'player_action')
    .sort((a, b) => b.sequence - a.sequence)
    .flatMap(({ pilotFocus, privateRecipientId }): PilotFocus[] => pilotFocus?.slice().reverse() ??
      (privateRecipientId ? [{ kind: 'npc', id: privateRecipientId }] : []));
  const projectStep = (action: string, campaign: Campaign, records: NpcRecord[], runtime: NpcRoutineState | undefined,
    context: readonly PilotFocus[]) => {
    const syntax = dialogueSyntax(action).replace(/^(?:"(.+)"|“(.+)”)$/u, '$1$2').trim();
    const commandSyntax = syntax.replace(/[.!]+$/u, '.');
    const waiting = planPilotWait(syntax, campaign.worldTime);
    if (waiting && actions.length > 1) throw new PilotTurnError('PILOT_WAIT_SEQUENCE');
    const observation = /^(?:eu\s+)?(?:(?:quero|vou)\s+(?:observar|examinar|olhar|inspecionar)|observo|examino|olho|inspeciono)\s+(?:mais\s+de\s+perto\s+)?(.+?)[.!]?$/iu.exec(commandSyntax);
    const help = /^(?:eu\s+)?(?:ajudo|(?:quero|vou|tento)\s+ajudar)\s+(.+?)\s+a\s+(\p{L}+)\s+(.+?)[.!]?$/iu.exec(commandSyntax);
    const explicitSpeech = directedSpeech.exec(action) ?? directedSpeech.exec(syntax);
    const here = records.filter((npc) => npc.location === campaign.currentLocation);
    const storage = storageIntent(commandSyntax);
    const transferCommand = transferIntent.exec(commandSyntax);
    const delivery = deliveryIntent.exec(commandSyntax);
    const organize = /^(?:eu\s+)?(?:organizo|arrumo|vou\s+(?:organizar|arrumar))\s+(.+?)(?:\s+novamente)?[.!]?$/iu.exec(commandSyntax);
    const opening = /^(?:eu\s+)?(abro|fecho)\s+(.+?)(?:\s+novamente)?[.!]?$/iu.exec(commandSyntax);
    if (opening && actions.length > 1) throw new PilotTurnError('PILOT_OPEN_CLOSE_SEQUENCE');
    if (organize && actions.length > 1) throw new PilotTurnError('PILOT_ENVIRONMENT_SEQUENCE');
    const transferring = transferCommand || delivery || storage;
    if (transferring && actions.length > 1) throw new PilotTurnError('PILOT_TRANSFER_SEQUENCE');
    const localObjects = catalogObjects.filter((object) => objectLocation(object) === campaign.currentLocation);
    const bareObservation = /^(?:eu\s+)?(?:examino|observo|olho|inspeciono)[.!?]?$/iu.exec(commandSyntax);
    if (bareObservation && actions.length === 1 && localObjects.length) {
      throw new PilotTurnError('PILOT_OBJECT_AMBIGUOUS', undefined, undefined, undefined, syntax.replace(/[.!?]$/, ''));
    }
    const natural = explicitSpeech || observation || help || transferring || organize || waiting || opening
      ? null : naturalSpeech(syntax, here, records, context);
    if (!explicitSpeech && !natural && speechIntent.test(syntax)) throw new PilotTurnError('PILOT_SPEECH_UNAVAILABLE');
    const speech = Boolean(explicitSpeech || natural);
    if (!speech && !observation && !help && !transferring && !organize && !waiting && !opening && (!travelIntent.test(syntax) ||
        /^(?:eu\s+)?vou\s+(?:observar|olhar|examinar|inspecionar|ajudar|mexer|pegar|interagir)\b/iu.test(action))) {
      throw new PilotTurnError('PILOT_ACTION_UNSUPPORTED');
    }
    const targetKey = (value: string) => normalize(value).replace(/^(?:o|a|os|as)\s+/u, '').trim();
    const target = (kind: PilotFocus['kind']) => context.find((focus) => focus.kind === kind)?.id;
    const selectOutcome = () => {
      if (opening) {
        const open = normalize(opening[1]) === 'abro';
        const key = targetKey(opening[2]);
        const contextual = /^(?:(?:este|esse|aquele)\s+)?objeto$/u.test(key);
        const matches = catalogObjects.filter(({ id, name, aliases }) => contextual
          ? id === target('object') : [name, ...aliases].some((alias) => targetKey(alias) === key));
        const nearby = matches.filter((object) => objectLocation(object) === campaign.currentLocation);
        if (!matches.length) throw new PilotTurnError('PILOT_OBJECT_UNREGISTERED');
        if (nearby.length > 1 || (!nearby.length && matches.length > 1)) throw new PilotTurnError('PILOT_OPEN_CLOSE_AMBIGUOUS');
        if (!nearby.length) throw new PilotTurnError('PILOT_OBJECT_OUT_OF_REACH', undefined, undefined, undefined,
          undefined, { objectName: matches[0].name, openClose: open ? 'abrir' : 'fechar' });
        const object = nearby[0];
        if (!object.openable) throw new PilotTurnError('PILOT_OPEN_CLOSE_UNAVAILABLE');
        const from = runtime?.openObjects?.includes(object.id) ? 'aberto' : 'fechado';
        const to = open ? 'aberto' : 'fechado';
        if (from === to) throw new PilotTurnError('PILOT_OPEN_CLOSE_ALREADY_SET', to);
        return {
          plan: { kind: 'open-close' as const, objectId: object.id, from, to, result: object.openable[to] },
          focus: { kind: 'object', id: object.id } satisfies PilotFocus,
          // This is a simple local interaction, with the same duration as picking up or putting down an item.
          resolution: { completed: true, elapsedMinutes: 0 },
          outcome: { location: campaign.currentLocation, elapsedMinutes: 0 },
        };
      }
      if (waiting) {
        if (waiting.status === 'refused') throw new PilotTurnError('PILOT_WAIT_UNAVAILABLE', waiting.reason);
        const elapsedMinutes = waiting.minutes;
        return { plan: { kind: 'wait' as const, elapsedMinutes }, focus: undefined,
          resolution: { completed: true, elapsedMinutes },
          outcome: { location: campaign.currentLocation, elapsedMinutes } };
      }
      if (organize) {
        const key = targetKey(organize[1]);
        const matches = catalogObjects.filter(({ id, name, aliases }) =>
          /^(?:(?:este|esse|aquele)\s+)?objeto$/u.test(key) ? id === target('object')
            : [name, ...aliases].some((alias) => targetKey(alias) === key));
        if (!matches.length) throw new PilotTurnError('PILOT_OBJECT_UNREGISTERED');
        const nearby = matches.filter((object) => objectLocation(object) === campaign.currentLocation);
        if (nearby.length > 1 || (!nearby.length && matches.length > 1)) throw new PilotTurnError('PILOT_ENVIRONMENT_AMBIGUOUS');
        if (!nearby.length) throw new PilotTurnError('PILOT_OBJECT_OUT_OF_REACH', undefined, undefined, undefined,
          undefined, { objectName: matches[0].aliases.find((alias) => targetKey(alias) === key) ?? matches[0].name, organize: true });
        const object = nearby[0];
        const condition = object.condition;
        const activity = catalog.activities?.find(({ id }) => id === condition?.activityId);
        // Solo and assisted organization share the same completion flag and duration.
        if (!condition?.organize || !activity || activity.blocked || activity.location !== campaign.currentLocation ||
            !Number.isSafeInteger(activity.minutes) || activity.minutes < 1 || activity.minutes > 720) {
          throw new PilotTurnError('PILOT_ENVIRONMENT_UNAVAILABLE');
        }
        if (runtime?.completedActivities?.includes(activity.id)) throw new PilotTurnError('PILOT_ENVIRONMENT_ALREADY_ORGANIZED');
        return {
          plan: { kind: 'organize' as const, objectId: object.id, activityId: activity.id,
            from: 'desorganizada', to: 'organizada', result: activity.result },
          focus: { kind: 'object', id: object.id } satisfies PilotFocus,
          resolution: { completed: true, elapsedMinutes: activity.minutes },
          outcome: { location: campaign.currentLocation, elapsedMinutes: activity.minutes },
        };
      }
      if (transferring) {
        if (delivery && (normalize(delivery[1]) === 'ofereco' || syntax.endsWith('?'))) {
          throw new PilotTurnError('PILOT_DELIVERY_OFFER');
        }
        const pickup = !storage && /^(?:peg|recolh)/iu.test(transferCommand?.[1] ?? transferCommand?.[2] ?? '');
        const targetText = storage?.item ?? delivery?.[2] ?? transferCommand?.[3] ?? '';
        const key = targetKey(storage || delivery || pickup ? targetText : targetText.replace(/\s+no ch(?:ã|a)o$/iu, ''));
        const contextual = /^(?:(?:este|esse|aquele)\s+)?(?:objeto|item)$/u.test(key);
        const matches = catalogObjects.filter(({ id, name, aliases }) => contextual
          ? id === target('object') : [name, ...aliases].some((alias) => targetKey(alias) === key));
        const containers = storage ? catalogObjects.filter(({ name, aliases }) =>
          [name, ...aliases].some((alias) => targetKey(alias) === targetKey(storage.container))) : [];
        const container = containers[0];
        if (storage) {
          if (!container) throw new PilotTurnError('PILOT_OBJECT_UNREGISTERED');
          if (containers.length > 1) throw new PilotTurnError('PILOT_TRANSFER_AMBIGUOUS');
          if (container.location !== campaign.currentLocation) throw new PilotTurnError('PILOT_STORAGE_DISTANT');
        }
        const eligible = matches.filter((object) => storage?.kind === 'retrieve'
          ? portableState.some((entry) => entry.id === object.id && entry.containerId === container.id)
          : objectLocation(object) === (pickup ? campaign.currentLocation : null));
        if (eligible.length > 1 || (!eligible.length && matches.length > 1)) throw new PilotTurnError('PILOT_TRANSFER_AMBIGUOUS');
        const object = eligible[0] ?? matches[0];
        if (!object) throw new PilotTurnError('PILOT_OBJECT_UNREGISTERED');
        if (storage) {
          if (object.portable?.storageId !== container.id || !container.openable) throw new PilotTurnError('PILOT_STORAGE_UNAVAILABLE');
          if (!runtime?.openObjects?.includes(container.id)) throw new PilotTurnError('PILOT_STORAGE_CLOSED');
          if (storage.kind === 'retrieve' && !eligible.length) throw new PilotTurnError('PILOT_STORAGE_EMPTY');
        }
        if (!object.portable) throw new PilotTurnError(delivery ? 'PILOT_DELIVERY_NOT_TRANSFERABLE'
          : pickup ? 'PILOT_OBJECT_FIXED' : 'PILOT_OBJECT_NOT_HELD');
        if (pickup && portableState.some((entry) => entry.id === object.id && entry.containerId)) {
          throw new PilotTurnError('PILOT_STORAGE_EXPLICIT');
        }
        if (pickup && (object.portable.ownerNpcId || objectLocation(object) === undefined)) {
          throw new PilotTurnError('PILOT_OBJECT_OWNED');
        }
        if (!eligible.length) {
          if (!pickup) throw new PilotTurnError('PILOT_OBJECT_NOT_HELD');
          if (objectLocation(object) === null) throw new PilotTurnError('PILOT_OBJECT_ALREADY_HELD');
          throw new PilotTurnError('PILOT_OBJECT_OUT_OF_REACH', undefined, undefined, undefined, undefined,
            { objectName: object.name, pickup: true });
        }
        let recipient: NpcRecord | undefined;
        if (delivery) {
          const address = targetKey(delivery[3]);
          const resolved = resolveNpc(address, here, records, context);
          recipient = complete ? resolved.npc : undefined;
          if (!recipient) {
            const named = records.filter(({ name }) => targetKey(name) === address);
            const absentName = resolved.absentNpcName ?? (named.length === 1 && !here.includes(named[0]) ? named[0].name : undefined);
            throw new PilotTurnError('PILOT_DELIVERY_RECIPIENT', undefined, undefined, absentName);
          }
          const permission = object.portable.delivery;
          if (!permission) throw new PilotTurnError('PILOT_DELIVERY_NOT_TRANSFERABLE');
          if (permission.recipientKey !== getNpcIdentity(campaign, recipient)?.key || permission.location !== campaign.currentLocation ||
              isNpcOccupied(runtime, recipient.id, campaign.worldTime)) {
            throw new PilotTurnError('PILOT_DELIVERY_NOT_ALLOWED');
          }
        }
        const transfer = storage ? { kind: storage.kind, objectId: object.id, containerId: container.id, containerName: container.name }
          : recipient ? { kind: 'delivery' as const, objectId: object.id, recipientId: recipient.id }
          : { kind: pickup ? 'pickup' as const : 'drop' as const, objectId: object.id };
        // A simple transfer follows the pilot's zero-minute policy for local interactions.
        return { transfer, plan: transfer, focus: { kind: 'object', id: object.id } satisfies PilotFocus,
          resolution: { completed: true, elapsedMinutes: 0 },
          outcome: { location: campaign.currentLocation, elapsedMinutes: 0 }, deliveryRecipient: recipient?.name };
      }
      if (speech) {
        const [, verb, name, content] = explicitSpeech ?? ['', natural!.verb, natural!.recipient.name, natural!.statement ?? ''];
        const explicitRecipient = explicitSpeech && resolveNpc(name, here, records, context);
        const recipient = natural?.recipient ?? explicitRecipient?.npc;
        const statement = content.trim();
        const personal = verb.toLowerCase() === 'confidencio' &&
          !/^(?:olá|oi|bom dia|boa tarde|boa noite|tudo bem|obrigad[oa]|até logo)[\s.!?,]*$/iu.test(statement);
        const remember = personal || verb.toLowerCase() === 'conto';
        if (!complete || !recipient || (!statement && !natural) || (remember && statement.length > MAX_NPC_MEMORY_LENGTH)) {
          throw new PilotTurnError('PILOT_SPEECH_UNAVAILABLE', undefined, undefined, explicitRecipient?.absentNpcName);
        }
        const isQuestion = natural?.question ?? statement.endsWith('?');
        const factualAnswer = isQuestion && !remember
          ? answerPilotQuestion(statement, campaign, recipient, records, runtime, catalog, portableState) : undefined;
        if (isNpcOccupied(runtime, recipient.id, campaign.worldTime)) {
          throw new PilotTurnError('PILOT_FACTUAL_NPC_OCCUPIED');
        }
        return {
          focus: { kind: 'npc', id: recipient.id } satisfies PilotFocus,
          recipientName: recipient.name,
          plan: { kind: 'speech' as const, recipientId: recipient.id, statement, remember, personal,
            ...(factualAnswer ? { factualAnswer } : {}) },
          resolution: { completed: true, elapsedMinutes: 0 },
          outcome: { location: campaign.currentLocation, elapsedMinutes: 0 },
        };
      }
      if (observation) {
        const current = catalog.places.find(({ id }) => id === campaign.currentLocation);
        const focusKey = targetKey(observation[1]);
        const prefix = actions.length === 1 && localObjects.length
          ? commandSyntax.slice(0, commandSyntax.lastIndexOf(observation[1])).trim() : undefined;
        const npcKey = /^que (.+?) (?:esta fazendo|faz)$/u.exec(focusKey)?.[1];
        const npc = resolveNpc(npcKey ?? focusKey, here, records, context);
        const surroundings = objectAnswer === undefined && /^(?:ao (?:meu )?redor|em volta|ambiente|local|aqui)$/u.test(focusKey);
        const placeReference = /^(?:la|ali|(?:esse|este|aquele) (?:lugar|local|ambiente))$/u.test(focusKey);
        const local = objectAnswer === undefined && current && (placeReference ? target('place') === current.id
          : [current.id, ...current.aliases].some((name) => targetKey(name) === focusKey));
        const visibleNpc = complete && objectAnswer === undefined ? npc.npc : undefined;
        const objectKey = focusKey.replace(/^(?:est[ea]s?|ess[ea]s?|aquel[ea]s?)\s+/u, '');
        const objectReference = /^(?:objeto|coisa)$/u.test(objectKey);
        const requestedObject = objectAnswer === undefined ? objectKey : targetKey(objectAnswer);
        const exactObjects = catalogObjects.filter(({ id, name, aliases }) =>
          objectAnswer === undefined && objectReference ? id === target('object')
            : [name, ...aliases].some((alias) => targetKey(alias) === requestedObject));
        const requiresSceneTarget = objectAnswer === undefined && (npcKey || npc.contextual || npc.named || placeReference);
        const typoMatches = !exactObjects.length && objectAnswer === undefined && !objectReference &&
          !requiresSceneTarget && !surroundings && !local && !visibleNpc
          ? matchCatalogLabels(requestedObject, catalogObjects, ({ name, aliases }) => [name, ...aliases], true) : [];
        const objects = exactObjects.length ? exactObjects : typoMatches;
        const nearbyObjects = objects.filter((object) => objectLocation(object) === campaign.currentLocation);
        if (!surroundings && !local && !visibleNpc && !requiresSceneTarget && catalog.objects) {
          if (nearbyObjects.length > 1 || typoMatches.length > 1 || (objectReference && !objects.length)) {
            throw new PilotTurnError('PILOT_OBJECT_AMBIGUOUS', undefined, undefined, undefined, prefix);
          }
          if (!nearbyObjects.length) {
            if (!objects.length) throw new PilotTurnError('PILOT_OBJECT_UNREGISTERED', undefined, undefined, undefined, prefix);
            const known = objects.length === 1 ? objects[0] : undefined;
            if (known && objectLocation(known) === null) throw new PilotTurnError('PILOT_OBJECT_ALREADY_HELD');
            const objectName = known && (known.aliases.find((alias) => targetKey(alias) === requestedObject) ?? known.name);
            throw new PilotTurnError('PILOT_OBJECT_OUT_OF_REACH', undefined, undefined, undefined, undefined,
              objectName ? { objectName, projectedPlace: current?.aliases[0] ?? current?.id } : undefined);
          }
        }
        const object = !surroundings && !local && !visibleNpc && !requiresSceneTarget ? nearbyObjects[0] : undefined;
        const condition = object?.condition;
        const objectFact = object && [object.description, condition &&
          (runtime?.completedActivities?.includes(condition.activityId)
            ? condition.organize?.completed ?? catalog.activities?.find(({ id }) => id === condition.activityId)?.result
            : condition.initial), object.openable?.[runtime?.openObjects?.includes(object.id) ? 'aberto' : 'fechado']]
          .filter(Boolean).join(' ');
        if (!current || (!surroundings && !local && !visibleNpc && !object)) {
          // Explicit names come from the player's command. Roles never disclose an off-scene identity.
          const named = complete && !npc.contextual && !npc.npc &&
            records.filter(({ name }) => targetKey(name) === (npcKey ?? focusKey));
          const absentNpcName = objectAnswer === undefined
            ? npc.absentNpcName ?? (named && named.length === 1 && !here.some(({ id }) => id === named[0].id)
              ? named[0].name : undefined) : undefined;
          throw new PilotTurnError('PILOT_OBSERVATION_UNAVAILABLE', undefined, undefined, absentNpcName);
        }
        const focus: PilotFocus = surroundings || local ? { kind: 'place', id: current.id }
          : object ? { kind: 'object', id: object.id } : { kind: 'npc', id: visibleNpc!.id };
        return {
          focus,
          plan: { kind: 'observation' as const, focus: object?.name ?? (surroundings || local ? current.id : visibleNpc!.name),
            ...(objectFact === undefined ? {} : { objectFact }),
            ...(condition?.organize || object?.openable ? { authoritative: true } : {}) },
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
          focus: { kind: 'npc', id: helpers[0].id } satisfies PilotFocus,
          plan: { kind: 'activity' as const, activityId: activity.id, participantId: helpers[0].id,
            participant: helpers[0].name, result: activity.result },
          resolution: { completed: true, elapsedMinutes: activity.minutes },
          outcome: { location: campaign.currentLocation, elapsedMinutes: activity.minutes },
        };
      }
      const plan = planPilotTravel(syntax, campaign, catalog);
      if (plan.status !== 'planned' || plan.intent.kind !== 'travel' || plan.expectedMinutes === null ||
          plan.origin === plan.destination) throw new PilotTurnError('PILOT_TRAVEL_UNAVAILABLE',
        plan.status === 'clarification' ? plan.reason : undefined);
      const resolution = { completed: true, elapsedMinutes: plan.expectedMinutes };
      const outcome = resolvePlannedOutcome(plan, resolution);
      if (!outcome) throw new PilotTurnError('PILOT_TRAVEL_UNAVAILABLE');
      return { plan, resolution, outcome, focus: { kind: 'place', id: outcome.location } satisfies PilotFocus };
    };
    const { plan, resolution, outcome, focus, recipientName, transfer, deliveryRecipient } = selectOutcome();
    const activity = 'kind' in plan && plan.kind === 'activity' ? plan : null;
    const organization = 'kind' in plan && plan.kind === 'organize' ? plan : null;
    const openClose = 'kind' in plan && plan.kind === 'open-close' ? plan : null;
    const observationPlan = 'kind' in plan && plan.kind === 'observation' ? plan : null;
    const arrival = { ...campaign, currentLocation: outcome.location,
      worldTime: advanceWorldTime(campaign.worldTime, outcome.elapsedMinutes) };
    const eventSequence = turnSequence;
    const simulation = advanceNpcRoutines(campaign, arrival.worldTime, complete ? records : [], catalog, runtime,
      { turnId: turn.turnId, sequence: eventSequence }, 'kind' in plan && plan.kind === 'wait');
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
    const destinationsByNpc = new Map(simulation.moves.map(({ npcId, to }) => [npcId, to]));
    const nextRecords = records.map((npc) => destinationsByNpc.has(npc.id)
      ? { ...npc, location: destinationsByNpc.get(npc.id)! } : npc);
    if (transfer?.kind === 'delivery' && !nextRecords.some(({ id, location }) =>
      id === transfer.recipientId && location === outcome.location)) throw new PilotTurnError('PILOT_DELIVERY_RECIPIENT');
    const present = routineScene(arrival, nextRecords, simulation.state, eventSequence);
    const relationships = speechState.relationships ?? [];
    const encounters = !('kind' in plan) && complete ? recordFirstEncounters(relationships, present.npcs, origin) : relationships;
    const completion = activity ?? organization;
    const worldState = openClose ? { ...speechState,
      openObjects: openClose.to === 'aberto' ? [...(speechState.openObjects ?? []), openClose.objectId]
        : (speechState.openObjects ?? []).filter((id) => id !== openClose.objectId) }
      : completion ? { ...speechState,
      completedActivities: [...(speechState.completedActivities ?? []), completion.activityId] }
      : encounters === relationships ? speechState : { ...speechState, relationships: encounters };
    const sharedMemories: Parameters<typeof recordNpcMemories>[1][number][] = [];
    if (transfer?.kind === 'delivery') {
      const object = catalogObjects.find(({ id }) => id === transfer.objectId)!;
      sharedMemories.push({ ...origin, npcId: transfer.recipientId, occurredAt: arrival.worldTime,
        origin: { kind: 'participated', subjectId: object.id, event: 'delivery' },
        fact: 'Recebeu de Samuel o item “' + object.name + '”.' });
    }
    const organized = completion && catalogObjects.find(({ condition }) =>
      condition?.organize && condition.activityId === completion.activityId);
    if (organized) {
      for (const npc of here) {
        const participant = activity?.participantId === npc.id;
        if (!participant && (getNpcIdentity(campaign, npc)?.key !== 'echo-arc:teresa' ||
            simulation.moves.some(({ npcId }) => npcId === npc.id))) continue;
        sharedMemories.push({ ...origin, npcId: npc.id, occurredAt: arrival.worldTime,
          origin: participant ? { kind: 'participated', subjectId: organized.id, event: 'organization' }
            : { kind: 'observed', subjectId: organized.id, event: 'organization', location: campaign.currentLocation },
          fact: participant ? 'Organizou a bancada com Samuel.' : 'Viu Samuel organizar a bancada.' });
      }
    }
    const state = sharedMemories.length
      ? { ...worldState, memories: recordNpcMemories(worldState.memories ?? [], sharedMemories) } : worldState;
    const visibleNewcomers = encounters.filter((relation) => relation.firstEncounter?.turnId === turn.turnId && !relationships.includes(relation))
      .map((relation) => present.npcs.find((npc) => npc.id === relation.from)!.name);
    const destinations = catalog.routes.filter((route) => route.from === arrival.currentLocation && !route.blocked)
      .map((route) => catalog.places.find((place) => place.id === route.to))
      .filter((place) => place !== undefined).map(({ id, aliases }) => ({ id, aliases }));
    return { plan, outcome, activity, organization, openClose, observationPlan, arrival, state, nextRecords, focus, transfer, deliveryRecipient,
      speech, recipientName, natural, present, visibleNewcomers, destinations };
  };

  const steps: ReturnType<typeof projectStep>[] = [];
  for (const [index, declared] of actions.entries()) {
    const previous = steps.at(-1);
    try {
      if (actions.length > 1 && /^(?:se|caso)\b/iu.test(declared)) throw new PilotTurnError('PILOT_SEQUENCE_NEEDS_REPLY');
      const step = projectStep(declared, previous?.arrival ?? campaign, previous?.nextRecords ?? records,
        previous?.state ?? runtime, previous?.focus ? [previous.focus, ...recentFocus] : recentFocus);
      if (step.speech && index < actions.length - 1) throw new PilotTurnError('PILOT_SEQUENCE_NEEDS_REPLY');
      steps.push(step);
    } catch (error) {
      if (actions.length > 1 && error instanceof PilotTurnError) {
        throw new PilotTurnError(error.code, error.reason, index + 1, error.absentNpcName, undefined, error.feedback);
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
  const transferred = last.transfer && portableRefs.find(({ object }) => object.id === last.transfer?.objectId);
  const transferSummary = transferred && (last.transfer?.kind === 'delivery'
    ? 'Samuel entregou o item “' + transferred.object.name + '” a ' + last.deliveryRecipient + '.'
    : last.transfer?.kind === 'store' ? `Samuel guardou o item “${transferred.object.name}” no ${last.transfer.containerName}.`
    : last.transfer?.kind === 'retrieve' ? `Samuel retirou o item “${transferred.object.name}” do ${last.transfer.containerName}.`
    : (last.transfer?.kind === 'pickup' ? 'Samuel recolheu o item “' : 'Samuel deixou no chão o item “') + transferred.object.name + '”.');
  const narrateStep = async (step: typeof last, declared: string) => {
    if ('kind' in step.plan && step.plan.kind === 'speech' && step.plan.factualAnswer) return step.plan.factualAnswer;
    if ('kind' in step.plan && step.plan.kind === 'wait') {
      const duration = step.plan.elapsedMinutes === 1 ? '1 minuto' : step.plan.elapsedMinutes + ' minutos';
      return 'Samuel aguardou ' + duration + '. Agora são ' + formatWorldClock(step.arrival.worldTime) + '.';
    }
    if (step.organization) return step.organization.result;
    if (step.openClose) return step.openClose.result;
    if (step.observationPlan?.authoritative && step.observationPlan.objectFact) return step.observationPlan.objectFact;
    if (step.activity && catalogObjects.some(({ condition }) =>
      condition?.organize && condition.activityId === step.activity?.activityId)) return step.activity.result;
    const { outcome, activity, observationPlan, arrival, state, speech, recipientName, natural, present,
      visibleNewcomers, destinations } = step;
    const recipientId = 'kind' in step.plan && step.plan.kind === 'speech' ? step.plan.recipientId : undefined;
    const dialogueScene = recipientId ? routineScene(arrival,
      present.npcs.filter(({ id }) => id === recipientId), state, turnSequence) : undefined;
    const contextScene = dialogueScene ? { ...dialogueScene,
      knowledge: [...dialogueScene.knowledge, ...present.knowledge.filter(({ source }) => source === 'public')] }
      : observationPlan || activity ? { ...present, knowledge: [], memories: [] } : present;
    const destinationContext = ` Contexto operacional de rotas: ${JSON.stringify(destinations)}. Escreva somente prosa narrativa, sem menus, listas ou cabeçalhos técnicos. Locais podem ser citados naturalmente. Só indique como caminho confirmado uma rota deste contexto; lugares fora dele podem aparecer como referências ainda não verificadas.`;
    const scene = await narrate(arrival,
      (speech ? `Mostre a reação de ${recipientName} em até quatro frases. ${natural?.statement === null ? 'Abra espaço para conversar; Samuel ainda não disse nada.' : 'Reaja à fala declarada; só o destinatário ouviu a informação. Trate-a como relato, sem confirmar fatos, compromissos ou objetivos.'} ${natural?.indirect ? 'O jogador declarou a interação em discurso indireto; não invente uma fala literal de Samuel.' : ''} Mantenha a posição e os objetos da última cena ou mostre como mudaram. Não repita propostas sem motivo nem atribua novas falas ou ações a Samuel.`
        : observationPlan ? `Descreva somente o que pode ser percebido de ${observationPlan.focus} neste local. Use detalhes sensoriais passageiros; não revele informações privadas, invente ações, posse ou mudanças permanentes. Nenhum tempo relevante se passou.`
          : activity ? `A tentativa de ajudar ${activity.participant} foi concluída em ${outcome.elapsedMinutes} minutos. Resultado confirmado: ${activity.result} Descreva apenas um detalhe visível desse resultado, sem criar recompensas, mudanças de relacionamento, falas ou ações novas.`
            : `Descreva o que é visível em ${outcome.location}, em até três frases. Samuel já chegou após ${outcome.elapsedMinutes} minutos. Pode mostrar atividades locais observáveis. Use apenas traços físicos já estabelecidos para personagens nomeados. Não atribua falas ou ações a Samuel e não narre deslocamentos adicionais.`)
        + (observationPlan?.objectFact ? ' O motor já apresenta estes fatos ao jogador: ' + observationPlan.objectFact +
          ' Complemente sem repetir ou contradizer esses fatos e sem atribuir novas propriedades ao objeto.' : '')
        + destinationContext,
      contextScene,
      observationPlan || activity ? [] : relationshipsInScene(contextScene.npcs, turn.baseTimelineId, state.relationships ?? []),
      visibleHistory(narrative, recipientId), declared);
    const description = removeRouteMenu(validateNarration(scene, 'groq'), destinations);
    const prose = speech ? description
      : observationPlan ? validateObservationProse(description)
      : arrivalProse(description, outcome.location, catalog);
    if (claimsUnconfirmedPlayerConsequence(prose)) {
      console.warn('[freixo] Prosa contida', { turnId: turn.turnId, reason: 'unconfirmed-player-consequence' });
      // Preserve the confirmed resolution. Only the provider's contribution is replaced.
      return [activity?.result, observationPlan?.objectFact,
        speech ? 'A conversa faz uma pausa.' : 'Nada mais se destaca neste momento.'].filter(Boolean).join(' ');
    }
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
      descriptions.push(transferSummary || await narrateStep(step, actions[index]));
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
        !isDeepStrictEqual(current.records, records) || !isDeepStrictEqual(current.runtime, runtime) ||
        !isDeepStrictEqual(current.portableState, portableState) || current.complete !== complete) {
      throw new PilotTurnError('CONCURRENT_STATE_CONFLICT');
    }
    const stamp = FieldValue.serverTimestamp();
    tx.update(campaignRef, { currentLocation: outcome.location, worldTime: data.nextWorldTime,
      lastSequence: data.nextLastSequence, revision: data.nextRevision, updatedAt: stamp });
    const visibility = 'kind' in last.plan && last.plan.kind === 'speech' ? { privateRecipientId: last.plan.recipientId } : {};
    tx.create(playerRef, { ...data.playerEntry, ...visibility, pilotFocus: steps.flatMap(({ focus }) => focus ? [focus] : []),
      id: ids.player, createdAt: stamp });
    tx.create(engineRef, { ...data.engineEntry, ...visibility, id: ids.engine, createdAt: stamp });
    tx.create(eventRef, { ...data.event, id: ids.event, afterSummary:
      (transferSummary ? transferSummary + ' ' : '') + (last.organization ? last.organization.result + ' ' : '') +
      (last.openClose ? last.openClose.result + ' ' : '') +
      `${steps.map(({ activity }) => activity?.result).filter(Boolean).map((result) => result + ' ').join('')}${outcome.location} (+${outcome.elapsedMinutes} min)`, createdAt: stamp });
    if (transferred && (last.transfer?.kind === 'pickup' || last.transfer?.kind === 'retrieve')) {
      const item: InventoryItem = { id: transferred.object.id, ownerId, campaignId: campaign.id,
        name: transferred.object.name, category: 'recurso', quantity: 1, description: transferred.object.description,
        equipable: false, equipped: false, createdAt: stamp, updatedAt: stamp };
      tx.create(transferred.inventory, item);
      tx.delete(transferred.ground);
    } else if (transferred) {
      tx.delete(transferred.inventory);
      tx.create(transferred.ground, { ownerId, campaignId: campaign.id, timelineId: turn.baseTimelineId,
        ...(last.transfer?.kind === 'delivery' ? { npcId: last.transfer.recipientId }
          : last.transfer?.kind === 'store' ? { containerId: last.transfer.containerId } : { location: outcome.location }) });
    }
    for (const [index, npc] of last.nextRecords.entries()) {
      if (npc.location !== records[index].location) {
        tx.update(npcCollection.doc(npc.id), { location: npc.location, updatedAt: stamp });
      }
    }
    if (state !== runtime && current.routineRef &&
        (state.activities.length || state.memories?.length || state.relationships?.length ||
          state.completedActivities?.length || state.openObjects !== undefined)) {
      tx.set(current.routineRef, state);
    }
    tx.create(receiptRef, { ownerId, turn, plan, resolution, outcome, playerEntryId: ids.player,
      ...(clarification ? { clarificationBinding: clarification.binding } : {}), createdAt: stamp });
    return { mode: 'replay' as const, narration, expectedLastSequence: campaign.lastSequence };
  });
}
