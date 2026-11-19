import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewEchoArcNarration } from '../scripts/narrativeReview';
import { nextGroqAttempt } from '../scripts/echoArcRateLimit';

test('Triagem diferencia um gesto contextual de uma possivel acao consequente', () => {
  const flag = 'revisar_acao_com_consequencia';
  assert.ok(reviewEchoArcNarration('Samuel pegou duas tigelas e as posicionou na mesa.').includes(flag));
  assert.ok(reviewEchoArcNarration('Samuel aceitou levar a encomenda.').includes(flag));
  assert.ok(!reviewEchoArcNarration('Samuel se inclinou para perto da mesa.').includes(flag));
});

test('Sinaliza violacoes observadas nas respostas reais', () => {
  for (const [excerpt, flag] of [
    ['Enquanto Samuel se aproximava, a porta abriu.', 'movimento_ou_postura'],
    ['Samuel permanece em pé, encostado ao parapeito da janela.', 'movimento_ou_postura'],
    ['O jovem, ainda com a túnica amassada, avança um passo.', 'movimento_ou_postura'],
    ['As duas fatias de pão de centeio que Samuel trouxe.', 'acao_passada'],
    ['Samuel sente o peso da responsabilidade.', 'estado_interno'],
    ['Ela fica ao lado da mesa.\n\n**O que Samuel faz a seguir?**', 'pergunta_metanarrativa'],
  ]) assert.ok(reviewEchoArcNarration(excerpt).includes(flag), excerpt);
});

test('Aceita resposta do NPC a uma pergunta, sem confundir dialogo com pergunta metanarrativa', () => {
  assert.deepEqual(reviewEchoArcNarration('Teresa responde a Samuel.\n— O que você faz primeiro com as raízes?'), []);
});

test('Respeita Retry-After, reset de tokens, reset diario e intervalo minimo', () => {
  const now = Date.UTC(2026, 10, 18, 15);
  assert.equal(nextGroqAttempt(new Headers(), 200, now, 1000), now + 20_000);
  assert.equal(nextGroqAttempt(new Headers(), 429, now, 1000), now + 60_000);
  assert.equal(nextGroqAttempt(new Headers({ 'retry-after': '90' }), 429, now, 1000), now + 90_000);
  assert.equal(nextGroqAttempt(new Headers({ 'retry-after': new Date(now + 75_000).toUTCString() }), 429, now, 1000), now + 75_000);
  assert.equal(nextGroqAttempt(new Headers({
    'x-ratelimit-remaining-tokens': '900', 'x-ratelimit-reset-tokens': '1m2.5s',
  }), 200, now, 1000), now + 62_500);
  assert.equal(nextGroqAttempt(new Headers({
    'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '2h1m3s',
  }), 200, now, 1000), now + 7_263_000);
});

test('Sinaliza os trechos reais que escaparam nos cenarios B, C e D', () => {
  const examples = [
    ['Samuel permanece à margem, os olhos fixos nas mãos dos pais, ouvindo cada palavra e cada pausa', 'olhar_intencional'],
    ['carregada de um peso que Samuel ainda não percebeu completamente', 'percepcao_interna'],
    ['volta a atenção para Samuel, que se inclina sobre a pilha de mantimentos', 'postura_inclinada'],
    ['Estranhos viajantes chegaram ao norte, trazendo notícias de um novo comissionamento da Academia de Arvend. Eles buscam alguém que conheça a madeira da região, alguém que possa preparar armas', 'revisar_escalada_de_trama'],
    ['relógio de sol pendurado na parede, os ponteiros de sombra marcando quase exatamente oito e meia', 'revisar_coerencia_fisica'],
  ];
  for (const [excerpt, flag] of examples) assert.ok(reviewEchoArcNarration(excerpt).includes(flag), excerpt);
});

test('Triagem permite efeitos externos e o olhar dos NPCs', () => {
  assert.deepEqual(reviewEchoArcNarration('A chuva molha o manto de Samuel. Teresa fixa o olhar no filho. A sombra do relógio de sol cruza a pedra do pátio.'), []);
});

test('Triagem sinaliza categorias de autonomia nos trechos da v1.2 e em variantes', () => {
  const samples = [
    ['Enquanto Samuel pondera sobre a tarefa que lhe foi confiada.', 'estado_interno'],
    ['Samuel permanece encostado na parede de pedra.', 'movimento_ou_postura'],
    ['Henrique faz uma pausa, observando o brilho atento de Samuel.', 'atencao_atribuida'],
    ['A voz carrega um peso que Samuel sente.', 'estado_interno'],
    ['Samuel concluiu que seria melhor pedir desculpas.', 'estado_interno'],
    ['Samuel ergueu uma mão para pedir a palavra.', 'gesto_voluntario'],
    ['Teresa notou o olhar distraído de Samuel.', 'atencao_atribuida'],
  ];
  for (const [text, flag] of samples) assert.ok(reviewEchoArcNarration(text).includes(flag), text);
});

test('Triagem distingue iniciativas de NPCs e efeitos externos', () => {
  const narration = 'Henrique ponderou por um instante e cruzou os braços. Teresa nota que o vento trouxe farinha para a manga de Samuel. — Posso ajudar, Samuel?';
  assert.deepEqual(reviewEchoArcNarration(narration), []);
});

test('Triagem sinaliza observacao emocional e gesto que passaram no turno 2', () => {
  assert.ok(reviewEchoArcNarration('Samuel observa, satisfeito com a organização.').includes('reacao_emocional_atribuida'));
  assert.ok(reviewEchoArcNarration('Teresa olha para Samuel, que ainda segura o cantinho da sua túnica.').includes('gesto_voluntario'));
  assert.deepEqual(reviewEchoArcNarration('Teresa observa, satisfeita, e segura a própria túnica.'), []);
});
