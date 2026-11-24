export const STAGING_PROJECT_ID = 'echo-ark-staging';

export function stagingWebConfig(env: Record<string, string | undefined>) {
  if (env.VITE_FREIXO_STAGING !== 'true') return undefined;
  const projectId = env.VITE_STAGING_PROJECT_ID ?? '';
  const apiKey = env.VITE_STAGING_API_KEY ?? '';
  const appId = env.VITE_STAGING_APP_ID ?? '';
  if (env.VITE_FREIXO_LOCAL === 'true' || projectId !== STAGING_PROJECT_ID ||
      !/^AIza[\w-]{35}$/u.test(apiKey) || !/^1:\d+:web:[a-f0-9]+$/u.test(appId)) {
    throw new Error('Configuração pública de staging ausente ou inválida.');
  }
  return { projectId, apiKey, appId, authDomain: projectId + '.firebaseapp.com' };
}
