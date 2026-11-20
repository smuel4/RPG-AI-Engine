import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Send } from 'lucide-react';
import { formatWorldClock } from '../engine/constants';
import type { Campaign, GameEvent, NarrativeEntry } from '../types/game';

interface NarrativeStageProps {
  campaign: Campaign;
  entries: NarrativeEntry[];
  historyVisible?: boolean;
  automaticDuration?: boolean;
  isMutating: boolean;
  pendingAction?: string;
  pendingConflict?: boolean;
  onResumePending?: () => void;
  onDiscardPending?: () => void;
  clarification?: string;
  gameplayFeedback?: string;
  onCancelClarification?: () => void;
  confirmedAction?: GameEvent;
  onSubmitAction: (actionText: string, advanceMinutes: number) => Promise<boolean>;
}

const ROLE_LABELS: Record<NarrativeEntry['authorRole'], string> = {
  system_seed: 'Ambientação Inicial',
  player_action: 'Decisão do Jogador',
  engine_response: 'Narrador',
};

export function NarrativeStage({
  campaign,
  entries,
  historyVisible = true,
  automaticDuration = false,
  isMutating,
  pendingAction,
  pendingConflict,
  onResumePending,
  onDiscardPending,
  clarification,
  gameplayFeedback,
  onCancelClarification,
  confirmedAction,
  onSubmitAction,
}: NarrativeStageProps) {
  const [actionText, setActionText] = useState(pendingAction ?? '');
  const cannotSubmit = Boolean(pendingAction) || campaign.status === 'archived' || isMutating;
  const [advanceMinutes, setAdvanceMinutes] = useState<number>(10);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const readingPosition = useRef(0);
  const [readingEarlier, setReadingEarlier] = useState(false);
  const historyVisibility = historyVisible ? '' : 'hidden lg:block';
  const isClarifying = Boolean(clarification);

  useEffect(() => {
    if (isClarifying) setActionText('');
  }, [isClarifying]);

  useLayoutEffect(() => {
    const history = historyRef.current;
    if (history?.clientHeight) history.scrollTop = following.current ? history.scrollHeight : readingPosition.current;
  }, [entries, historyVisible]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (cannotSubmit) return;
    const ok = await onSubmitAction(actionText, advanceMinutes);
    if (ok) {
      setActionText('');
    }
  };

  return (
    <section
      aria-labelledby="narrative-heading"
      className="flex flex-col h-full min-h-0 bg-[#10141E] border border-[#D4AF37]/15 rounded-xl overflow-hidden"
    >
      {/* Cabeçalho da crônica */}
      <div className={'px-3 py-2 sm:px-5 sm:py-4 border-b border-white/8 bg-[#121723] shrink-0 flex-wrap items-baseline justify-between gap-2 ' +
        (historyVisible ? 'flex' : 'hidden lg:flex')}>
        <div className="space-y-0.5 min-w-0">
          <h1
            id="narrative-heading"
            className="font-display text-lg sm:text-xl font-semibold text-[#F6E8B1] tracking-wide text-balance"
          >
            {campaign.name}
          </h1>
          <p className="text-xs text-[#9CA3AF] truncate">{campaign.setting}</p>
        </div>

        <span className="text-xs text-[#C8C3B8]">
          {campaign.currentLocation} · Controle exclusivo de {campaign.protagonist.name}
          {automaticDuration && <> · <span className="font-mono-tabular">{formatWorldClock(campaign.worldTime)}</span></>}
        </span>
      </div>

      {/* Área central de narrativa e acontecimentos */}
      <div ref={historyRef} role="region" aria-label="Histórico narrativo" tabIndex={0}
        className={'min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-7 sm:py-6 space-y-6 ' + historyVisibility}
        onScroll={(event) => {
          const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
          if (!clientHeight) return;
          readingPosition.current = scrollTop;
          following.current = scrollHeight - scrollTop - clientHeight <= 48;
          setReadingEarlier(!following.current);
        }}>
        {entries.length === 0 ? (
          <div className="py-12 text-center space-y-2">
            <p className="text-sm text-[#C8C3B8]">
              Nenhuma entrada narrativa registrada para esta campanha ainda.
            </p>
            <p className="text-xs text-[#9CA3AF]">
              Escreva a primeira ação de {campaign.protagonist.name} no campo abaixo.
            </p>
          </div>
        ) : (
          entries.map((entry) => {
            const isPlayer = entry.authorRole === 'player_action';
            return (
              <article
                key={entry.id}
                className={`max-w-[70ch] space-y-1.5 pb-5 border-b border-white/6 last:border-b-0 ${
                  isPlayer ? 'ml-auto bg-[#171D2B] border border-[#D4AF37]/20 rounded-lg p-4 border-b-[#D4AF37]/20' : ''
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#9CA3AF]">
                  <span
                    className={
                      isPlayer
                        ? 'font-semibold text-[#E8CC75]'
                        : entry.authorRole === 'system_seed'
                          ? 'font-semibold text-[#D4AF37]'
                          : 'font-medium text-[#C8C3B8]'
                    }
                  >
                    {isPlayer ? `${campaign.protagonist.name} · ${ROLE_LABELS[entry.authorRole]}` : ROLE_LABELS[entry.authorRole]}
                  </span>
                  <span className="font-mono-tabular text-[11px]">
                    #{entry.sequence} · {entry.worldTimeLabel}
                  </span>
                </div>

                <p className="text-[15px] leading-[1.68] text-[#EDE8DC] whitespace-pre-wrap break-words">
                  {entry.content}
                </p>
              </article>
            );
          })
        )}
      </div>
      {readingEarlier && (
        <button type="button" className={'shrink-0 self-end px-3 py-1 text-sm underline text-[#F6E8B1] ' + historyVisibility}
          onClick={() => {
            const history = historyRef.current;
            if (!history) return;
            following.current = true;
            history.scrollTop = history.scrollHeight;
            history.focus({ preventScroll: true });
            setReadingEarlier(false);
          }}>Ir para a mensagem mais recente</button>
      )}

      {confirmedAction && (
        <div role="status" className={'max-h-[18dvh] overflow-y-auto shrink-0 border-t border-white/10 px-3 py-1 text-sm text-[#C8C3B8] ' + historyVisibility}>
          <p className="font-semibold text-[#F6E8B1]">Última ação confirmada</p>
          <p>{confirmedAction.summary}</p>
          <p>{confirmedAction.afterSummary}</p>
        </div>
      )}

      {/* Campo livre de ação do jogador */}
      <form
        onSubmit={handleSubmit}
        className="shrink-0 border-t border-white/10 bg-[#121723] p-2 sm:p-4 space-y-2"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label
            htmlFor="player-action-input"
            className="text-xs font-medium text-[#C8C3B8]"
          >
            {isClarifying ? 'Informe o objeto' : `Escreva a decisão de ${campaign.protagonist.name} livremente`}
          </label>

          {!isClarifying && !automaticDuration && <div className="flex items-center gap-2">
            <label htmlFor="action-duration" className="text-xs text-[#9CA3AF]">
              Tempo gasto:
            </label>
            <select
              id="action-duration"
              value={advanceMinutes}
              onChange={(e) => setAdvanceMinutes(Number(e.target.value))}
              className="px-2 py-1 text-xs font-mono-tabular rounded bg-[#0B0D12] border border-white/10 text-[#EDE8DC] focus:outline-none focus:border-[#D4AF37]"
            >
              <option value={0}>0 min</option>
              <option value={10}>10 min</option>
              <option value={30}>30 min</option>
              <option value={60}>1 hora</option>
            </select>
          </div>}
        </div>

        {pendingAction && !isMutating && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-[#F6E8B1]">
            <p className="max-h-16 min-w-0 overflow-auto break-words">Turno pendente: {pendingAction}</p>
            <button type="button" className="underline" onClick={pendingConflict ? onDiscardPending : onResumePending}>
              {pendingConflict ? 'Descartar tentativa local' : 'Retomar turno'}
            </button>
          </div>
        )}
        {gameplayFeedback && !clarification && (
          <p role="status" className="text-sm text-[#F6E8B1]">{gameplayFeedback}</p>
        )}
        {clarification && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-[#F6E8B1]">
            <p role="status">{clarification}</p>
            <button type="button" disabled={cannotSubmit} className="underline" onClick={() => {
              setActionText('');
              onCancelClarification?.();
            }}>Cancelar e escrever outra ação</button>
          </div>
        )}

        <div className="flex gap-2">
          <textarea
            id="player-action-input"
            rows={2}
            maxLength={800}
            disabled={campaign.status === 'archived'}
            readOnly={isMutating}
            value={actionText}
            onChange={(e) => setActionText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (actionText.trim() && !cannotSubmit) {
                  void handleSubmit(e);
                }
              }
            }}
            placeholder={isClarifying ? 'Nome do objeto' : `Ex.: ${campaign.protagonist.name} verifica os mantimentos na mesa e conversa com Teresa sobre os preparativos do dia.`}
            className="min-w-0 flex-1 px-3.5 py-2.5 text-sm rounded-lg bg-[#0B0D12] border border-white/12 text-[#EDE8DC] placeholder:text-[#6B7280] focus:outline-none focus:border-[#D4AF37] resize-none"
          />

          <button
            type="submit"
            disabled={cannotSubmit}
            aria-busy={isMutating}
            className="self-end px-2.5 sm:px-5 py-2.5 min-h-[44px] min-w-[8.5rem] sm:min-w-[10rem] inline-flex items-center justify-center gap-2 text-sm font-semibold rounded-lg bg-[#D4AF37] text-[#0B0D12] hover:bg-[#E2C258] disabled:opacity-45 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F2E2B0]"
          >
            <Send className="w-4 h-4" aria-hidden="true" />
            <span>{isMutating ? 'Registrando...' : isClarifying ? 'Responder' : 'Enviar Ação'}</span>
          </button>
        </div>

        <p className="text-[11px] text-[#9CA3AF]">
          Enter envia a ação · Shift+Enter quebra linha · O narrador não altera o estado sem
          validação das regras.
        </p>
      </form>
    </section>
  );
}
