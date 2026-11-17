import { BookOpen, Database, ShieldCheck } from 'lucide-react';
import { ErrorBanner } from './ErrorBanner';

interface AuthScreenProps {
  loading: boolean;
  authError: string | null;
  onSignIn: () => void;
  onClearError: () => void;
}

export function AuthScreen({
  loading,
  authError,
  onSignIn,
  onClearError,
}: AuthScreenProps) {
  return (
    <div className="min-h-screen bg-[#0B0D12] text-[#EDE8DC] flex flex-col">
      <header className="w-full border-b border-[#D4AF37]/15 bg-[#0E121A]">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between gap-8">
          <span className="font-display text-lg font-semibold tracking-wide text-[#F2E2B0] whitespace-nowrap shrink-0">
            RPG AI Engine
          </span>
          <span className="hidden sm:inline text-xs text-[#9CA3AF] whitespace-nowrap shrink-0">
            Base Estruturada · Cloud Firestore
          </span>
          <button
            type="button"
            disabled={loading}
            onClick={onSignIn}
            className="px-4 py-1.5 text-xs font-semibold rounded-md bg-[#D4AF37] text-[#0B0D12] hover:bg-[#E2C258] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Entrar com Google
          </button>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-2xl space-y-8">
          {authError && (
            <ErrorBanner error={authError} onDismiss={onClearError} />
          )}

          <div className="border border-[#D4AF37]/20 bg-[#121620] rounded-xl p-8 sm:p-10 space-y-6">
            <div className="space-y-3">
              <p className="text-xs font-medium tracking-wider text-[#D4AF37]">
                PRIMEIRO MARCO FUNCIONAL · ECHO ARC
              </p>
              <h1 className="font-display text-3xl sm:text-4xl font-semibold text-[#F6E8B1] leading-tight text-balance">
                Motor narrativo de RPG com memória persistente
              </h1>
              <p className="text-base text-[#C8C3B8] leading-relaxed">
                Cada campanha opera sobre dados estruturados no Cloud Firestore — personagem,
                inventário, moedas, calendário e registro de eventos auditáveis — preservando o
                controle exclusivo do jogador sobre todas as decisões de Samuel.
              </p>
            </div>

            <div className="border-t border-white/8 pt-6 grid grid-cols-1 sm:grid-cols-3 gap-6">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-sm font-semibold text-[#EDE8DC]">
                  <ShieldCheck className="w-4 h-4 text-[#D4AF37] shrink-0" aria-hidden="true" />
                  <span>Regras Determinísticas</span>
                </div>
                <p className="text-xs text-[#9CA3AF] leading-relaxed">
                  Ações inválidas não alteram o estado e o narrador nunca inventa escolhas do
                  protagonista.
                </p>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-sm font-semibold text-[#EDE8DC]">
                  <Database className="w-4 h-4 text-[#D4AF37] shrink-0" aria-hidden="true" />
                  <span>Persistência Real</span>
                </div>
                <p className="text-xs text-[#9CA3AF] leading-relaxed">
                  Campanhas independentes, pontos de controle manuais e recuperação imediata entre
                  sessões.
                </p>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-sm font-semibold text-[#EDE8DC]">
                  <BookOpen className="w-4 h-4 text-[#D4AF37] shrink-0" aria-hidden="true" />
                  <span>Pronto para Etapa 2</span>
                </div>
                <p className="text-xs text-[#9CA3AF] leading-relaxed">
                  Narrativa inicial fixa para validação estrutural antes de conectar a Gemini API.
                </p>
              </div>
            </div>

            <div className="border-t border-white/8 pt-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <p className="text-xs text-[#9CA3AF]">
                Autenticação segura via conta Google vinculada ao Firebase.
              </p>
              <button
                type="button"
                disabled={loading}
                onClick={onSignIn}
                className="px-6 py-3 text-sm font-semibold rounded-lg bg-[#D4AF37] text-[#0B0D12] hover:bg-[#E2C258] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F2E2B0]"
              >
                {loading ? 'Verificando sessão...' : 'Entrar com Google'}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
