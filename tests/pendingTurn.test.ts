import assert from 'node:assert/strict';
import test from 'node:test';
import { clearPendingTurn, loadPendingTurn, releaseRejectedPilotTurn, savePendingTurn } from '../src/services/pendingTurn';
import { NarratorRequestError, requestNarratorTurn } from '../src/services/narratorClient';

const turn = {
  turnId: 'a834b1ac-d3b4-4439-9f71-a135722ce71a', campaignId: 'campanha',
  declaredAction: 'Olho ao redor', advanceMinutes: 1, expectedRevision: 7, baseTimelineId: 'ramo',
};

function makeStorage(entries = new Map<string, string>()): Storage {
  return {
    get length() { return entries.size; },
    clear: () => entries.clear(),
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
  };
}

test('recarregamento restaura somente o turno do usuário e da campanha selecionados', () => {
  const entries = new Map<string, string>();
  savePendingTurn(makeStorage(entries), 'dono', { ...turn, token: 'segredo' } as typeof turn);
  const reloaded = makeStorage(entries);
  assert.deepEqual(loadPendingTurn(reloaded, 'dono', 'campanha'), turn);
  assert.equal(loadPendingTurn(reloaded, 'outro', 'campanha'), null);
  assert.equal(loadPendingTurn(reloaded, 'dono', 'outra'), null);
  assert.ok(![...entries.values()][0].includes('segredo'));
  clearPendingTurn(reloaded, 'dono', { ...turn, turnId: 'outro' });
  assert.deepEqual(loadPendingTurn(reloaded, 'dono', 'campanha'), turn);
});

test('reenvio conserva a identidade, mantém conflito e limpa após resposta de replay', async (t) => {
  const storage = makeStorage();
  savePendingTurn(storage, 'dono', turn);
  const reloaded = loadPendingTurn(storage, 'dono', 'campanha')!;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, '/api/narrator/turn');
    assert.deepEqual(JSON.parse(String(init.body)), turn);
    calls++;
    if (calls === 1) return Response.json({ code: 'CONCURRENT_STATE_CONFLICT', message: 'Origem obsoleta' }, { status: 409 });
    return Response.json({ ...turn, mode: 'replay', narration: 'Narração já gravada', expectedLastSequence: 12 });
  });
  const submit = () => requestNarratorTurn('token-de-teste', { ...reloaded, turn: reloaded });
  await assert.rejects(submit(), (error) =>
    error instanceof NarratorRequestError && error.code === 'CONCURRENT_STATE_CONFLICT');
  assert.deepEqual(loadPendingTurn(storage, 'dono', 'campanha'), turn);
  const receipt = await submit();
  assert.equal(receipt.mode, 'replay');
  assert.equal(receipt.turnId, turn.turnId);
  clearPendingTurn(storage, 'dono', reloaded);
  assert.equal(loadPendingTurn(storage, 'dono', 'campanha'), null);
});

test('uma pergunta libera o turno e uma resposta já enviada pode ser recuperada', async (t) => {
  const entries = new Map<string, string>();
  const storage = makeStorage(entries);
  const ask = { ...turn, declaredAction: 'Examino aquele objeto.' };
  savePendingTurn(storage, 'dono', ask);
  const clarificationToken = 'pergunta.assinada';
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (!body.clarificationToken) return Response.json({ code: 'PILOT_OBJECT_AMBIGUOUS',
      message: 'Qual objeto você deseja examinar?', clarificationToken }, { status: 422 });
    assert.equal(body.clarificationToken, clarificationToken);
    assert.equal(body.declaredAction, 'A bancada da cozinha.');
    assert.equal(body.turnId, ask.turnId);
    return Response.json({ mode: 'replay' });
  });
  await assert.rejects(requestNarratorTurn('token-de-teste', { ...ask, turn: ask }), (error) =>
    releaseRejectedPilotTurn(storage, 'dono', ask, error) && error.clarificationToken === clarificationToken);
  assert.equal(loadPendingTurn(storage, 'dono', ask.campaignId), null);

  const answer = { ...ask, declaredAction: 'A bancada da cozinha.', clarificationToken };
  savePendingTurn(storage, 'dono', answer);
  const restored = loadPendingTurn(makeStorage(entries), 'dono', answer.campaignId)!;
  assert.deepEqual(restored, answer);
  assert.equal((await requestNarratorTurn('token-de-teste', { ...restored, turn: restored })).mode, 'replay');
});

