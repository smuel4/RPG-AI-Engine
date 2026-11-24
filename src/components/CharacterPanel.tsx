import { Coins, MapPin, Minus, Plus, User, Users } from 'lucide-react';
import type { Campaign, Currency, NpcRecord } from '../types/game';

interface CharacterPanelProps {
  campaign: Campaign;
  npcs: NpcRecord[];
  isMutating: boolean;
  onAdjustCurrency?: (delta: Partial<Currency>) => void;
}

export function CharacterPanel({
  campaign,
  npcs,
  isMutating,
  onAdjustCurrency,
}: CharacterPanelProps) {
  const { protagonist, currency } = campaign;
  const vitalityPct = Math.max(
    0,
    Math.min(100, Math.round((protagonist.vitality / protagonist.maxVitality) * 100)),
  );
  const focusPct = Math.max(
    0,
    Math.min(100, Math.round((protagonist.focus / protagonist.maxFocus) * 100)),
  );

  return (
    <section aria-labelledby="character-heading" className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2
            id="character-heading"
            className="font-display text-base font-semibold text-[#F2E2B0] tracking-wide"
          >
            Painel de Personagem
          </h2>
          <span className="font-mono-tabular text-xs text-[#9CA3AF]">
            Rev. {campaign.revision}
          </span>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <User className="w-4 h-4 text-[#D4AF37] shrink-0" aria-hidden="true" />
            <span className="text-base font-semibold text-[#EDE8DC]">
              {protagonist.name}
            </span>
            <span className="text-xs text-[#9CA3AF]">
              · {protagonist.age} anos
            </span>
          </div>
          <p className="text-xs text-[#B7B2A6] leading-relaxed">{protagonist.origin}</p>
          {protagonist.futureHook && (
            <p className="text-xs text-[#D4AF37]/90 leading-relaxed">
              Horizonte: {protagonist.futureHook}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs text-[#C8C3B8] pt-1">
          <MapPin className="w-3.5 h-3.5 text-[#D4AF37] shrink-0" aria-hidden="true" />
          <span className="truncate">{campaign.currentLocation}</span>
          <span aria-hidden="true">·</span>
          <span className="text-[#9CA3AF] truncate">{protagonist.disposition}</span>
        </div>
      </div>

      {/* Barras de estado com rótulos explícitos e números tabulares */}
      <div className="space-y-3 border-t border-white/8 pt-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-[#C8C3B8] font-medium">Vitalidade</span>
            <span className="font-mono-tabular text-[#EDE8DC]">
              {protagonist.vitality} / {protagonist.maxVitality}
            </span>
          </div>
          <div className="h-1.5 w-full bg-[#0B0D12] rounded-sm overflow-hidden">
            <div
              className="h-full bg-emerald-500/80 transition-all duration-200"
              style={{ width: `${vitalityPct}%` }}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-[#C8C3B8] font-medium">Foco</span>
            <span className="font-mono-tabular text-[#EDE8DC]">
              {protagonist.focus} / {protagonist.maxFocus}
            </span>
          </div>
          <div className="h-1.5 w-full bg-[#0B0D12] rounded-sm overflow-hidden">
            <div
              className="h-full bg-[#D4AF37] transition-all duration-200"
              style={{ width: `${focusPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* Moedas estruturadas com ajuste validado para testes */}
      <div className="space-y-3 border-t border-white/8 pt-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-[#EDE8DC]">
            <Coins className="w-3.5 h-3.5 text-[#D4AF37]" aria-hidden="true" />
            <span>Moedas Estruturadas</span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {(
            [
              { key: 'gold', label: 'Ouro', value: currency.gold },
              { key: 'silver', label: 'Prata', value: currency.silver },
              { key: 'copper', label: 'Cobre', value: currency.copper },
            ] as const
          ).map((coin) => (
            <div
              key={coin.key}
              className="bg-[#0E121A] border border-white/8 rounded-md px-2.5 py-2 space-y-1.5"
            >
              <div className="flex items-center justify-between text-[11px] text-[#9CA3AF]">
                <span>{coin.label}</span>
              </div>
              <div className="font-mono-tabular text-sm font-semibold text-[#F2E2B0]">
                {coin.value}
              </div>
              {onAdjustCurrency && <div className="flex items-center gap-1 pt-0.5">
                <button
                  type="button"
                  disabled={isMutating || campaign.status === 'archived'}
                  onClick={() => onAdjustCurrency({ [coin.key]: -1 })}
                  aria-label={`Reduzir 1 ${coin.label}`}
                  className="flex-1 h-7 flex items-center justify-center rounded bg-[#161B26] hover:bg-[#1F2636] text-[#C8C3B8] disabled:opacity-40 transition-colors cursor-pointer"
                >
                  <Minus className="w-3 h-3" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  disabled={isMutating || campaign.status === 'archived'}
                  onClick={() => onAdjustCurrency({ [coin.key]: 1 })}
                  aria-label={`Adicionar 1 ${coin.label}`}
                  className="flex-1 h-7 flex items-center justify-center rounded bg-[#161B26] hover:bg-[#1F2636] text-[#F2E2B0] disabled:opacity-40 transition-colors cursor-pointer"
                >
                  <Plus className="w-3 h-3" aria-hidden="true" />
                </button>
              </div>}
            </div>
          ))}
        </div>
      </div>

      {/* Personagens iniciais e relações do mundo */}
      <div className="space-y-2.5 border-t border-white/8 pt-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-[#EDE8DC]">
            <Users className="w-3.5 h-3.5 text-[#D4AF37]" aria-hidden="true" />
            <span>Personagens Conhecidos</span>
          </div>
          <span className="font-mono-tabular text-xs text-[#9CA3AF]">{npcs.length}</span>
        </div>

        {npcs.length === 0 ? (
          <p className="text-xs text-[#9CA3AF]">
            Nenhum personagem registrado nesta campanha até o momento.
          </p>
        ) : (
          <ul className="divide-y divide-white/8">
            {npcs.map((npc) => (
              <li key={npc.id} className="py-2.5 first:pt-1 last:pb-0 space-y-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-[#EDE8DC]">{npc.name}</span>
                  <span className="text-xs text-[#D4AF37]/90 truncate">{npc.role}</span>
                </div>
                <p className="text-xs text-[#9CA3AF]">
                  {npc.location} · {npc.relationship}
                </p>
                {npc.notes && (
                  <p className="text-xs text-[#B7B2A6] leading-relaxed pt-0.5">{npc.notes}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
