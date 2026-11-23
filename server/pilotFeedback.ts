import type { PilotTurnError } from './persistPilotTurn';

const gameplayMessages: ReadonlyMap<string, string> = new Map([
  ['PILOT_SPEECH_UNAVAILABLE', 'Com quem Samuel quer conversar? Indique uma pessoa presente.'],
  ['PILOT_BRIDGE_OFFER_UNAVAILABLE', 'Samuel só pode responder a uma oferta pendente com quem a fez presente.'],
  ['PILOT_FACTUAL_NPC_OCCUPIED', 'Essa pessoa está ocupada agora. Samuel pode perguntar em outro momento.'],
  ['PILOT_TRAVEL_UNAVAILABLE', 'Indique um destino conhecido que Samuel possa alcançar daqui.'],
  ['PILOT_ACTION_UNSUPPORTED', 'Descreva um deslocamento, uma conversa, uma observação ou uma ajuda disponível.'],
  ['PILOT_OBSERVATION_UNAVAILABLE', 'Indique o ambiente atual ou uma pessoa presente que você possa observar.'],
  ['PILOT_OBJECT_AMBIGUOUS', 'Qual objeto você quer examinar? Indique o nome dele.'],
  ['PILOT_OBJECT_OUT_OF_REACH', 'O objeto está fora do alcance de Samuel. Ele precisaria se aproximar para examiná-lo.'],
  ['PILOT_OBJECT_UNREGISTERED', 'Samuel não reconhece um objeto com esse nome.'],
  ['PILOT_OBJECT_FIXED', 'Esse objeto faz parte do cenário e Samuel não pode carregá-lo.'],
  ['PILOT_OBJECT_NOT_HELD', 'Samuel não está carregando esse objeto.'],
  ['PILOT_OBJECT_ALREADY_HELD', 'Esse objeto já está no inventário de Samuel.'],
  ['PILOT_OBJECT_OWNED', 'Samuel não tem autorização para pegar esse objeto.'],
  ['PILOT_STORAGE_DISTANT', 'O recipiente está fora do alcance de Samuel.'],
  ['PILOT_STORAGE_UNAVAILABLE', 'Esse objeto não pode ser guardado nesse local.'],
  ['PILOT_STORAGE_CLOSED', 'O armário está fechado. Abra-o primeiro.'],
  ['PILOT_STORAGE_EMPTY', 'Esse objeto não está no armário.'],
  ['PILOT_STORAGE_EXPLICIT', 'O objeto está guardado. Indique de onde Samuel quer retirá-lo.'],
  ['PILOT_TRANSFER_SEQUENCE', 'Envie a transferência do objeto em um turno separado.'],
  ['PILOT_DELIVERY_RECIPIENT', 'Indique uma única pessoa presente para receber o objeto.'],
  ['PILOT_DELIVERY_NOT_TRANSFERABLE', 'Esse objeto não está habilitado para entrega.'],
  ['PILOT_DELIVERY_NOT_ALLOWED', 'A entrega não está disponível para essa pessoa nesta situação.'],
  ['PILOT_DELIVERY_OFFER', 'A oferta não confirma o recebimento. Mantenha o objeto com Samuel.'],
  ['PILOT_ENVIRONMENT_SEQUENCE', 'Envie a ação de organizar o objeto em um turno separado.'],
  ['PILOT_ENVIRONMENT_AMBIGUOUS', 'Qual objeto Samuel quer organizar? Indique o nome dele.'],
  ['PILOT_ENVIRONMENT_UNAVAILABLE', 'Samuel não pode organizar esse objeto.'],
  ['PILOT_ENVIRONMENT_ALREADY_ORGANIZED', 'A bancada já está organizada.'],
  ['PILOT_WAIT_SEQUENCE', 'Envie a espera em um turno separado.'],
  ['PILOT_OPEN_CLOSE_SEQUENCE', 'Envie a ação de abrir ou fechar em um turno separado.'],
  ['PILOT_OPEN_CLOSE_AMBIGUOUS', 'Indique um único objeto para abrir ou fechar.'],
  ['PILOT_OPEN_CLOSE_UNAVAILABLE', 'Esse objeto não pode ser aberto ou fechado.'],
  ['PILOT_OPEN_CLOSE_ALREADY_SET', 'O objeto já está nesse estado.'],
  ['PILOT_WAIT_UNAVAILABLE', 'Indique por quanto tempo Samuel deve esperar, em minutos ou até um horário de hoje.'],
  ['PILOT_TRANSFER_AMBIGUOUS', 'Qual objeto Samuel quer mover? Indique o nome dele.'],
  ['PILOT_ACTIVITY_UNAVAILABLE', 'Essa ajuda não está disponível aqui ou já foi concluída.'],
  ['PILOT_ACTION_INVALID', 'Samuel não pode realizar essa ação como foi descrita.'],
  ['PILOT_SEQUENCE_LIMIT', 'Envie até duas ações por turno.'],
  ['PILOT_SEQUENCE_NEEDS_REPLY', 'Envie a interação separadamente e aguarde a resposta ou esclareça a condição antes de continuar.'],
]);

