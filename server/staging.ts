import { createHash, createPrivateKey } from 'node:crypto';
import { stagingWebConfig, STAGING_PROJECT_ID } from '../src/engine/stagingConfig';

export function stagingBuildTag(env: Record<string, string | undefined>) {
  const web = stagingWebConfig(env);
  if (web) return createHash('sha256').update(JSON.stringify(web)).digest('hex');
}

export function readStagingConfig(env: Record<string, string | undefined>) {
  const web = stagingWebConfig(env);
  if (!web) {
    if ((env.VITE_FREIXO_STAGING !== undefined && env.VITE_FREIXO_STAGING !== 'false') ||
        env.STAGING_SERVICE_ACCOUNT_JSON || env.STAGING_OWNER_UID || env.STAGING_CLARIFICATION_KEY ||
        env.VITE_STAGING_PROJECT_ID || env.VITE_STAGING_API_KEY || env.VITE_STAGING_APP_ID ||
        env.VITE_STAGING_CHECKPOINTS === 'true' ||
        env.FIREBASE_PROJECT_ID === STAGING_PROJECT_ID ||
        // Legacy staging names still fail closed instead of falling through to general mode.
        env.FIREBASE_PROJECT_ID?.startsWith('echo-arc-staging-')) {
      throw new Error('Configuração de staging sem VITE_FREIXO_STAGING=true.');
    }
    return undefined;
  }
  if (env.NODE_ENV !== 'production' || env.NARRATOR_MODE !== 'fixed' ||
      env.FIREBASE_PROJECT_ID !== web.projectId || env.FIRESTORE_DATABASE_ID !== '(default)' ||
      ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'VITE_FIRESTORE_EMULATOR_PORT',
        'VITE_AUTH_EMULATOR_PORT', 'GOOGLE_APPLICATION_CREDENTIALS', 'GROQ_API_KEY', 'GEMINI_API_KEY',
        'TURN_PLAN_SERVER_COMMIT', 'TURN_PLAN_PILOT_CATALOG', 'TURN_PLAN_PILOT_CAMPAIGN']
        .some((name) => Boolean(env[name]))) {
    throw new Error('Staging exige produção, narrador fixo e Firebase separado sem variáveis de emulador ou de IA.');
  }
  const ownerUid = env.STAGING_OWNER_UID ?? '';
  const key = env.STAGING_CLARIFICATION_KEY ?? '';
  if (!/^[\w-]{1,128}$/u.test(ownerUid) || !/^[a-f0-9]{64}$/iu.test(key)) {
    throw new Error('UID ou chave de esclarecimento do staging ausente ou inválida.');
  }
  try {
    const account = JSON.parse(env.STAGING_SERVICE_ACCOUNT_JSON ?? '');
    if (account.type !== 'service_account' || account.project_id !== web.projectId ||
        typeof account.client_email !== 'string' || !account.client_email.endsWith('@' + web.projectId + '.iam.gserviceaccount.com') ||
        createPrivateKey(account.private_key).asymmetricKeyType !== 'rsa') throw new Error();
    return { web, ownerUid, clarificationKey: Buffer.from(key, 'hex'),
      credential: { projectId: web.projectId, clientEmail: account.client_email as string, privateKey: account.private_key as string } };
  } catch {
    throw new Error('Credencial administrativa do staging ausente ou incompatível com o projeto.');
  }
}

export function permitsStagingPlayer(token: { uid: string; aud: string; email_verified?: boolean }, projectId: string, ownerUid: string) {
  return token.uid === ownerUid && token.aud === projectId && token.email_verified === true;
}
