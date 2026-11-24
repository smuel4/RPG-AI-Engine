import { useState, type FormEvent } from 'react';
import { RotateCcw, Save, X } from 'lucide-react';
import type { Campaign } from '../types/game';
import type { CheckpointSummary } from '../engine/pilotCheckpoint';
import { formatWorldTimeLabel } from '../engine/constants';

interface CheckpointModalProps {
  mode: 'save' | 'load' | null;
  campaign: Campaign;
  checkpoints: CheckpointSummary[];
  isMutating: boolean;
  onClose: () => void;
  onSaveCheckpoint: (label: string, note: string) => Promise<boolean>;
  onRestoreCheckpoint: (checkpointId: string) => Promise<boolean>;
}

export function CheckpointModal({
  mode,
  campaign,
  checkpoints,
  isMutating,
  onClose,
  onSaveCheckpoint,
  onRestoreCheckpoint,
}: CheckpointModalProps) {
  const [label, setLabel] = useState(
    `Manhã em ${campaign.currentLocation} (Rev. ${campaign.revision})`,
  );
  const [note, setNote] = useState('');

  if (!mode) return null;

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await onSaveCheckpoint(label, note);
    if (ok) {
      setNote('');
      onClose();
    }
  };

  const handleRestore = async (cp: CheckpointSummary) => {
    if (!window.confirm(`Restaurar "${cp.label}"? A campanha continuará em uma nova linha temporal.`)) return;
    const ok = await onRestoreCheckpoint(cp.id);
    if (ok) {
      onClose();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="checkpoint-modal-title"
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4"
    >
      <div className="w-full max-w-xl max-h-[85vh] bg-[#121620] border border-[#D4AF37]/25 rounded-xl flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between gap-4">
          <div>
            <h2
              id="checkpoint-modal-title"
              className="font-display text-lg font-semibold text-[#F6E8B1]"
            >
              {mode === 'save'
                ? 'Salvar Ponto de Controle'
                : 'Carregar Ponto de Controle'}
            </h2>
            <p className="text-xs text-[#9CA3AF]">
              {mode === 'save'
                ? 'Grava no Firestore uma cópia estruturada completa de personagem, moedas, inventário, NPCs e horário.'
                : 'Restaura o estado estruturado da campanha a partir de um snapshot salvo no Firestore.'}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar janela de ponto de controle"
            className="p-2 rounded-md text-[#9CA3AF] hover:text-[#EDE8DC] hover:bg-white/5 cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {mode === 'save' ? (
            <form onSubmit={handleSave} className="space-y-4">
              <div className="bg-[#0E121A] border border-white/8 rounded-lg p-3.5 text-xs text-[#C8C3B8] space-y-1">
                <p>
                  <span className="text-[#9CA3AF]">Campanha:</span> {campaign.name}
                </p>
                <p>
                  <span className="text-[#9CA3AF]">Momento do mundo:</span>{' '}
                  {formatWorldTimeLabel(campaign.worldTime)}
                </p>
                <p className="font-mono-tabular">
                  <span className="text-[#9CA3AF] font-sans">Revisão atual:</span>{' '}
                  {campaign.revision}
                </p>
              </div>

              <div className="space-y-1">
                <label htmlFor="cp-label" className="block text-xs text-[#B7B2A6]">
                  Nome do ponto de controle
                </label>
                <input
                  id="cp-label"
                  type="text"
                  required
                  maxLength={80}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded bg-[#0E121A] border border-white/10 text-[#EDE8DC] focus:outline-none focus:border-[#D4AF37]"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="cp-note" className="block text-xs text-[#B7B2A6]">
                  Observação (opcional)
                </label>
                <textarea
                  id="cp-note"
                  rows={2}
                  maxLength={240}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Ex.: Antes de testar alterações no inventário."
                  className="w-full px-3 py-2 text-sm rounded bg-[#0E121A] border border-white/10 text-[#EDE8DC] placeholder:text-[#6B7280] focus:outline-none focus:border-[#D4AF37] resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-medium rounded border border-white/10 text-[#C8C3B8] hover:text-[#EDE8DC] cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isMutating}
                  className="px-4 py-2 inline-flex items-center gap-1.5 text-xs font-semibold rounded bg-[#D4AF37] text-[#0B0D12] hover:bg-[#E2C258] disabled:opacity-50 cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{isMutating ? 'Salvando...' : 'Salvar Checkpoint'}</span>
                </button>
              </div>
            </form>
          ) : checkpoints.length === 0 ? (
            <div className="py-10 text-center space-y-2 border border-dashed border-white/10 rounded-lg">
              <p className="text-sm text-[#C8C3B8]">
                Nenhum ponto de controle salvo para esta campanha ainda.
              </p>
              <p className="text-xs text-[#9CA3AF]">
                Use o botão "Salvar" para gravar um ponto de restauração no Firestore.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-white/8 border border-white/8 rounded-lg bg-[#0E121A]">
              {checkpoints.map((cp) => (
                <li
                  key={cp.id}
                  className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="space-y-1 min-w-0">
                    <p className="text-sm font-semibold text-[#F2E2B0]">{cp.label}</p>
                    <p className="text-xs text-[#B7B2A6]">
                      {cp.currentLocation} · {formatWorldTimeLabel(cp.worldTime)}
                    </p>
                    <p className="font-mono-tabular text-[11px] text-[#9CA3AF]">
                      Rev. {cp.revision} · {cp.inventoryCount} itens ·{' '}
                      {cp.currency.gold}o {cp.currency.silver}p {cp.currency.copper}c
                    </p>
                    {cp.note && (
                      <p className="text-xs text-[#C8C3B8] pt-0.5">{cp.note}</p>
                    )}
                  </div>

                  <button
                    type="button"
                    disabled={isMutating}
                    onClick={() => void handleRestore(cp)}
                    className="px-3.5 py-2 inline-flex items-center justify-center gap-1.5 text-xs font-semibold rounded bg-[#D4AF37] text-[#0B0D12] hover:bg-[#E2C258] disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{isMutating ? 'Restaurando...' : 'Carregar'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
