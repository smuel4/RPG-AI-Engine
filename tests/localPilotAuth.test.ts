import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { deleteApp, initializeApp } from 'firebase/app';

// Run the installed emulator's Auth operations in memory. Only the HTTP transport is stubbed.
const require = createRequire(import.meta.url);
const { AgentProjectState } = require('firebase-tools/lib/emulator/auth/state.js');
const { authOperations } = require('firebase-tools/lib/emulator/auth/operations.js');

test('reiniciar Auth invalida o refresh de conta antiga e exige novo login antes da gravação', async (t) => {
  const project = 'demo-rpg-ai-engine';
  const endpoint = 'http://127.0.0.1:19099';
  let emulator = new AgentProjectState(project);
  let connectionAvailable = true;
  const accounts = authOperations.identitytoolkit.accounts;
  const provision = async (email: string) => {
    const password = crypto.randomUUID();
    await accounts.signUp(emulator, { email, password, emailVerified: true }, { security: { Oauth2: true } });
    return { email, password };
  };
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const { origin, pathname } = new URL(input);
    assert.equal(origin, endpoint);
    try {
      if (pathname.endsWith('/accounts:signInWithPassword')) {
        return Response.json(await accounts.signInWithPassword(emulator, JSON.parse(String(init.body))));
      }
      if (pathname.endsWith('/accounts:lookup')) {
        return Response.json(await accounts.lookup(emulator, JSON.parse(String(init.body)), {}));
      }
      if (pathname.endsWith('/v1/token')) {
        if (!connectionAvailable) return Response.json({ error: { message: 'NETWORK_REQUEST_FAILED' } }, { status: 503 });
        const body = new URLSearchParams(String(init.body));
        return Response.json(authOperations.securetoken.token(emulator, {
          grantType: body.get('grant_type'), refreshToken: body.get('refresh_token'),
        }));
      }
      assert.fail('Requisição de Auth inesperada: ' + pathname);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 400) throw error;
      return Response.json({ error: { message: error.message } }, { status: 400 });
    }
  });
  // The Node SDK captures the active fetch implementation during import.
  const { connectAuthEmulator, initializeAuth, inMemoryPersistence, signInWithEmailAndPassword } = await import('firebase/auth');
  const { confirmLocalPilotSession, LocalPilotSessionError } = await import('../src/services/localPilotAuth');
  const app = initializeApp({ apiKey: 'demo', projectId: project, appId: 'freixo-test' }, 'local-pilot-auth-test');
  t.after(() => deleteApp(app));
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  connectAuthEmulator(auth, endpoint, { disableWarnings: true });

  const signIn = async (email: string) => {
    const credentials = await provision(email);
    return (await signInWithEmailAndPassword(auth, credentials.email, credentials.password)).user;
  };
  const oldUser = await signIn('primeiro-piloto@example.test');
  let writes = 0;
  const guardedWrite = async (user: typeof oldUser) => {
    await confirmLocalPilotSession(auth, user);
    writes++;
  };
  await guardedWrite(oldUser);
  connectionAvailable = false;
  await assert.rejects(guardedWrite(oldUser), /Confira se o piloto está rodando/);
  assert.equal(auth.currentUser, oldUser);
  connectionAvailable = true;
  emulator = new AgentProjectState(project);
  // The SDK can still return its cached ID token after the emulator has lost this user.
  assert.ok(await oldUser.getIdToken());
  await assert.rejects(guardedWrite(oldUser), (error) =>
    error instanceof LocalPilotSessionError && (error.cause as { code?: string })?.code === 'auth/invalid-refresh-token');
  assert.equal(writes, 1);
  assert.equal(auth.currentUser, null);

  const newUser = await signIn('segundo-piloto@example.test');
  await assert.rejects(guardedWrite(oldUser), LocalPilotSessionError);
  assert.equal(auth.currentUser, newUser);
  await guardedWrite(newUser);
  assert.equal(writes, 2);
});
