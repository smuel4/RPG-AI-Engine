import { useState, type FormEvent } from 'react';
import { FolderPlus, Sparkles, Trash2, X } from 'lucide-react';
import type { Campaign } from '../types/game';
import { formatWorldTimeLabel } from '../engine/constants';
import type { CustomCampaignDraft } from '../engine/echoArcFixture';

interface CampaignHubModalProps {
  isOpen: boolean;
  campaigns: Campaign[];
  activeCampaignId: string | null;
  isMutating: boolean;
  onClose: () => void;
  onSelectCampaign: (campaignId: string) => void;
  onCreateEchoArc: () => Promise<void>;
  onCreateCustomCampaign: (draft: CustomCampaignDraft) => Promise<boolean>;
  onDeleteCampaign: (campaignId: string) => Promise<void>;
}

export function CampaignHubModal({
  isOpen,
  campaigns,
  activeCampaignId,
  isMutating,
  onClose,
  onSelectCampaign,
  onCreateEchoArc,
  onCreateCustomCampaign,
  onDeleteCampaign,
}: CampaignHubModalProps) {
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [name, setName] = useState('');
  const [setting, setSetting] = useState('Fantasia medieval com vilas, magia e exploração');
  const [currentLocation, setCurrentLocation] = useState('Vila Inicial');
  const [protagonistName, setProtagonistName] = useState('');
  const [protagonistAge, setProtagonistAge] = useState('18');
  const [protagonistOrigin, setProtagonistOrigin] = useState('Viajante jovem');
  const [futureHook, setFutureHook] = useState('');

  if (!isOpen) return null;

  const handleCustomSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await onCreateCustomCampaign({
      name,
      setting,
      currentLocation,
      protagonistName,
      protagonistAge: Number(protagonistAge),
      protagonistOrigin,
      futureHook,
    });
    if (ok) {
      setShowCustomForm(false);
      setName('');
      setProtagonistName('');
      setFutureHook('');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="campaign-hub-title"
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4"
    >
      <div className="w-full max-w-2xl max-h-[88vh] bg-[#121620] border border-[#D4AF37]/25 rounded-xl flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between gap-4">
          <div>
            <h2
              id="campaign-hub-title"
              className="font-display text-lg font-semibold text-[#F6E8B1]"
            >
              Campanhas da Conta
            </h2>
            <p className="text-xs text-[#9CA3AF]">
              Cada campanha possui identificador independente e estado persistente no Firestore.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar janela de campanhas"
            className="p-2 rounded-md text-[#9CA3AF] hover:text-[#EDE8DC] hover:bg-white/5 cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Ações de criação */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              disabled={isMutating}
              onClick={() => void onCreateEchoArc()}
              className="p-4 rounded-lg border border-[#D4AF37]/40 bg-[#D4AF37]/10 hover:bg-[#D4AF37]/15 text-left space-y-1 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-[#F6E8B1]">
                <Sparkles className="w-4 h-4 text-[#D4AF37]" aria-hidden="true" />
                <span>Criar Campanha ECHO ARC</span>
              </div>
              <p className="text-xs text-[#C8C3B8]">
                Samuel (18 anos) · Vila de Freixo · Teresa e Henrique · Academia de Arvend.
              </p>
            </button>

            <button
              type="button"
              disabled={isMutating}
              onClick={() => setShowCustomForm((prev) => !prev)}
              className="p-4 rounded-lg border border-white/12 bg-[#0E121A] hover:border-[#D4AF37]/35 text-left space-y-1 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-[#EDE8DC]">
                <FolderPlus className="w-4 h-4 text-[#D4AF37]" aria-hidden="true" />
                <span>{showCustomForm ? 'Ocultar Formulário' : 'Nova Campanha Personalizada'}</span>
              </div>
              <p className="text-xs text-[#9CA3AF]">
                Defina nome, ambientação, local inicial e protagonista próprios.
              </p>
            </button>
          </div>

          {showCustomForm && (
            <form
              onSubmit={handleCustomSubmit}
              className="bg-[#0E121A] border border-white/10 rounded-lg p-4 space-y-3"
            >
              <p className="text-xs font-semibold text-[#F2E2B0]">
                Configurar Nova Campanha
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="camp-name" className="block text-xs text-[#B7B2A6]">
                    Nome da campanha
                  </label>
                  <input
                    id="camp-name"
                    type="text"
                    required
                    maxLength={80}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ex.: Crônicas de Valen"
                    className="w-full px-3 py-2 text-xs rounded bg-[#141924] border border-white/10 text-[#EDE8DC] focus:outline-none focus:border-[#D4AF37]"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="camp-location" className="block text-xs text-[#B7B2A6]">
                    Local inicial
                  </label>
                  <input
                    id="camp-location"
                    type="text"
                    required
                    maxLength={120}
                    value={currentLocation}
                    onChange={(e) => setCurrentLocation(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded bg-[#141924] border border-white/10 text-[#EDE8DC] focus:outline-none focus:border-[#D4AF37]"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label htmlFor="camp-setting" className="block text-xs text-[#B7B2A6]">
                  Ambientação
                </label>
                <input
                  id="camp-setting"
                  type="text"
                  required
                  maxLength={240}
                  value={setting}
                  onChange={(e) => setSetting(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded bg-[#141924] border border-white/10 text-[#EDE8DC] focus:outline-none focus:border-[#D4AF37]"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2 space-y-1">
                  <label htmlFor="camp-protag" className="block text-xs text-[#B7B2A6]">
                    Nome do protagonista
                  </label>
                  <input
                    id="camp-protag"
                    type="text"
                    required
                    maxLength={80}
                    value={protagonistName}
                    onChange={(e) => setProtagonistName(e.target.value)}
                    placeholder="Ex.: Lucas"
                    className="w-full px-3 py-2 text-xs rounded bg-[#141924] border border-white/10 text-[#EDE8DC] focus:outline-none focus:border-[#D4AF37]"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="camp-age" className="block text-xs text-[#B7B2A6]">
                    Idade
                  </label>
                  <input
                    id="camp-age"
                    type="number"
                    min={1}
                    max={200}
                    required
                    value={protagonistAge}
                    onChange={(e) => setProtagonistAge(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono-tabular rounded bg-[#141924] border border-white/10 text-[#EDE8DC] focus:outline-none focus:border-[#D4AF37]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="camp-origin" className="block text-xs text-[#B7B2A6]">
                    Origem
                  </label>
                  <input
                    id="camp-origin"
                    type="text"
                    required
                    maxLength={240}
                    value={protagonistOrigin}
                    onChange={(e) => setProtagonistOrigin(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded bg-[#141924] border border-white/10 text-[#EDE8DC] focus:outline-none focus:border-[#D4AF37]"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="camp-hook" className="block text-xs text-[#B7B2A6]">
                    Horizonte futuro (opcional)
                  </label>
                  <input
                    id="camp-hook"
                    type="text"
                    maxLength={240}
                    value={futureHook}
                    onChange={(e) => setFutureHook(e.target.value)}
                    placeholder="Ex.: Guilda dos Cartógrafos"
                    className="w-full px-3 py-2 text-xs rounded bg-[#141924] border border-white/10 text-[#EDE8DC] focus:outline-none focus:border-[#D4AF37]"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isMutating}
                className="w-full py-2.5 text-xs font-semibold rounded bg-[#D4AF37] text-[#0B0D12] hover:bg-[#E2C258] disabled:opacity-50 transition-colors cursor-pointer"
              >
                {isMutating ? 'Criando...' : 'Criar e Abrir Campanha'}
              </button>
            </form>
          )}

          {/* Lista de campanhas persistidas */}
          <div className="space-y-2.5">
            <h3 className="text-xs font-semibold text-[#C8C3B8]">
              Suas Campanhas Salvas ({campaigns.length})
            </h3>

            {campaigns.length === 0 ? (
              <p className="text-xs text-[#9CA3AF] py-6 text-center border border-dashed border-white/10 rounded-lg">
                Nenhuma campanha encontrada nesta conta. Crie a campanha de teste ECHO ARC acima.
              </p>
            ) : (
              <ul className="divide-y divide-white/8 border border-white/8 rounded-lg bg-[#0E121A]">
                {campaigns.map((camp) => {
                  const isActive = camp.id === activeCampaignId;
                  return (
                    <li
                      key={camp.id}
                      className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-display text-sm font-semibold text-[#F2E2B0]">
                            {camp.name}
                          </span>
                          {isActive && (
                            <span className="text-[11px] font-medium text-emerald-400">
                              · Ativa
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[#B7B2A6]">
                          {camp.protagonist.name} · {camp.currentLocation} ·{' '}
                          {formatWorldTimeLabel(camp.worldTime)}
                        </p>
                        <p className="font-mono-tabular text-[11px] text-[#6B7280] truncate">
                          ID: {camp.id} · Revisão {camp.revision}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            onSelectCampaign(camp.id);
                            onClose();
                          }}
                          className={`px-3.5 py-1.5 text-xs font-semibold rounded transition-colors cursor-pointer whitespace-nowrap ${
                            isActive
                              ? 'bg-white/10 text-[#EDE8DC]'
                              : 'bg-[#D4AF37] text-[#0B0D12] hover:bg-[#E2C258]'
                          }`}
                        >
                          {isActive ? 'Selecionada' : 'Abrir'}
                        </button>
                        <button
                          type="button"
                          disabled={isMutating}
                          onClick={() => void onDeleteCampaign(camp.id)}
                          aria-label={`Excluir campanha ${camp.name}`}
                          className="p-2 rounded text-[#9CA3AF] hover:text-red-400 hover:bg-red-950/40 disabled:opacity-40 transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" aria-hidden="true" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
