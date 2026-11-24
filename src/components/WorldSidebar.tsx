import { useState } from 'react';
import {
  AlertCircle,
  Calendar,
  Clock,
  FolderOpen,
  History,
  RotateCcw,
  Save,
} from 'lucide-react';
import type {
  Campaign,
  Checkpoint,
  GameEvent,
  GameEventType,
  NarrativeEntry,
  TimelineAuditStatus,
} from '../types/game';
import { formatWorldClock, formatWorldDate } from '../engine/constants';

interface WorldSidebarProps {
  campaign: Campaign;
  events: GameEvent[];
  eventStatuses?: Record<string, TimelineAuditStatus>;
  supersededNarrative?: NarrativeEntry[];
  checkpoints: Checkpoint[];
  isMutating: boolean;
  onAdvanceTime?: (minutes: number) => void;
  onOpenSaveCheckpoint?: () => void;
  onOpenLoadCheckpoint?: () => void;
  onOpenCampaigns?: () => void;
  onTestPersistenceError?: () => void;
}

const EVENT_TYPE_LABELS: Record<GameEventType, string> = {
  CAMPAIGN_CREATED: 'Campanha Criada',
  PLAYER_ACTION: 'Ação do Jogador',
  INVENTORY_ADDED: 'Item Adicionado',
  INVENTORY_UPDATED: 'Inventário Atualizado',
  INVENTORY_REMOVED: 'Item Removido',
  CURRENCY_UPDATED: 'Moedas Atualizadas',
  TIME_ADVANCED: 'Tempo Avançado',
  CHECKPOINT_SAVED: 'Checkpoint Salvo',
  CHECKPOINT_LOADED: 'Checkpoint Carregado',
};

