import type { InventoryCategory, WorldTime } from '../types/game';

export const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const ROOT_TIMELINE_ID = 'tl_root';

export const LIMITS = {
  ID_MAX: 128,
  NAME_MAX: 80,
  SETTING_MAX: 240,
  LOCATION_MAX: 120,
  DESCRIPTION_MAX: 240,
  NOTES_MAX: 300,
  NARRATIVE_MAX: 2000,
  SUMMARY_MAX: 240,
  DIFF_SUMMARY_MAX: 400,
  MAX_INVENTORY_ITEMS: 100,
  MAX_QUANTITY: 99999,
  MAX_CURRENCY: 10000000,
  MAX_TIMELINE_SEGMENTS: 64,
  BETA_MAX_ATOMIC_RESTORE_SUBCOLLECTION_OPS: 18,
} as const;

export const INVENTORY_CATEGORY_LABELS: Record<InventoryCategory, string> = {
  equipamento: 'Equipamento',
  consumivel: 'Consumível',
  documento: 'Documento',
  recurso: 'Recurso',
  chave: 'Item-chave',
};

export const WORLD_WEEKDAYS = [
  'Solis',
  'Lunis',
  'Terris',
  'Ventis',
  'Ignis',
  'Auris',
  'Vesperis',
] as const;

export const WORLD_MONTHS = [
  'Alvorada',
  'Sementeira',
  'Broto',
  'Brisa',
  'Zênite',
  'Colheita',
  'Âmbar',
  'Folha-Seca',
  'Bruma',
  'Geada',
  'Solstício',
  'Vigília',
] as const;

export const WORLD_SEASONS = [
  'Primavera',
  'Primavera',
  'Primavera',
  'Verão',
  'Verão',
  'Verão',
  'Outono',
  'Outono',
  'Outono',
  'Inverno',
  'Inverno',
  'Inverno',
] as const;

export function createSafeId(prefix: string): string {
  const cleanPrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'id';
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  const ts = Date.now().toString(36);
  return `${cleanPrefix}_${ts}_${rand}`;
}

export function formatWorldClock(time: WorldTime): string {
  const hh = String(time.hour).padStart(2, '0');
  const mm = String(time.minute).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatWorldDate(time: WorldTime): string {
  const monthName = WORLD_MONTHS[time.month - 1] ?? `Mês ${time.month}`;
  return `Dia ${time.day} de ${monthName}, Ano ${time.year}`;
}

export function formatWorldTimeLabel(time: WorldTime): string {
  return `${formatWorldDate(time)} · ${formatWorldClock(time)} (${time.periodOfDay})`;
}

export function clampText(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}
