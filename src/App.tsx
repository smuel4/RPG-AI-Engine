import { useEffect, useState } from 'react';
import { FolderPlus, Sparkles } from 'lucide-react';
import { useAuth } from './hooks/useAuth';
import { DevAuthProbe } from './components/DevAuthProbe';
import {
  buildCheckpointPayload,
  classifyEventsForAudit,
  classifyNarrativeEntriesForAudit,
  getActiveTimelineId,
  processCurrencyMutation,
  processInventoryMutation,
  processPlayerAction,
  processTimeAdvance,
  validateCustomCampaignDraft,
  type InventoryMutationCommand,
} from './engine/rulesEngine';
import {
  createCustomCampaignBundle,
  createEchoArcBundle,
  type CustomCampaignDraft,
} from './engine/echoArcFixture';
import {
  commitCurrencyMutation,
  commitInventoryMutation,
  commitPlayerAction,
  commitPlayerActionTransaction,
  commitTimeAdvance,
  createCampaignBundle,
  deleteCampaignWithSubcollections,
  restoreCheckpoint,
  saveCheckpoint,
  subscribeCampaignDetails,
  subscribeUserCampaigns,
  testPersistenceFailure,
} from './services/campaignRepository';
import { NarratorRequestError, requestNarratorTurn, requestPilotScene } from './services/narratorClient';
import type { PilotScene } from './types/game';
import { clearPendingTurn, loadPendingTurn, releaseRejectedPilotTurn, savePendingTurn, type PendingTurn } from './services/pendingTurn';
import { checkTurnRevision } from './engine/turnIdentity';
import { selectOwnedCampaignId, SERVER_PILOT_ID } from './engine/pilotCampaign';
import { formatPersistenceError, localFreixo, stagingFreixo } from './services/firebaseClient';
import type {
  Campaign,
  Checkpoint,
  Currency,
  GameEvent,
  InventoryItem,
  NarrativeEntry,
  NpcRecord,
  PersistenceErrorState,
  SyncState,
} from './types/game';
import { AuthScreen } from './components/AuthScreen';
import { TopBar } from './components/TopBar';
import { ErrorBanner } from './components/ErrorBanner';
import { CharacterPanel } from './components/CharacterPanel';
import { InventoryPanel } from './components/InventoryPanel';
import { NarrativeStage } from './components/NarrativeStage';
import { WorldSidebar } from './components/WorldSidebar';
import { CampaignHubModal } from './components/CampaignHubModal';
import { CheckpointModal } from './components/CheckpointModal';

const restrictedPilot = localFreixo || stagingFreixo;

type MobileTab = 'narrative' | 'character' | 'world';

function readCampaignIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return params.get('campaign');
}

function writeCampaignIdToUrl(campaignId: string | null) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (campaignId) {
    url.searchParams.set('campaign', campaignId);
  } else {
    url.searchParams.delete('campaign');
  }
  window.history.replaceState({}, '', url.toString());
}

function readPendingTurn(ownerId: string, campaignId: string): PendingTurn | null {
  try {
    return loadPendingTurn(window.sessionStorage, ownerId, campaignId);
  } catch {
    return null;
  }
}

