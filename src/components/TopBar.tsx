import type { SyncState } from '../types/game';

interface TopBarProps {
  campaignName: string | null;
  syncState: SyncState;
  userEmail: string | null;
  hasCampaign: boolean;
  onOpenSaveCheckpoint: () => void;
  onOpenLoadCheckpoint: () => void;
  onOpenCampaigns: () => void;
  onSignOut: () => void;
}

const SYNC_LABELS: Record<SyncState, string> = {
  idle: 'Pronto',
  saving: 'Salvando no Firestore...',
  synced: 'Sincronizado',
  error: 'Falha ao salvar',
};

export function TopBar({
  campaignName,
  syncState,
  userEmail,
  hasCampaign,
  onOpenSaveCheckpoint,
  onOpenLoadCheckpoint,
  onOpenCampaigns,
  onSignOut,
}: TopBarProps) {
  return (
    <header className="w-full border-b border-[#D4AF37]/15 bg-[#0E121A]">
      <div className="max-w-[1600px] mx-auto px-4 lg:px-6 h-14 flex items-center justify-between gap-4 lg:gap-8">
        {/* Zona 1: Marca (elemento único em linha única) */}
        <span className="font-display text-base sm:text-lg font-semibold tracking-wide text-[#F2E2B0] whitespace-nowrap shrink-0">
          RPG AI Engine
        </span>

        {/* Zona 2: Links de navegação funcional em linha única */}
        <nav
          aria-label="Ações da campanha"
          className="hidden md:flex items-center gap-6 text-sm text-[#B7B2A6]"
        >
          {hasCampaign && (
            <>
              <button
                type="button"
                onClick={onOpenSaveCheckpoint}
                className="hover:text-[#F2E2B0] transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D4AF37] rounded px-1 py-1"
              >
                Salvar
              </button>
              <button
                type="button"
                onClick={onOpenLoadCheckpoint}
                className="hover:text-[#F2E2B0] transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D4AF37] rounded px-1 py-1"
              >
                Carregar
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onOpenCampaigns}
            className="hover:text-[#F2E2B0] transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D4AF37] rounded px-1 py-1"
          >
            Campanhas
          </button>
          <span
            className={`text-xs whitespace-nowrap shrink-0 ${
              syncState === 'error'
                ? 'text-red-400'
                : syncState === 'saving'
                  ? 'text-amber-300'
                  : 'text-emerald-400/90'
            }`}
          >
            {campaignName ? `${campaignName} · ${SYNC_LABELS[syncState]}` : SYNC_LABELS[syncState]}
          </span>
          {userEmail && (
            <button
              type="button"
              onClick={onSignOut}
              className="hover:text-[#EDE8DC] transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D4AF37] rounded px-1 py-1"
            >
              Sair
            </button>
          )}
        </nav>

        {/* Zona 3: Ação principal */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onOpenCampaigns}
            className="px-4 py-1.5 text-xs sm:text-sm font-semibold rounded-md bg-[#D4AF37] text-[#0B0D12] hover:bg-[#E2C258] transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F2E2B0]"
          >
            {hasCampaign ? 'Trocar Campanha' : 'Criar Campanha'}
          </button>
        </div>
      </div>
    </header>
  );
}
