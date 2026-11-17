/**
 * Teste de infraestrutura das regras do Firestore no Emulator local.
 * NÃO conecta ao Firebase de produção e NÃO altera o código do RPG.
 * Este primeiro teste valida somente que as regras são carregadas e negam
 * acesso não autenticado. O teste específico do checkpoint virá depois.
 *
 * Pré-requisito: firebase emulators:start --only firestore --project demo-rpg-ai-engine
 * Execução: npx.cmd tsx --test tests/firestoreRulesOfficial.test.ts
 */
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc } from 'firebase/firestore';

const PROJECT_ID = 'demo-rpg-ai-engine';
const EMULATOR_HOST = '127.0.0.1';
const EMULATOR_PORT = 8080;

test('Firestore Emulator: bloqueia leitura de campanha sem autenticação', async () => {
  const rules = readFileSync('firestore.rules', 'utf8');
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: EMULATOR_HOST,
      port: EMULATOR_PORT,
      rules,
    },
  });

  try {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'campaigns', 'campanha_de_teste')));
  } finally {
    await env.cleanup();
  }
});