export default function App() {
  const { user, loading: authLoading, authError, signInWithGoogle, signInWithLocalAccount, logout, clearAuthError } =
    useAuth();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignsLoaded, setCampaignsLoaded] = useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(() =>
    restrictedPilot ? null : readCampaignIdFromUrl(),
  );

  const [activeCampaign, setActiveCampaign] = useState<Campaign | null>(null);
  const [sceneSnapshot, setSceneSnapshot] = useState<{ ownerId: string; scene: PilotScene } | null>(null);
  const pilotCampaign = restrictedPilot && activeCampaign?.id === SERVER_PILOT_ID;
  const pilotRevision = pilotCampaign ? activeCampaign.revision : undefined;
  const pilotTimeline = pilotCampaign ? getActiveTimelineId(activeCampaign) : undefined;
  const scene = sceneSnapshot && sceneSnapshot.ownerId === user?.uid &&
    sceneSnapshot.scene.revision === pilotRevision && sceneSnapshot.scene.timelineId === pilotTimeline &&
    sceneSnapshot.scene.location === activeCampaign?.currentLocation ? sceneSnapshot.scene : undefined;
  const showDiagnostics = import.meta.env.DEV && !restrictedPilot;

  useEffect(() => {
    if (!user || pilotRevision === undefined) return;
    const controller = new AbortController();
    void user.getIdToken().then((token) => requestPilotScene(token, controller.signal))
      .then((scene) => {
        if (!controller.signal.aborted) setSceneSnapshot({ ownerId: user.uid, scene });
      }).catch(() => {
        if (!controller.signal.aborted) setSceneSnapshot(null);
      });
    return () => controller.abort();
  }, [user, pilotRevision, pilotTimeline]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [npcs, setNpcs] = useState<NpcRecord[]>([]);
  const [narrative, setNarrative] = useState<NarrativeEntry[]>([]);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);

  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [isMutating, setIsMutating] = useState(false);
  const [errorState, setErrorState] = useState<PersistenceErrorState | string | null>(null);
  const [lastFailedAction, setLastFailedAction] = useState<(() => Promise<void>) | null>(null);
  const [conflictingTurnId, setConflictingTurnId] = useState<string | null>(null);
  const [clarification, setClarification] = useState<{ ownerId: string; turn: PendingTurn; message: string } | null>(null);
  const [gameplayFeedback, setGameplayFeedback] = useState<{ ownerId: string; campaignId: string; message: string } | null>(null);
  const pendingTurn = user?.emailVerified && activeCampaign?.ownerId === user.uid &&
    activeCampaign.id === selectedCampaignId ? readPendingTurn(user.uid, activeCampaign.id) : null;
  const activeClarification = clarification?.ownerId === user?.uid &&
    clarification?.turn.campaignId === selectedCampaignId ? clarification : null;

  const [mobileTab, setMobileTab] = useState<MobileTab>('narrative');
  const [campaignHubOpen, setCampaignHubOpen] = useState(false);
  const [checkpointMode, setCheckpointMode] = useState<'save' | 'load' | null>(null);

  // Carrega a lista de campanhas da conta autenticada
  useEffect(() => {
    if (!user) {
      setCampaigns([]);
      setCampaignsLoaded(false);
      setActiveCampaign(null);
      setInventory([]);
      setNpcs([]);
      setNarrative([]);
      setEvents([]);
      setCheckpoints([]);
      return;
    }

    setCampaignsLoaded(false);
    const unsub = subscribeUserCampaigns(
      user.uid,
      (list) => {
        setCampaigns(list);
        setCampaignsLoaded(true);
        setSelectedCampaignId((prev) => {
          const next = selectOwnedCampaignId(list, prev, restrictedPilot);
          if (restrictedPilot || next !== prev) writeCampaignIdToUrl(next);
          return next;
        });
      },
      (err) => {
        setCampaignsLoaded(true);
        setSyncState('error');
        setErrorState(formatPersistenceError(err, 'Erro ao carregar campanhas'));
      },
    );

    return () => unsub();
  }, [user]);

  // Assina os dados estruturados completos somente após confirmar que a campanha pertence à conta
  useEffect(() => {
    const ownsSelected =
      campaignsLoaded &&
      Boolean(selectedCampaignId) &&
      campaigns.some((c) => c.id === selectedCampaignId);

    if (!user || !selectedCampaignId || !ownsSelected) {
      if (!selectedCampaignId) {
        setActiveCampaign(null);
        setInventory([]);
        setNpcs([]);
        setNarrative([]);
        setEvents([]);
        setCheckpoints([]);
      }
      return;
    }

    writeCampaignIdToUrl(selectedCampaignId);

    const unsub = subscribeCampaignDetails(selectedCampaignId, user.uid, {
      onCampaign: (c) => {
        setActiveCampaign(c);
        if (c) setSyncState((prev) => (prev === 'error' ? prev : 'synced'));
      },
      onInventory: setInventory,
      onNpcs: setNpcs,
      onNarrative: setNarrative,
      onEvents: setEvents,
      onCheckpoints: setCheckpoints,
      onError: (err) => {
        setSyncState('error');
        setErrorState(formatPersistenceError(err, 'Erro ao sincronizar campanha'));
      },
    });

    return () => unsub();
  }, [user, selectedCampaignId, campaignsLoaded, campaigns]);

  const executeMutation = async (
    task: () => Promise<void>,
    errorTitle: string,
    offerRetry = true,
    describeError?: (error: unknown) => PersistenceErrorState | null,
    showSavingInHeader = true,
  ): Promise<boolean> => {
    setErrorState(null);
    setLastFailedAction(null);
    setIsMutating(true);
    if (showSavingInHeader) setSyncState('saving');
    try {
      await task();
      setSyncState('synced');
      return true;
    } catch (err) {
      setSyncState('error');
      setErrorState(describeError ? describeError(err) : formatPersistenceError(err, errorTitle));
      if (offerRetry) setLastFailedAction(() => async () => {
        await executeMutation(task, errorTitle);
      });
      return false;
    } finally {
      setIsMutating(false);
    }
  };

  const handleCreateEchoArc = async () => {
    if (!user) return;
    const bundle = createEchoArcBundle(user.uid);
    const ok = await executeMutation(async () => {
      const id = await createCampaignBundle(bundle);
      setSelectedCampaignId(id);
      writeCampaignIdToUrl(id);
      setCampaignHubOpen(false);
    }, 'Falha ao criar campanha ECHO ARC');

    if (!ok) return;
  };

  const handleCreateCustomCampaign = async (draft: CustomCampaignDraft): Promise<boolean> => {
    if (!user) return false;
    const validation = validateCustomCampaignDraft(draft);
    if (!validation.ok) {
      setErrorState(validation.error);
      return false;
    }

    const bundle = createCustomCampaignBundle(user.uid, validation.data);
    return executeMutation(async () => {
      const id = await createCampaignBundle(bundle);
      setSelectedCampaignId(id);
      writeCampaignIdToUrl(id);
      setCampaignHubOpen(false);
    }, 'Falha ao criar campanha personalizada');
  };

  const handleDeleteCampaign = async (campaignId: string) => {
    if (!user) return;
    await executeMutation(async () => {
      await deleteCampaignWithSubcollections(campaignId, user.uid);
      if (selectedCampaignId === campaignId) {
        const remaining = campaigns.filter((c) => c.id !== campaignId);
        const nextId = remaining[0]?.id ?? null;
        setSelectedCampaignId(nextId);
        writeCampaignIdToUrl(nextId);
      }
    }, 'Falha ao excluir campanha');
  };

  const handlePlayerAction = async (
    actionText: string,
    advanceMinutes: number,
  ): Promise<boolean> => {
    if (!activeCampaign || !user?.emailVerified || activeCampaign.ownerId !== user.uid ||
        activeCampaign.id !== selectedCampaignId || (restrictedPilot && !pilotCampaign) || isMutating) return false;
    if (readPendingTurn(user.uid, activeCampaign.id)) {
      setErrorState('Retome o turno pendente antes de enviar outra ação nesta campanha.');
      return false;
    }
    const declaredAction = actionText.trim();
    if (!declaredAction || declaredAction.length > 800 ||
        !Number.isSafeInteger(advanceMinutes) || advanceMinutes < 0 || advanceMinutes > 720) {
      setErrorState('Informe uma ação de até 800 caracteres e uma duração de 0 a 720 minutos.');
      return false;
    }
    const identity: PendingTurn = activeClarification ? { ...activeClarification.turn, declaredAction } : {
      turnId: globalThis.crypto.randomUUID(),
      campaignId: activeCampaign.id,
      declaredAction,
      advanceMinutes,
      expectedRevision: activeCampaign.revision,
      baseTimelineId: activeCampaign.activeTimelineId || 'tl_root',
    };

    try {
      savePendingTurn(window.sessionStorage, user.uid, identity);
    } catch {
      setErrorState('Não foi possível guardar a identidade do turno nesta aba. A ação não foi enviada.');
      return false;
    }
    return submitPlayerTurn(identity);
  };

  const submitPlayerTurn = async (identity: PendingTurn): Promise<boolean> => {
    if (!activeCampaign || !user?.emailVerified || activeCampaign.ownerId !== user.uid ||
        activeCampaign.id !== identity.campaignId || selectedCampaignId !== identity.campaignId ||
        (restrictedPilot && !pilotCampaign) || isMutating ||
        readPendingTurn(user.uid, identity.campaignId)?.turnId !== identity.turnId) return false;
    const { declaredAction: actionText, advanceMinutes } = identity;
    setGameplayFeedback(null);
    return executeMutation(async () => {
      // 1. Obtém token autenticado do Firebase
      const token = await user.getIdToken();

      // 2. Solicita a narrativa oficial ao servidor seguro (contexto lido no Firestore do banco nomeado)
      const turn = await requestNarratorTurn(token, {
        campaignId: activeCampaign.id,
        declaredAction: actionText,
        advanceMinutes,
        turn: identity,
        clarificationToken: identity.clarificationToken,
      });
      if (turn.turnId !== identity.turnId || turn.expectedRevision !== identity.expectedRevision ||
          turn.baseTimelineId !== identity.baseTimelineId) throw new Error('TURN_ID_CONFLICT');
      if (turn.mode === 'replay') {
        clearPendingTurn(window.sessionStorage, user.uid, identity);
        if (identity.clarificationToken) setClarification(null);
        return;
      }
      if (restrictedPilot) throw new Error('O servidor do piloto não confirmou a gravação autoritativa do turno.');
      if (!checkTurnRevision(identity, activeCampaign)) {
        throw new Error('O estado exibido da campanha mudou. Aguarde a sincronização antes de retomar o turno.');
      }

      // 3. Aplica regras estruturadas locais com o texto narrativo oficial
      const rule = processPlayerAction(
        activeCampaign,
        inventory,
        npcs,
        actionText,
        advanceMinutes,
        turn.narration,
      );

      if (!rule.ok) {
        throw new Error(rule.error);
      }

      // 4. Confirmação transacional estrita (rejeita se revisão ou timeline divergirem da geração)
      await commitPlayerActionTransaction(
        activeCampaign.id,
        rule.data,
        turn.expectedRevision,
        turn.baseTimelineId,
        { turn: identity },
      );
      clearPendingTurn(window.sessionStorage, user.uid, identity);
    }, 'Falha ao registrar ação narrada', false, (error) => {
      if (restrictedPilot && releaseRejectedPilotTurn(window.sessionStorage, user.uid, identity, error)) {
        setConflictingTurnId(null);
        setSyncState('synced');
        const clarificationToken = error.clarificationToken ?? identity.clarificationToken;
        if (clarificationToken && ['PILOT_OBJECT_AMBIGUOUS', 'PILOT_OBJECT_OUT_OF_REACH',
          'PILOT_OBJECT_UNREGISTERED'].includes(error.code ?? '')) {
          setClarification({ ownerId: user.uid, turn: { ...identity, clarificationToken },
            message: error.message });
          return null;
        }
        if (identity.clarificationToken) {
          setClarification(null);
          return { title: 'Esclarecimento encerrado', message: error.message, retryable: false };
        }
        if (error.gameplayFeedback) {
          setGameplayFeedback({ ownerId: user.uid, campaignId: identity.campaignId, message: error.message });
          return null;
        }
        return { title: 'Ação recusada', message: error.message + ' Corrija a ação no campo de texto e envie novamente.', retryable: false };
      }
      if (identity.clarificationToken && error instanceof NarratorRequestError &&
          error.code === 'CONCURRENT_STATE_CONFLICT') {
        clearPendingTurn(window.sessionStorage, user.uid, identity);
        setClarification(null);
        return { title: 'Esclarecimento encerrado',
          message: 'O estado da campanha mudou. Envie uma nova ação.', retryable: false };
      }
      if (error instanceof NarratorRequestError &&
          (error.code === 'TURN_ID_CONFLICT' || error.code === 'CONCURRENT_STATE_CONFLICT')) {
        setConflictingTurnId(identity.turnId);
        return { title: 'Conflito de turno', message: 'O estado da campanha mudou. Confira o histórico antes de descartar a tentativa local.', retryable: false };
      }
      if (!restrictedPilot) return formatPersistenceError(error, 'Falha ao registrar ação narrada');
      return { title: 'Confirmação indisponível', message: 'Não foi possível verificar o resultado. Use Retomar turno para consultar ou reenviar a mesma ação.', retryable: false };
    }, false);
  };

  const handleInventoryMutation = async (
    command: InventoryMutationCommand,
  ): Promise<boolean> => {
    if (!activeCampaign || stagingFreixo) return false;
    const rule = processInventoryMutation(activeCampaign, inventory, command);
    if (!rule.ok) {
      setErrorState(rule.error);
      return false;
    }

    return executeMutation(
      () => commitInventoryMutation(activeCampaign.id, rule.data),
      'Falha ao salvar alteração de inventário',
    );
  };

  const handleCurrencyMutation = async (delta: Partial<Currency>) => {
    if (!activeCampaign || restrictedPilot) return;
    const rule = processCurrencyMutation(activeCampaign, delta);
    if (!rule.ok) {
      setErrorState(rule.error);
      return;
    }

    await executeMutation(
      () => commitCurrencyMutation(activeCampaign.id, rule.data),
      'Falha ao atualizar moedas estruturadas',
    );
  };

  const handleAdvanceTime = async (minutes: number) => {
    if (!activeCampaign || stagingFreixo) return;
    const rule = processTimeAdvance(activeCampaign, minutes);
    if (!rule.ok) {
      setErrorState(rule.error);
      return;
    }

    await executeMutation(
      () => commitTimeAdvance(activeCampaign.id, rule.data),
      'Falha ao avançar horário do mundo',
    );
  };

  const handleSaveCheckpoint = async (label: string, note: string): Promise<boolean> => {
    if (!activeCampaign || stagingFreixo) return false;
    const rule = buildCheckpointPayload(activeCampaign, inventory, npcs, label, note);
    if (!rule.ok) {
      setErrorState(rule.error);
      return false;
    }

    return executeMutation(
      () =>
        saveCheckpoint(
          activeCampaign.id,
          rule.data.checkpoint,
          rule.data.event,
          rule.data.nextRevision,
          rule.data.nextLastSequence,
          rule.data.expectedRevision,
        ),
      'Falha ao salvar ponto de controle',
    );
  };

  const handleRestoreCheckpoint = async (checkpoint: Checkpoint): Promise<boolean> => {
    if (!activeCampaign || stagingFreixo) return false;
    return executeMutation(
      () => restoreCheckpoint(activeCampaign, checkpoint, inventory, npcs),
      'Falha ao carregar ponto de controle',
    );
  };

  const handleTestPersistenceError = async () => {
    if (!showDiagnostics) return;
    setErrorState(null);
    setLastFailedAction(null);
    setIsMutating(true);
    setSyncState('saving');
    try {
      await testPersistenceFailure();
    } catch (err) {
      setSyncState('error');
      setErrorState(
        formatPersistenceError(
          err,
          'Teste de falha de salvamento confirmado',
        ),
      );
    } finally {
      setIsMutating(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#0B0D12] text-[#EDE8DC] flex items-center justify-center px-6">
        <p className="text-sm text-[#B7B2A6]">Verificando sessão autenticada...</p>
      </div>
    );
  }

  if (!user) {
    if (localFreixo) return (
      <main className="min-h-screen bg-[#0B0D12] text-[#EDE8DC] grid place-items-center p-6">
        <form className="grid w-full max-w-sm gap-4" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          setErrorState(null);
          void signInWithLocalAccount(String(form.get('email')), String(form.get('password')));
        }}>
          <h1 className="text-xl">Freixo local</h1>
          <label>E-mail local<input required name="email" type="email" className="block w-full border p-2" /></label>
          <label>Senha local<input required name="password" type="password" className="block w-full border p-2" /></label>
          {(authError || errorState) && <p role="alert">
            {authError ?? (typeof errorState === 'string' ? errorState : errorState?.message)}
          </p>}
          <button className="border p-2" type="submit">Entrar no piloto</button>
        </form>
      </main>
    );
    return (
      <AuthScreen
        loading={authLoading}
        authError={authError}
        onSignIn={() => void signInWithGoogle()}
        onClearError={clearAuthError}
      />
    );
  }

  return (
    <div className={(activeCampaign ? 'h-dvh overflow-hidden ' : 'min-h-screen ') + 'bg-[#0B0D12] text-[#EDE8DC] flex flex-col'}>
      {localFreixo && <p className="px-6 py-2 text-sm">Freixo local · Firebase emulado</p>}
      {stagingFreixo && <p className="px-6 py-2 text-sm">Freixo de testes. Checkpoints e restauração indisponíveis nesta versão.</p>}
      <TopBar
        campaignName={activeCampaign?.name ?? null}
        syncState={syncState}
        userEmail={user.email}
        hasCampaign={Boolean(activeCampaign)}
        onOpenSaveCheckpoint={stagingFreixo ? undefined : () => setCheckpointMode('save')}
        onOpenLoadCheckpoint={stagingFreixo ? undefined : () => setCheckpointMode('load')}
        onOpenCampaigns={restrictedPilot ? undefined : () => setCampaignHubOpen(true)}
        onSignOut={() => void logout()}
      />

      {/* Navegação mobile compacta */}
      {activeCampaign && (
        <div className="lg:hidden shrink-0 border-b border-white/10 bg-[#0E121A] px-3 py-2 space-y-2">
          <div className="grid grid-cols-3 gap-1 bg-[#0B0D12] p-1 rounded-lg">
            {(
              [
                { id: 'narrative', label: 'Narrativa' },
                { id: 'character', label: 'Personagem' },
                { id: 'world', label: 'Mundo & Log' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setMobileTab(tab.id)}
                aria-pressed={mobileTab === tab.id}
                className={`py-2 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  mobileTab === tab.id
                    ? 'bg-[#D4AF37] text-[#0B0D12] font-semibold'
                    : 'text-[#B7B2A6]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between gap-2 text-xs">
            {!stagingFreixo && <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCheckpointMode('save')}
                className="px-2.5 py-1 rounded border border-[#D4AF37]/30 text-[#F2E2B0] cursor-pointer"
              >
                Salvar
              </button>
              <button
                type="button"
                onClick={() => setCheckpointMode('load')}
                className="px-2.5 py-1 rounded border border-white/12 text-[#EDE8DC] cursor-pointer"
              >
                Carregar
              </button>
            </div>}
            <button
              type="button"
              onClick={() => void logout()}
              className="px-2.5 py-1 text-[#9CA3AF] hover:text-[#EDE8DC] cursor-pointer"
            >
              Sair
            </button>
          </div>
        </div>
      )}

      <main className={'flex-1 min-h-0 max-w-[1600px] w-full mx-auto px-2 py-2 lg:px-6 lg:py-5 ' +
        (activeCampaign ? 'flex flex-col gap-2 lg:gap-4' : 'space-y-4')}>
        {errorState && (
          <div className={activeCampaign ? 'max-h-[20dvh] shrink-0 overflow-y-auto' : undefined}>
            <ErrorBanner
              error={errorState}
              onDismiss={() => setErrorState(null)}
              onRetry={lastFailedAction ? () => void lastFailedAction() : undefined}
            />
          </div>
        )}

        {!campaignsLoaded ? (
          <div className="py-20 text-center text-sm text-[#B7B2A6]">
            Carregando campanhas persistidas no Cloud Firestore...
          </div>
        ) : !activeCampaign && restrictedPilot ? (
          <div className="py-20 text-center text-sm text-[#B7B2A6]">
            {selectedCampaignId ? <p>Abrindo a campanha piloto de Freixo...</p> : (
              <>
                <p>{stagingFreixo ? 'Campanha piloto indisponível nesta conta. Use a conta autorizada para staging.' : 'Campanha piloto indisponível nesta conta. Entre com a conta local exibida no PowerShell.'}</p>
                <button type="button" onClick={() => void logout()} className="mt-3 underline">Trocar conta</button>
              </>
            )}
          </div>
        ) : !activeCampaign ? (
          <div className="max-w-2xl mx-auto my-10 bg-[#121620] border border-[#D4AF37]/20 rounded-xl p-8 space-y-6">
            <div className="space-y-2">
              <p className="text-xs font-medium text-[#D4AF37]">
                CONTA AUTENTICADA · {user.email}
              </p>
              <h1 className="font-display text-2xl font-semibold text-[#F6E8B1] text-balance">
                Nenhuma campanha ativa selecionada
              </h1>
              <p className="text-sm text-[#C8C3B8] leading-relaxed">
                Crie a campanha de teste oficial <strong>ECHO ARC</strong> para iniciar com Samuel
                na Vila de Freixo, Teresa e Henrique, inventário estruturado e calendário do mundo.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                disabled={isMutating}
                onClick={() => void handleCreateEchoArc()}
                className="px-5 py-3 inline-flex items-center justify-center gap-2 text-sm font-semibold rounded-lg bg-[#D4AF37] text-[#0B0D12] hover:bg-[#E2C258] disabled:opacity-50 transition-colors cursor-pointer"
              >
                <Sparkles className="w-4 h-4" aria-hidden="true" />
                <span>{isMutating ? 'Criando...' : 'Criar Campanha ECHO ARC'}</span>
              </button>

              <button
                type="button"
                disabled={isMutating}
                onClick={() => setCampaignHubOpen(true)}
                className="px-5 py-3 inline-flex items-center justify-center gap-2 text-sm font-medium rounded-lg border border-white/15 text-[#EDE8DC] hover:border-[#D4AF37]/40 transition-colors cursor-pointer"
              >
                <FolderPlus className="w-4 h-4 text-[#D4AF37]" aria-hidden="true" />
                <span>Gerenciar ou Criar Personalizada</span>
              </button>
            </div>
          </div>
        ) : (
          (() => {
            const narrativeAudit = classifyNarrativeEntriesForAudit(activeCampaign, narrative);
            const eventAudit = classifyEventsForAudit(activeCampaign, events);

            return (
              <div className="flex min-h-0 flex-1 flex-col gap-2 lg:grid lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(230px,310px)_minmax(0,1fr)_minmax(250px,330px)] lg:gap-5">
                {/* Coluna Esquerda: Personagem & Inventário */}
                <div
                  className={`min-h-0 overflow-y-auto flex-1 bg-[#121620] border border-[#D4AF37]/15 rounded-xl p-5 ${
                    mobileTab === 'character' ? 'block' : 'hidden lg:block'
                  }`}
                >
                  <CharacterPanel
                    campaign={activeCampaign}
                    npcs={npcs}
                    isMutating={isMutating}
                    onAdjustCurrency={restrictedPilot ? undefined : (delta) => void handleCurrencyMutation(delta)}
                  />
                  <InventoryPanel
                    items={inventory}
                    readOnly={restrictedPilot}
                    isArchived={activeCampaign.status === 'archived'}
                    isMutating={isMutating}
                    onMutateInventory={handleInventoryMutation}
                  />
                </div>

                {/* Coluna Central: Narrativa & Campo de Ação Livre */}
                <div
                  className={'order-last min-h-0 lg:order-none ' + (mobileTab === 'narrative' ? 'flex-1' : 'shrink-0')}
                >
                  <NarrativeStage
                    scene={scene}
                    automaticDuration={restrictedPilot}
                    key={activeCampaign.id}
                    campaign={activeCampaign}
                    entries={narrativeAudit.active}
                    historyVisible={mobileTab === 'narrative'}
                    isMutating={isMutating}
                    pendingAction={pendingTurn?.declaredAction}
                    pendingConflict={Boolean(pendingTurn && conflictingTurnId === pendingTurn.turnId)}
                    onResumePending={pendingTurn ? () => void submitPlayerTurn(pendingTurn) : undefined}
                    onDiscardPending={pendingTurn ? () => {
                      clearPendingTurn(window.sessionStorage, user.uid, pendingTurn);
                      setConflictingTurnId(null);
                      setErrorState(null);
                    } : undefined}
                    clarification={activeClarification && (!pendingTurn || isMutating) ? activeClarification.message : undefined}
                    gameplayFeedback={gameplayFeedback?.ownerId === user?.uid &&
                      gameplayFeedback?.campaignId === activeCampaign.id ? gameplayFeedback.message : undefined}
                    onCancelClarification={() => setClarification(null)}
                    confirmedAction={restrictedPilot ? eventAudit.active.find((event) =>
                      event.type === 'PLAYER_ACTION' && event.sequence === activeCampaign.lastSequence) : undefined}
                    onSubmitAction={handlePlayerAction}
                  />
                </div>

                {/* Coluna Direita: Calendário, Pontos de Controle e Registro de Eventos */}
                <div
                  className={`min-h-0 overflow-y-auto flex-1 bg-[#121620] border border-[#D4AF37]/15 rounded-xl p-5 ${
                    mobileTab === 'world' ? 'block' : 'hidden lg:block'
                  }`}
                >
                  <WorldSidebar
                    campaign={activeCampaign}
                    events={events}
                    eventStatuses={eventAudit.statusById}
                    supersededNarrative={narrativeAudit.superseded}
                    checkpoints={checkpoints}
                    isMutating={isMutating}
                    onAdvanceTime={stagingFreixo ? undefined : (mins) => void handleAdvanceTime(mins)}
                    onOpenSaveCheckpoint={stagingFreixo ? undefined : () => setCheckpointMode('save')}
                    onOpenLoadCheckpoint={stagingFreixo ? undefined : () => setCheckpointMode('load')}
                    onOpenCampaigns={restrictedPilot ? undefined : () => setCampaignHubOpen(true)}
                    onTestPersistenceError={showDiagnostics ? () => void handleTestPersistenceError() : undefined}
                  />
                </div>
              </div>
            );
          })()
        )}
      </main>

      {showDiagnostics && <DevAuthProbe user={user} campaignId={activeCampaign?.id ?? null} />}

      <CampaignHubModal
        isOpen={!restrictedPilot && campaignHubOpen}
        campaigns={campaigns}
        activeCampaignId={selectedCampaignId}
        isMutating={isMutating}
        onClose={() => setCampaignHubOpen(false)}
        onSelectCampaign={(id) => {
          setSelectedCampaignId(id);
          writeCampaignIdToUrl(id);
        }}
        onCreateEchoArc={handleCreateEchoArc}
        onCreateCustomCampaign={handleCreateCustomCampaign}
        onDeleteCampaign={handleDeleteCampaign}
      />

      {activeCampaign && !stagingFreixo && (
        <CheckpointModal
          mode={checkpointMode}
          campaign={activeCampaign}
          checkpoints={checkpoints}
          isMutating={isMutating}
          onClose={() => setCheckpointMode(null)}
          onSaveCheckpoint={handleSaveCheckpoint}
          onRestoreCheckpoint={handleRestoreCheckpoint}
        />
      )}
    </div>
  );
}




