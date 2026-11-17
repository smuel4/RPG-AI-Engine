import { useEffect, useState } from 'react';
import { FolderPlus, Sparkles } from 'lucide-react';
import { useAuth } from './hooks/useAuth';
import {
  buildCheckpointPayload,
  classifyEventsForAudit,
  classifyNarrativeEntriesForAudit,
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
  commitTimeAdvance,
  createCampaignBundle,
  deleteCampaignWithSubcollections,
  restoreCheckpoint,
  saveCheckpoint,
  subscribeCampaignDetails,
  subscribeUserCampaigns,
  testPersistenceFailure,
} from './services/campaignRepository';
import { formatPersistenceError } from './services/firebaseClient';
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

export default function App() {
  const { user, loading: authLoading, authError, signInWithGoogle, logout, clearAuthError } =
    useAuth();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignsLoaded, setCampaignsLoaded] = useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(() =>
    readCampaignIdFromUrl(),
  );

  const [activeCampaign, setActiveCampaign] = useState<Campaign | null>(null);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [npcs, setNpcs] = useState<NpcRecord[]>([]);
  const [narrative, setNarrative] = useState<NarrativeEntry[]>([]);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);

  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [isMutating, setIsMutating] = useState(false);
  const [errorState, setErrorState] = useState<PersistenceErrorState | string | null>(null);
  const [lastFailedAction, setLastFailedAction] = useState<(() => Promise<void>) | null>(null);

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
          if (prev && list.some((c) => c.id === prev)) return prev;
          const next = list[0]?.id ?? null;
          writeCampaignIdToUrl(next);
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
  ): Promise<boolean> => {
    setErrorState(null);
    setLastFailedAction(null);
    setIsMutating(true);
    setSyncState('saving');
    try {
      await task();
      setSyncState('synced');
      return true;
    } catch (err) {
      setSyncState('error');
      setErrorState(formatPersistenceError(err, errorTitle));
      setLastFailedAction(() => async () => {
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
    if (!activeCampaign) return false;
    const rule = processPlayerAction(activeCampaign, inventory, npcs, actionText, advanceMinutes);
    if (!rule.ok) {
      setErrorState(rule.error);
      return false;
    }

    return executeMutation(
      () => commitPlayerAction(activeCampaign.id, rule.data),
      'Falha ao registrar ação no Firestore',
    );
  };

  const handleInventoryMutation = async (
    command: InventoryMutationCommand,
  ): Promise<boolean> => {
    if (!activeCampaign) return false;
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
    if (!activeCampaign) return;
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
    if (!activeCampaign) return;
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
    if (!activeCampaign) return false;
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
    if (!activeCampaign) return false;
    return executeMutation(
      () => restoreCheckpoint(activeCampaign, checkpoint, inventory, npcs),
      'Falha ao carregar ponto de controle',
    );
  };

  const handleTestPersistenceError = async () => {
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
    <div className="min-h-screen bg-[#0B0D12] text-[#EDE8DC] flex flex-col">
      <TopBar
        campaignName={activeCampaign?.name ?? null}
        syncState={syncState}
        userEmail={user.email}
        hasCampaign={Boolean(activeCampaign)}
        onOpenSaveCheckpoint={() => setCheckpointMode('save')}
        onOpenLoadCheckpoint={() => setCheckpointMode('load')}
        onOpenCampaigns={() => setCampaignHubOpen(true)}
        onSignOut={() => void logout()}
      />

      {/* Navegação mobile compacta */}
      {activeCampaign && (
        <div className="lg:hidden border-b border-white/10 bg-[#0E121A] px-3 py-2 space-y-2">
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
            <div className="flex items-center gap-2">
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
            </div>
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

      <main className="flex-1 max-w-[1600px] w-full mx-auto px-4 lg:px-6 py-5 space-y-4">
        {errorState && (
          <ErrorBanner
            error={errorState}
            onDismiss={() => setErrorState(null)}
            onRetry={lastFailedAction ? () => void lastFailedAction() : undefined}
          />
        )}

        {!campaignsLoaded ? (
          <div className="py-20 text-center text-sm text-[#B7B2A6]">
            Carregando campanhas persistidas no Cloud Firestore...
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
              <div className="grid grid-cols-1 lg:grid-cols-[310px_minmax(0,1fr)_330px] gap-5 items-start">
                {/* Coluna Esquerda: Personagem & Inventário */}
                <div
                  className={`bg-[#121620] border border-[#D4AF37]/15 rounded-xl p-5 ${
                    mobileTab === 'character' ? 'block' : 'hidden lg:block'
                  }`}
                >
                  <CharacterPanel
                    campaign={activeCampaign}
                    npcs={npcs}
                    isMutating={isMutating}
                    onAdjustCurrency={(delta) => void handleCurrencyMutation(delta)}
                  />
                  <InventoryPanel
                    items={inventory}
                    isArchived={activeCampaign.status === 'archived'}
                    isMutating={isMutating}
                    onMutateInventory={handleInventoryMutation}
                  />
                </div>

                {/* Coluna Central: Narrativa & Campo de Ação Livre */}
                <div
                  className={`${
                    mobileTab === 'narrative' ? 'block' : 'hidden lg:block'
                  } h-full`}
                >
                  <NarrativeStage
                    campaign={activeCampaign}
                    entries={narrativeAudit.active}
                    isMutating={isMutating}
                    onSubmitAction={handlePlayerAction}
                  />
                </div>

                {/* Coluna Direita: Calendário, Pontos de Controle e Registro de Eventos */}
                <div
                  className={`bg-[#121620] border border-[#D4AF37]/15 rounded-xl p-5 ${
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
                    onAdvanceTime={(mins) => void handleAdvanceTime(mins)}
                    onOpenSaveCheckpoint={() => setCheckpointMode('save')}
                    onOpenLoadCheckpoint={() => setCheckpointMode('load')}
                    onOpenCampaigns={() => setCampaignHubOpen(true)}
                    onTestPersistenceError={() => void handleTestPersistenceError()}
                  />
                </div>
              </div>
            );
          })()
        )}
      </main>

      <CampaignHubModal
        isOpen={campaignHubOpen}
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

      {activeCampaign && (
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