export function WorldSidebar({
  campaign,
  events,
  eventStatuses = {},
  supersededNarrative = [],
  checkpoints,
  isMutating,
  onAdvanceTime,
  onOpenSaveCheckpoint,
  onOpenLoadCheckpoint,
  onOpenCampaigns,
  onTestPersistenceError,
}: WorldSidebarProps) {
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [showAlternateAudit, setShowAlternateAudit] = useState(false);
  const { worldTime } = campaign;
  const isArchived = campaign.status === 'archived';

  return (
    <aside className="space-y-6">
      {/* Calendário e Horário do Mundo */}
      <section aria-labelledby="world-time-heading" className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-[#D4AF37] shrink-0" aria-hidden="true" />
            <h2
              id="world-time-heading"
              className="font-display text-base font-semibold text-[#F2E2B0] tracking-wide"
            >
              Calendário do Mundo
            </h2>
          </div>
          <span className="text-xs text-[#9CA3AF]">{worldTime.season}</span>
        </div>

        <div className="bg-[#0E121A] border border-white/8 rounded-lg p-3.5 space-y-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono-tabular text-2xl font-semibold text-[#F6E8B1]">
              {formatWorldClock(worldTime)}
            </span>
            <span className="text-xs font-medium text-[#D4AF37]">
              {worldTime.periodOfDay}
            </span>
          </div>

          <p className="text-xs text-[#C8C3B8]">
            {worldTime.weekday} · {formatWorldDate(worldTime)}
          </p>

          {onAdvanceTime && <div className="flex items-center gap-2 pt-1 border-t border-white/8">
            <Clock className="w-3.5 h-3.5 text-[#9CA3AF] shrink-0" aria-hidden="true" />
            <button
              type="button"
              disabled={isArchived || isMutating}
              onClick={() => onAdvanceTime(15)}
              className="flex-1 py-1.5 text-xs rounded bg-[#161B26] hover:bg-[#1E2534] text-[#EDE8DC] disabled:opacity-40 transition-colors whitespace-nowrap cursor-pointer"
            >
              +15 min
            </button>
            <button
              type="button"
              disabled={isArchived || isMutating}
              onClick={() => onAdvanceTime(60)}
              className="flex-1 py-1.5 text-xs rounded bg-[#161B26] hover:bg-[#1E2534] text-[#EDE8DC] disabled:opacity-40 transition-colors whitespace-nowrap cursor-pointer"
            >
              +1 hora
            </button>
          </div>}
        </div>
      </section>

      {/* Botões explícitos de Salvar, Carregar e Acessar Campanhas */}
      {onOpenSaveCheckpoint && onOpenLoadCheckpoint && <section aria-labelledby="persistence-heading" className="space-y-3 border-t border-white/8 pt-5">
        <div className="flex items-center justify-between gap-2">
          <h2
            id="persistence-heading"
            className="font-display text-base font-semibold text-[#F2E2B0] tracking-wide"
          >
            Pontos de Controle
          </h2>
          <span className="font-mono-tabular text-xs text-[#9CA3AF]">
            {checkpoints.length} salvos
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={isArchived || isMutating}
            onClick={onOpenSaveCheckpoint}
            className="py-2 px-3 min-h-[40px] inline-flex items-center justify-center gap-1.5 text-xs font-semibold rounded-md bg-[#D4AF37] text-[#0B0D12] hover:bg-[#E2C258] disabled:opacity-45 transition-colors whitespace-nowrap cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Salvar</span>
          </button>

          <button
            type="button"
            disabled={isMutating}
            onClick={onOpenLoadCheckpoint}
            className="py-2 px-3 min-h-[40px] inline-flex items-center justify-center gap-1.5 text-xs font-medium rounded-md border border-[#D4AF37]/30 text-[#F2E2B0] hover:bg-[#D4AF37]/10 disabled:opacity-45 transition-colors whitespace-nowrap cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Carregar</span>
          </button>
        </div>

        {onOpenCampaigns && <button
          type="button"
          onClick={onOpenCampaigns}
          className="w-full py-2 px-3 min-h-[40px] inline-flex items-center justify-center gap-1.5 text-xs font-medium rounded-md bg-[#0E121A] border border-white/10 hover:border-[#D4AF37]/35 text-[#EDE8DC] transition-colors whitespace-nowrap cursor-pointer"
        >
          <FolderOpen className="w-3.5 h-3.5 text-[#D4AF37]" aria-hidden="true" />
          <span>Acessar Campanhas</span>
        </button>}
      </section>}

      {/* Registro de Eventos (Auditoria e Restauração) */}
      <section aria-labelledby="events-heading" className="space-y-3 border-t border-white/8 pt-5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-[#D4AF37] shrink-0" aria-hidden="true" />
            <h2
              id="events-heading"
              className="font-display text-base font-semibold text-[#F2E2B0] tracking-wide"
            >
              Registro de Eventos
            </h2>
          </div>
          <span className="font-mono-tabular text-xs text-[#9CA3AF]">
            {events.length}
          </span>
        </div>

        {events.length === 0 ? (
          <p className="text-xs text-[#9CA3AF]">
            Nenhum evento auditado registrado ainda.
          </p>
        ) : (
          <ul className="divide-y divide-white/8 max-h-[360px] overflow-y-auto pr-1">
            {events.map((evt) => {
              const isExpanded = expandedEventId === evt.id;
              const isAlternateTimeline = eventStatuses[evt.id] === 'alternate_timeline';
              return (
                <li
                  key={evt.id}
                  className={`py-2.5 first:pt-1 last:pb-0 ${isAlternateTimeline ? 'opacity-70' : ''}`}
                >
                  <button
                    type="button"
                    onClick={() => setExpandedEventId(isExpanded ? null : evt.id)}
                    className="w-full text-left space-y-1 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#D4AF37] rounded"
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px] text-[#9CA3AF]">
                      <span className={isAlternateTimeline ? 'text-[#9CA3AF] font-medium' : 'text-[#D4AF37] font-medium'}>
                        {EVENT_TYPE_LABELS[evt.type]}
                        {isAlternateTimeline ? ' · Outra linha temporal' : ''}
                      </span>
                      <span className="font-mono-tabular">#{evt.sequence}</span>
                    </div>
                    <p className="text-xs text-[#EDE8DC] leading-relaxed break-words">
                      {evt.summary}
                    </p>
                  </button>

                  {isExpanded && (
                    <div className="mt-2 bg-[#0B0D12] border border-white/8 rounded p-2.5 space-y-1 text-[11px] text-[#B7B2A6]">
                      <p>
                        <span className="text-[#9CA3AF]">Autor:</span> {evt.actor}
                      </p>
                      <p>
                        <span className="text-[#9CA3AF]">Linha temporal:</span>{' '}
                        {isAlternateTimeline
                          ? 'Histórico preservado (linha anterior à restauração)'
                          : 'Linha ativa atual'}
                      </p>
                      <p>
                        <span className="text-[#9CA3AF]">Tempo do mundo:</span>{' '}
                        {evt.worldTimeLabel}
                      </p>
                      <p>
                        <span className="text-[#9CA3AF]">Antes:</span> {evt.beforeSummary}
                      </p>
                      <p>
                        <span className="text-[#9CA3AF]">Depois:</span> {evt.afterSummary}
                      </p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {supersededNarrative.length > 0 && (
          <div className="pt-2 border-t border-white/8 space-y-2">
            <button
              type="button"
              onClick={() => setShowAlternateAudit((prev) => !prev)}
              className="w-full py-1.5 px-2.5 text-left text-[11px] rounded bg-[#0E121A] border border-white/8 text-[#B7B2A6] hover:border-[#D4AF37]/30 transition-colors cursor-pointer"
            >
              {showAlternateAudit
                ? `Ocultar narrativa de outras linhas temporais (${supersededNarrative.length})`
                : `Auditar narrativa de linhas anteriores (${supersededNarrative.length})`}
            </button>

            {showAlternateAudit && (
              <ul className="space-y-2 max-h-[180px] overflow-y-auto pr-1 text-[11px] text-[#9CA3AF]">
                {supersededNarrative.map((entry) => (
                  <li
                    key={entry.id}
                    className="bg-[#0B0D12] border border-white/8 rounded p-2 space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span>Outra linha temporal</span>
                      <span className="font-mono-tabular">#{entry.sequence}</span>
                    </div>
                    <p className="text-[#B7B2A6] whitespace-pre-wrap break-words">
                      {entry.content}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Teste explícito de falha de salvamento para o critério de aceitação */}
        {onTestPersistenceError && <div className="pt-2 border-t border-white/8">
          <button
            type="button"
            disabled={isMutating}
            onClick={onTestPersistenceError}
            className="w-full py-2 px-3 inline-flex items-center justify-center gap-1.5 text-xs rounded border border-white/10 text-[#9CA3AF] hover:text-red-300 hover:border-red-500/35 transition-colors cursor-pointer"
          >
            <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Testar Erro de Salvamento</span>
          </button>
        </div>}
      </section>
    </aside>
  );
}
