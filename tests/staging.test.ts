import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { permitsStagingPlayer, readStagingConfig, stagingBuildTag } from '../server/staging';
import { issuePilotClarification, readPilotClarification } from '../server/pilotClarification';
import { SERVER_PILOT_ID } from '../src/engine/pilotCampaign';
import { stagingWebConfig } from '../src/engine/stagingConfig';

const project = 'echo-ark-staging';
const ownerUid = 'testador';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = {
  VITE_FREIXO_STAGING: 'true', NODE_ENV: 'production', NARRATOR_MODE: 'fixed',
  FIREBASE_PROJECT_ID: project, FIRESTORE_DATABASE_ID: '(default)', VITE_STAGING_PROJECT_ID: project,
  VITE_STAGING_API_KEY: 'AIza' + 'x'.repeat(35), VITE_STAGING_APP_ID: '1:123:web:abc',
  STAGING_OWNER_UID: ownerUid, STAGING_CLARIFICATION_KEY: 'ab'.repeat(32),
  STAGING_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', project_id: project,
    client_email: 'staging@' + project + '.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
};

test('staging falha fechado e preserva o modo de emulador existente', () => {
  assert.equal(readStagingConfig({ VITE_FREIXO_LOCAL: 'true', FIREBASE_PROJECT_ID: 'demo-rpg-ai-engine' }), undefined);
  assert.equal(readStagingConfig({}), undefined);
  assert.equal(readStagingConfig(env)?.web.projectId, project);
  assert.equal(stagingWebConfig(env)?.authDomain, 'echo-ark-staging.firebaseapp.com');
  for (const id of [project, 'echo-arc-staging-teste']) {
    assert.throws(() => readStagingConfig({ FIREBASE_PROJECT_ID: id }));
  }
  for (const id of ['echo-arc-staging-teste', 'echo-ark-staging-extra', 'echo-ark-stagin', 'demo-rpg-ai-engine', 'outro-projeto']) {
    const alternate = { ...env, FIREBASE_PROJECT_ID: id, VITE_STAGING_PROJECT_ID: id,
      STAGING_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...JSON.parse(env.STAGING_SERVICE_ACCOUNT_JSON),
        project_id: id, client_email: 'staging@' + id + '.iam.gserviceaccount.com' }) };
    assert.throws(() => stagingWebConfig(alternate));
    assert.throws(() => readStagingConfig(alternate));
  }
  assert.match(stagingBuildTag(env)!, /^[a-f0-9]{64}$/u);
  assert.notEqual(stagingBuildTag({ ...env, VITE_STAGING_APP_ID: '1:123:web:def' }), stagingBuildTag(env));
  for (const change of [
    { VITE_FREIXO_STAGING: undefined }, { VITE_FREIXO_LOCAL: 'true' }, { NODE_ENV: 'development' },
    { VITE_STAGING_PROJECT_ID: 'demo-rpg-ai-engine' }, { FIREBASE_PROJECT_ID: 'outro' },
    { FIRESTORE_DATABASE_ID: 'outro' }, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' },
    { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }, { NARRATOR_MODE: 'gemini' },
    { GROQ_API_KEY: 'proibida' }, { STAGING_OWNER_UID: undefined }, { STAGING_SERVICE_ACCOUNT_JSON: '{}' },
    { STAGING_CLARIFICATION_KEY: undefined }, { VITE_STAGING_API_KEY: undefined },
  ]) assert.throws(() => readStagingConfig({ ...env, ...change }));
});

test('staging aceita somente o UID verificado do projeto e mantém esclarecimento entre instâncias', () => {
  const claims = { aud: project, uid: ownerUid, email_verified: true };
  assert.ok(permitsStagingPlayer(claims, project, ownerUid));
  for (const change of [{ aud: 'outro' }, { uid: 'outra-pessoa' }, { email_verified: false }]) {
    assert.equal(permitsStagingPlayer({ ...claims, ...change }, project, ownerUid), false);
  }
  const turn = { campaignId: SERVER_PILOT_ID, turnId: 'turno-sintetico', declaredAction: 'Observo.',
    advanceMinutes: 0, expectedRevision: 1, baseTimelineId: 'tl_root' };
  const token = issuePilotClarification(ownerUid, turn, 'Observo', readStagingConfig(env)?.clarificationKey);
  assert.equal(readPilotClarification(ownerUid, turn, token, readStagingConfig(env)?.clarificationKey), 'Observo');
  assert.equal(readPilotClarification('outro', turn, token, readStagingConfig(env)?.clarificationKey), undefined);
  assert.equal(readPilotClarification(ownerUid, { ...turn, expectedRevision: 2 }, token,
    readStagingConfig(env)?.clarificationKey), undefined);
});