export function describePilotFeedback(error: PilotTurnError, clarification: boolean) {
  let message = gameplayMessages.get(error.code);
  if (!message) return;
  const { code, absentNpcName, feedback, step } = error;
  if (code === 'PILOT_OPEN_CLOSE_ALREADY_SET') message = 'O objeto já está ' + error.reason + '.';
  if (code === 'PILOT_WAIT_UNAVAILABLE') {
    if (error.reason === 'past') message = 'Esse horário já chegou ou passou. Indique um horário futuro de hoje.';
    if (error.reason === 'invalid') message = 'Esse horário não é válido. Use, por exemplo, “Aguardo até as 10h30”.';
    if (error.reason === 'limit') message = 'Samuel pode esperar de 1 a 60 minutos por turno.';
    if (error.reason === 'midnight') message = 'A espera deve terminar antes da meia-noite. Escolha um intervalo menor.';
  }
  if (clarification) {
    message = (code === 'PILOT_OBJECT_UNREGISTERED' ? message + ' ' : '') + 'Qual objeto você deseja examinar?';
  } else if (code === 'PILOT_TRAVEL_UNAVAILABLE' && error.reason === 'ambiguous-destination') {
    message = 'Para onde Samuel quer ir? Indique um único destino.';
  } else if (code === 'PILOT_TRAVEL_UNAVAILABLE' && error.reason === 'uncatalogued-destination') {
    message = 'Esse local foi mencionado na história, mas ainda não está no mapa jogável.';
  } else if (code === 'PILOT_TRAVEL_UNAVAILABLE' && error.reason === 'unknown-destination') {
    message = 'Samuel não reconhece esse destino no mapa disponível. Indique um local conhecido.';
  } else if (code === 'PILOT_TRAVEL_UNAVAILABLE' && ['unknown-route', 'unmet-conditions'].includes(error.reason ?? '')) {
    message = 'O destino é conhecido, mas não há caminho acessível a partir daqui.';
  } else if (code === 'PILOT_OBSERVATION_UNAVAILABLE' && absentNpcName) {
    message = `Samuel não consegue observar ${absentNpcName} daqui. Essa pessoa não está presente neste local.`;
  } else if (code === 'PILOT_SPEECH_UNAVAILABLE' && absentNpcName) {
    message = absentNpcName + ' não está presente para conversar.';
  } else if (code === 'PILOT_DELIVERY_RECIPIENT' && absentNpcName) {
    message = absentNpcName + ' não está presente para receber o objeto.';
  } else if (code === 'PILOT_OBJECT_OUT_OF_REACH' && feedback?.objectName) {
    if (feedback.openClose) return `“${feedback.objectName}” está fora do alcance de Samuel. Aproxime-se para ${feedback.openClose} o objeto.`;
    if (feedback.organize) return `“${feedback.objectName}” está fora do alcance de Samuel. Ele precisaria se aproximar para organizar o objeto.`;
    message = step && feedback.projectedPlace
      ? `Samuel não conseguiria examinar “${feedback.objectName}” a partir do local previsto (${feedback.projectedPlace}).`
      : `“${feedback.objectName}” está fora do alcance de Samuel. Ele precisaria se aproximar para ${feedback.pickup ? 'recolher' : 'examinar'} o objeto.`;
  }
  return step ? `Etapa ${step}. ${message}` : message;
}
