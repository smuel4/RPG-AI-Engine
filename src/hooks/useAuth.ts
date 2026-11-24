import { useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { auth, googleProvider, localFreixo } from '../services/firebaseClient';
import { confirmLocalPilotSession, LocalPilotSessionError } from '../services/localPilotAuth';

export interface AuthState {
  user: User | null;
  loading: boolean;
  authError: string | null;
  signInWithGoogle: () => Promise<void>;
  signInWithLocalAccount: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  clearAuthError: () => void;
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(
      auth,
      (nextUser) => {
        // Local email login publishes the user only after a refresh against the emulator.
        if (localFreixo && nextUser) return;
        setUser(nextUser);
        setLoading(false);
      },
      (err) => {
        setAuthError(
          err instanceof Error
            ? `Erro ao verificar sessão: ${err.message}`
            : 'Erro ao verificar sessão de autenticação.',
        );
        setLoading(false);
      },
    );
    return () => unsub();
  }, []);

  const signInWithLocalAccount = async (email: string, password: string) => {
    if (!localFreixo) return;
    setAuthError(null);
    setLoading(true);
    try {
      const { user: signedIn } = await signInWithEmailAndPassword(auth, email, password);
      await confirmLocalPilotSession(auth, signedIn);
      setUser(signedIn);
    } catch (error) {
      setAuthError(error instanceof LocalPilotSessionError ? error.message : 'Use a conta local exibida no PowerShell.');
    } finally {
      setLoading(false);
    }
  };

  const signInWithGoogle = async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      const code = (error as { code?: string })?.code ?? '';
      if (code === 'auth/popup-closed-by-user') {
        setAuthError('A janela de login do Google foi fechada antes da conclusão.');
      } else if (code === 'auth/popup-blocked') {
        setAuthError(
          'O navegador bloqueou o pop-up de login. Permita pop-ups para este site e tente novamente.',
        );
      } else if (code === 'auth/unauthorized-domain') {
        setAuthError(
          'Domínio não autorizado no Firebase Authentication. Adicione este domínio em Auth > Settings > Authorized domains.',
        );
      } else {
        setAuthError(
          error instanceof Error
            ? `Falha ao autenticar com o Google: ${error.message}`
            : 'Não foi possível concluir o login com o Google.',
        );
      }
    }
  };

  const logout = async () => {
    setAuthError(null);
    try {
      await signOut(auth);
    } catch (error) {
      setAuthError(
        error instanceof Error ? `Erro ao sair: ${error.message}` : 'Falha ao encerrar sessão.',
      );
    }
  };

  return {
    user,
    loading,
    authError,
    signInWithGoogle,
    signInWithLocalAccount,
    logout,
    clearAuthError: () => setAuthError(null),
  };
}
