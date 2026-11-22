import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, GoogleAuthProvider, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDocFromServer, getFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { localEmulatorPort } from './localEmulatorPort';
import type { PersistenceErrorState } from '../types/game';

const browser = typeof window !== 'undefined';
export const localFreixo = import.meta.env?.VITE_FREIXO_LOCAL === 'true';
if (localFreixo && window.location.hostname !== '127.0.0.1') {
  throw new Error('Freixo local só pode abrir em 127.0.0.1.');
}
const app = localFreixo || !browser ? initializeApp({
  apiKey: 'demo', projectId: 'demo-rpg-ai-engine', appId: 'freixo-local',
}, 'freixo-local') : initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
if (localFreixo) {
  const firestorePort = localEmulatorPort(import.meta.env.VITE_FIRESTORE_EMULATOR_PORT, 8080, 'VITE_FIRESTORE_EMULATOR_PORT');
  const authPort = localEmulatorPort(import.meta.env.VITE_AUTH_EMULATOR_PORT, 9099, 'VITE_AUTH_EMULATOR_PORT');
  connectFirestoreEmulator(db, '127.0.0.1', firestorePort);
  connectAuthEmulator(auth, `http://127.0.0.1:${authPort}`);
}
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

function tryParseFirestoreErrorInfo(raw: string): FirestoreErrorInfo | null {
  try {
    const parsed = JSON.parse(raw) as Partial<FirestoreErrorInfo>;
    if (parsed && typeof parsed.error === 'string' && 'operationType' in parsed) {
      return parsed as FirestoreErrorInfo;
    }
    return null;
  } catch {
    return null;
  }
}

export function formatPersistenceError(
  error: unknown,
  fallbackTitle = 'Falha ao salvar no Cloud Firestore',
): PersistenceErrorState {
  const raw = error instanceof Error ? error.message : String(error);
  const parsed = tryParseFirestoreErrorInfo(raw);
  const underlyingMessage = parsed?.error ?? raw;

  const diagnosticParts: string[] = [];
  if (parsed?.operationType) {
    diagnosticParts.push(`operação: ${parsed.operationType}`);
  }
  if (parsed?.path) {
    diagnosticParts.push(`caminho: ${parsed.path}`);
  }
  if (parsed?.authInfo) {
    diagnosticParts.push(
      `uid: ${parsed.authInfo.userId ?? 'não autenticado'} (verificado: ${String(
        parsed.authInfo.emailVerified ?? false,
      )})`,
    );
  }
  const diagnosticSuffix =
    diagnosticParts.length > 0 ? ` [${diagnosticParts.join(' · ')}]` : '';

  if (
    underlyingMessage.includes('CONCURRENT_REVISION_CONFLICT') ||
    underlyingMessage.includes('CONCURRENT_STATE_CONFLICT')
  ) {
    return {
      title: 'Conflito de revisão concorrente',
      message: `${underlyingMessage.replace(/^CONCURRENT_(REVISION|STATE)_CONFLICT:\s*/i, '')} Nenhuma alteração parcial foi aplicada.${diagnosticSuffix}`,
      code: 'aborted',
      retryable: true,
    };
  }

  if (underlyingMessage.includes('ATOMIC_LIMIT_EXCEEDED')) {
    return {
      title: 'Limite atômico da restauração excedido',
      message: `${underlyingMessage.replace(/^ATOMIC_LIMIT_EXCEEDED:\s*/i, '')}${diagnosticSuffix}`,
      code: 'failed-precondition',
      retryable: false,
    };
  }

  if (underlyingMessage.includes('Quota exceeded')) {
    return {
      title: 'Cota do Firestore atingida',
      message: `O limite diário gratuito de leitura/escrita do Firestore foi excedido. A operação não foi salva.${diagnosticSuffix}`,
      code: 'resource-exhausted',
      retryable: false,
    };
  }

  if (
    underlyingMessage.includes('Missing or insufficient permissions') ||
    underlyingMessage.includes('permission-denied')
  ) {
    const unverifiedHint =
      parsed?.authInfo && parsed.authInfo.emailVerified === false
        ? ' Sua conta não possui e-mail verificado no token de autenticação.'
        : '';

    return {
      title: 'Permissão negada na persistência',
      message: `O Cloud Firestore recusou a gravação pelas regras de segurança ou autenticação.${unverifiedHint} Nenhuma alteração foi salva.${diagnosticSuffix}`,
      code: 'permission-denied',
      retryable: true,
    };
  }

  if (
    underlyingMessage.includes('the client is offline') ||
    underlyingMessage.includes('unavailable') ||
    underlyingMessage.includes('network')
  ) {
    return {
      title: 'Sem conexão com o Cloud Firestore',
      message: `Não foi possível alcançar o servidor do Firestore. Verifique sua conexão e tente novamente.${diagnosticSuffix}`,
      code: 'unavailable',
      retryable: true,
    };
  }

  return {
    title: fallbackTitle,
    message: `Não foi possível confirmar a gravação dos dados no banco de dados (${underlyingMessage}). O estado local não foi alterado.${diagnosticSuffix}`,
    code: 'firestore-error',
    retryable: true,
  };
}

let connectionTested = false;

export async function testFirestoreConnection(): Promise<boolean> {
  if (connectionTested) return true;
  connectionTested = true;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration: client is offline.');
      return false;
    }
    return true;
  }
}

if (browser) void testFirestoreConnection();
