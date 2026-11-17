import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Send } from 'lucide-react';
import type { Campaign, NarrativeEntry } from '../types/game';

interface NarrativeStageProps {
  campaign: Campaign;
  entries: NarrativeEntry[];
  isMutating: boolean;
  onSubmitAction: (actionText: string, advanceMinutes: number) => Promise<boolean>;
}

const ROLE_LABELS: Record<NarrativeEntry['authorRole'], string> = {
  system_seed: 'Ambientação Inicial',
  player_action: 'Decisão do Jogador',
  engine_response: 'Resposta do Motor (Teste Fixo)',
};

export function NarrativeStage({
  campaign,
  entries,
  isMutating,
  onSubmitAction,
}: NarrativeStageProps) {
  const [actionText, setActionText] = useState('');
  const [advanceMinutes, setAdvanceMinutes] = useState<number>(10);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries.length]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await onSubmitAction(actionText, advanceMinutes);
    if (ok) {
      setActionText('');
    }
  };

  return (
    <section
      aria-labelledby="narrative-heading"
      className="flex flex-col h-full min-h-[540px] bg-[#10141E] border border-[#D4AF37]/15 rounded-xl overflow-hidden"
    >
      {/* Cabeçalho da crônica */}
      <div className="px-5 py-4 border-b border-white/8 bg-[#121723] flex flex-wrap items-baseline justify-between gap-2">
        <div className="space-y-0.5 min-w-0">
          <h1
            id="narrative-heading"
            className="font-display text-lg sm:text-xl font-semibold text-[#F6E8B1] tracking-wide text-balance"
          >
            {campaign.name}
          </h1>
          <p className="text-xs text-[#9CA3AF] truncate">{campaign.setting}</p>
        </div>

        <span className="text-xs text-[#C8C3B8] whitespace-nowrap shrink-0">
          {campaign.currentLocation} · Controle exclusivo de {campaign.protagonist.name}
        </span>
      </div>

      {/* Área central de narrativa e acontecimentos */}
      <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-6 space-y-6">
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
        <div ref={bottomRef} />
      </div>

      {/* Campo livre de ação do jogador */}
      <form
        onSubmit={handleSubmit}
        className="border-t border-white/10 bg-[#121723] p-4 space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label
            htmlFor="player-action-input"
            className="text-xs font-medium text-[#C8C3B8]"
          >
            Escreva a decisão de {campaign.protagonist.name} livremente
          </label>

          <div className="flex items-center gap-2">
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
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2.5">
          <textarea
            id="player-action-input"
            rows={2}
            maxLength={800}
            disabled={campaign.status === 'archived' || isMutating}
            value={actionText}
            onChange={(e) => setActionText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (actionText.trim() && !isMutating && campaign.status !== 'archived') {
                  void handleSubmit(e);
                }
              }
            }}
            placeholder={`Ex.: ${campaign.protagonist.name} verifica os mantimentos na mesa e conversa com Teresa sobre os preparativos do dia.`}
            className="flex-1 px-3.5 py-2.5 text-sm rounded-lg bg-[#0B0D12] border border-white/12 text-[#EDE8DC] placeholder:text-[#6B7280] focus:outline-none focus:border-[#D4AF37] resize-none"
          />

          <button
            type="submit"
            disabled={campaign.status === 'archived' || isMutating}
            className="sm:self-end px-5 py-2.5 min-h-[44px] inline-flex items-center justify-center gap-2 text-sm font-semibold rounded-lg bg-[#D4AF37] text-[#0B0D12] hover:bg-[#E2C258] disabled:opacity-45 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F2E2B0]"
          >
            <Send className="w-4 h-4" aria-hidden="true" />
            <span>{isMutating ? 'Registrando...' : 'Enviar Ação'}</span>
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