test('o feedback de gameplay libera a edição e erros técnicos preservam a retomada', async (t) => {
  const storage = makeStorage();
  let status = 422;
  t.mock.method(globalThis, 'fetch', async () => {
    if (!status) throw new TypeError('Conexão perdida');
    return Response.json({ code: status === 422 ? 'PILOT_OBJECT_OUT_OF_REACH' : 'AUTH_REQUIRED',
      message: 'Resposta do servidor', gameplayFeedback: true }, { status });
  });
  const send = () => requestNarratorTurn('token-de-teste', { ...turn, turn });
  savePendingTurn(storage, 'dono', turn);
  await assert.rejects(send(), (error) =>
    releaseRejectedPilotTurn(storage, 'dono', turn, error) && error.gameplayFeedback);
  assert.equal(loadPendingTurn(storage, 'dono', turn.campaignId), null);
  savePendingTurn(storage, 'dono', turn);
  status = 401;
  await assert.rejects(send(), (error) => error instanceof NarratorRequestError &&
    !error.gameplayFeedback && !releaseRejectedPilotTurn(storage, 'dono', turn, error));
  status = 0;
  await assert.rejects(send(), (error) => error instanceof TypeError &&
    !releaseRejectedPilotTurn(storage, 'dono', turn, error));
  assert.deepEqual(loadPendingTurn(storage, 'dono', turn.campaignId), turn);
});

test('recusa explícita libera a edição e uma confirmação incerta conserva a identidade', async (t) => {
  const entries = new Map<string, string>();
  const storage = makeStorage(entries);
  const send = (identity: typeof turn) => requestNarratorTurn('token-de-teste', { ...identity, turn: identity });
  let code = '';
  let status = 422;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    if (code === 'network') throw new TypeError('Resposta perdida');
    if (status !== 200) return Response.json({ code, message: 'Resposta do piloto' }, { status });
    return Response.json({ ...JSON.parse(String(init.body)), mode: 'replay', narration: 'Gravada' });
  });

  for (const rejected of ['PILOT_OBJECT_AMBIGUOUS', 'PILOT_OBJECT_OUT_OF_REACH',
    'PILOT_OBJECT_UNREGISTERED', 'PILOT_TRAVEL_UNAVAILABLE']) {
    code = rejected;
    savePendingTurn(storage, 'dono', turn);
    await assert.rejects(send(turn), (error) => releaseRejectedPilotTurn(storage, 'dono', turn, error));
    assert.equal(loadPendingTurn(storage, 'dono', turn.campaignId), null);
  }

  const corrected = { ...turn, turnId: 'f51f0fcb-15aa-456f-a305-7f8e621f1ae7', declaredAction: 'Examino a bancada.' };
  savePendingTurn(storage, 'dono', corrected);
  for (const uncertain of ['PILOT_TURN_FAILED', 'network', 'PILOT_OBJECT_UNREGISTERED']) {
    code = uncertain;
    status = uncertain === 'PILOT_OBJECT_UNREGISTERED' ? 502 : 422;
    await assert.rejects(send(corrected), (error) => !releaseRejectedPilotTurn(storage, 'dono', corrected, error));
    assert.deepEqual(loadPendingTurn(storage, 'dono', corrected.campaignId), corrected);
  }
  const reloaded = makeStorage(entries);
  const pending = loadPendingTurn(reloaded, 'dono', corrected.campaignId)!;
  status = 200;
  const receipt = await send(pending);
  assert.equal(receipt.turnId, corrected.turnId);
  assert.equal(receipt.mode, 'replay');
  clearPendingTurn(reloaded, 'dono', pending);
  assert.equal(loadPendingTurn(storage, 'dono', corrected.campaignId), null);
});
