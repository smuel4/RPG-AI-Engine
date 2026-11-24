export const SERVER_PILOT_ID = 'echo-arc-server-pilot';

export function selectOwnedCampaignId(
  campaigns: readonly { id: string }[],
  selectedId: string | null,
  localFreixo: boolean,
): string | null {
  if (localFreixo) return campaigns.some(({ id }) => id === SERVER_PILOT_ID) ? SERVER_PILOT_ID : null;
  return selectedId && campaigns.some(({ id }) => id === selectedId) ? selectedId : campaigns[0]?.id ?? null;
}
