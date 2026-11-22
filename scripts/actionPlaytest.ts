import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DocumentReference } from 'firebase-admin/firestore';
import { NarratorRequestError, requestNarratorTurn } from '../src/services/narratorClient';

const categories = ['Revisar', 'Ação existente e reconhecida', 'Expressão não reconhecida para ação existente',
  'Condição legítima do mundo', 'Intenção sem mecânica', 'Comando ambíguo ou insuficiente'];
const mechanics = new Set(['travel', 'observation', 'speech', 'wait', 'activity', 'organize', 'open-close',
  'pickup', 'drop', 'delivery', 'store', 'retrieve', 'sequence']);

function classify(goal: string, plan: string | undefined, code: string | undefined, clarification: boolean) {
  if (plan) return plan === goal ? 1 : 0;
  if (goal === '?' || clarification || code?.endsWith('_AMBIGUOUS')) return 5;
  if (code === 'PILOT_ACTION_UNSUPPORTED') return goal === '-' ? 4 : 2;
  if (goal !== '-' && /^PILOT_(?:STORAGE_(?:CLOSED|EMPTY|DISTANT)|OBJECT_(?:NOT_HELD|ALREADY_HELD|OUT_OF_REACH|OWNED|FIXED)|OPEN_CLOSE_ALREADY_SET|ENVIRONMENT_ALREADY_ORGANIZED|FACTUAL_NPC_OCCUPIED)$/.test(code ?? '')) return 3;
  return 0;
}

async function snapshot(ref: DocumentReference) {
  const campaign = (await ref.get()).data()!;
  const collections = await ref.listCollections();
  const entries = await Promise.all(collections.map(async collection =>
    [collection.id, (await collection.get()).docs.map(d => ({ id: d.id, data: d.data() }))] as const));
  return { campaign, docs: Object.fromEntries(entries) };
}

export async function collectPlaytest(ref: DocumentReference, token: string) {
  const output = process.env.ECHO_PLAYTEST_OUTPUT!;
  const lines = (await readFile(process.env.ECHO_PLAYTEST_INPUT!, 'utf8')).replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
  assert.ok(lines.length >= 1 && lines.length <= 60, 'Use de 1 a 60 linhas.');
  const attempts = lines.map((line, i) => {
    const [goal, command, extra] = line.split('\t');
    assert.ok((mechanics.has(goal) || goal === '-' || goal === '?') && command?.trim() && command.length <= 500 && extra === undefined,
      'Objetivo ou comando inválido na linha ' + (i + 1));
    return { goal, command };
  });
  const groups = categories.map(() => [] as string[]);
  for (const [index, { goal, command }] of attempts.entries()) {
    const before = await snapshot(ref);
    const { currentLocation: location, worldTime, revision, activeTimelineId } = before.campaign;
    const id = randomUUID();
    let code: string | undefined;
    let clarification = false;
    try {
      await requestNarratorTurn(token, { campaignId: ref.id, declaredAction: command, advanceMinutes: 10,
        turn: { turnId: id, expectedRevision: revision, baseTimelineId: activeTimelineId ?? 'tl_root' } });
    } catch (error) {
      if (!(error instanceof NarratorRequestError) || !error.gameplayFeedback || !error.code) throw error;
      code = error.code;
      clarification = Boolean(error.clarificationToken);
    }
    const after = await snapshot(ref);
    const receipt = after.docs.turnReceipts?.find(d => d.id === id)?.data;
    if (code) {
      // Avoid printing Firestore documents (including player text) on failure.
      assert.ok(isDeepStrictEqual(before, after), 'Recusa com alteração persistida na linha ' + (index + 1));
    } else {
      assert.ok(after.campaign.revision === revision + 1 && receipt?.resolution?.completed === true,
        'Aceite sem revisão e recibo correspondentes na linha ' + (index + 1));
    }
    const plan: string | undefined = receipt?.plan?.kind ?? receipt?.plan?.intent?.kind;
    const collections = new Set([...Object.keys(before.docs), ...Object.keys(after.docs)]);
    const changed = [...collections].filter(name => !isDeepStrictEqual(before.docs[name], after.docs[name]));
    const category = classify(goal, plan, code, clarification);
    const record = { linha: index + 1, comando: command, objetivo: goal, local: location, horario: worldTime,
      presentes: before.docs.npcs?.filter(d => d.data.location === location).map(d => d.data.name),
      inventario: before.docs.inventory?.map(d => d.data.name) ?? [],
      abertos: before.docs.npcRoutineState?.find(d => d.id === activeTimelineId)?.data.openObjects ?? [],
      revisaoAntes: revision, revisaoDepois: after.campaign.revision, plano: plan ?? null,
      resultado: code ?? 'CONFIRMADO', efeitoConfirmado: Boolean(receipt), colecoesAlteradas: changed,
      destino: receipt?.outcome?.location ?? null, minutos: receipt?.outcome?.elapsedMinutes ?? null, categoria: category,
      reconhecida: category === 1 || category === 3 ? true : category === 2 || category === 4 ? false : null };
    await appendFile(join(output, 'tentativas.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
    groups[category].push(`  ${index + 1}. ${command} — ${code ?? plan} | ${location} | r${revision} → r${after.campaign.revision}`);
  }
  const report = [1, 2, 3, 4, 5, 0].map(i => [`${i}. ${categories[i]} (${groups[i].length})`, ...groups[i]].join('\n'));
  await writeFile(join(output, 'relatorio.txt'), report.join('\n\n') + '\n', { mode: 0o600 });
  console.info('Tentativas por categoria:', Object.fromEntries(categories.map((label, i) => [label, groups[i].length])));
}
