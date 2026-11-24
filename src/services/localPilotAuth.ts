import { signOut, type Auth, type User } from 'firebase/auth';

const invalidSessionCodes = new Set([
  'auth/invalid-refresh-token',
  'auth/invalid-user-token',
  'auth/user-token-expired',
  'auth/user-not-found',
  'auth/user-disabled',
]);

export class LocalPilotSessionError extends Error {
  constructor(invalid: boolean, cause?: unknown) {
    super(invalid
      ? 'A sessão do piloto expirou ou pertence a outra execução. Entre com a conta local exibida no PowerShell.'
      : 'Não foi possível verificar a sessão no Auth Emulator. Confira se o piloto está rodando e tente entrar novamente.',
    { cause });
    this.name = 'LocalPilotSessionError';
  }
}

export async function confirmLocalPilotSession(auth: Auth, user: User): Promise<void> {
  if (auth.currentUser !== user) throw new LocalPilotSessionError(true);
  try {
    // A cached ID token can remain usable in the SDK after the emulator loses its accounts.
    await user.getIdToken(true);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    const invalid = typeof code === 'string' && invalidSessionCodes.has(code);
    if (invalid && auth.currentUser === user) await signOut(auth);
    throw new LocalPilotSessionError(invalid, error);
  }
  if (auth.currentUser !== user) throw new LocalPilotSessionError(true);
}
