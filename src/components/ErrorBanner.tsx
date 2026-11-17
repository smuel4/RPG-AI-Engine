import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import type { PersistenceErrorState } from '../types/game';

interface ErrorBannerProps {
  error: PersistenceErrorState | string | null;
  onDismiss: () => void;
  onRetry?: () => void;
}

export function ErrorBanner({ error, onDismiss, onRetry }: ErrorBannerProps) {
  if (!error) return null;

  const normalized: PersistenceErrorState =
    typeof error === 'string'
      ? {
          title: 'Ação não confirmada',
          message: error,
          retryable: false,
        }
      : error;

  return (
    <div
      role="alert"
      className="border border-red-500/40 bg-red-950/50 text-red-100 px-4 py-3 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3"
    >
      <div className="flex items-start gap-3 min-w-0">
        <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-red-200">{normalized.title}</p>
          <p className="text-sm text-red-100/90 mt-0.5 break-words">{normalized.message}</p>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
        {normalized.retryable && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-red-500/20 hover:bg-red-500/30 text-red-100 border border-red-400/30 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            Tentar novamente
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Fechar aviso"
          className="p-1.5 rounded-md text-red-200/80 hover:text-red-100 hover:bg-red-500/20 transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
