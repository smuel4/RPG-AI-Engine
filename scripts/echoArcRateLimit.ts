function resetMs(header: string | null): number {
  if (!header) return 0;
  if (/^\d+(?:\.\d+)?$/.test(header)) return Number(header) * 1000;
  const scale: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
  const parts = [...header.matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/g)];
  if (parts.map((part) => part[0]).join('') !== header) return 0;
  return parts.reduce((sum, [, value, unit]) => sum + Number(value) * scale[unit], 0);
}

export function nextGroqAttempt(headers: Headers, status: number, now: number, maxOutputTokens: number): number {
  const retryAfter = headers.get('retry-after');
  const retryMs = !retryAfter ? 0 : /^\d+(?:\.\d+)?$/.test(retryAfter)
    ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - now) || 0;
  const requests = headers.get('x-ratelimit-remaining-requests');
  const tokens = headers.get('x-ratelimit-remaining-tokens');
  // Previous runs needed up to 1,256 prompt tokens. Reserve room for prompt edits.
  const requestReset = requests !== null && Number(requests) < 1
    ? resetMs(headers.get('x-ratelimit-reset-requests')) : 0;
  const tokenReset = tokens !== null && Number(tokens) < 1600 + maxOutputTokens
    ? resetMs(headers.get('x-ratelimit-reset-tokens')) : 0;
  const minimum = status === 429 && !retryMs ? 60_000 : 20_000;
  return now + Math.ceil(Math.max(minimum, retryMs, requestReset, tokenReset));
}
