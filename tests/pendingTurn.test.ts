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
