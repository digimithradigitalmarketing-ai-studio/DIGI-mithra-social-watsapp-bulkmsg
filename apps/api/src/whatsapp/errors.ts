/**
 * Classification of WhatsApp Cloud API errors.
 * Codes from Meta's "Error codes" reference for the Cloud API.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds?: number,
    /** Side effects the caller should apply */
    public readonly effect?: 'opt_out' | 'channel_auth' | 'template_unusable',
  ) {
    super(message);
  }
}

const RETRYABLE = new Set([
  1, 2, // API unknown / service temporarily unavailable
  4, // application request limit reached
  80007, // WABA rate limit
  130429, // throughput rate limit
  131000, // something went wrong
  131016, // service unavailable
  131056, // pair rate limit (same recipient too fast)
  133004, // server temporarily unavailable
]);

const PAIR_OR_RATE_DELAY: Record<number, number> = { 131056: 60, 130429: 5, 80007: 60, 4: 60 };

export function classifyMetaError(httpStatus: number, body: unknown): ProviderError {
  const err = (body as { error?: { code?: number; message?: string; error_data?: { details?: string } } })?.error;
  const code = err?.code;
  const message = [err?.message, err?.error_data?.details].filter(Boolean).join(' — ') || `HTTP ${httpStatus}`;
  if (code === undefined) {
    return new ProviderError(message, `http_${httpStatus}`, httpStatus >= 500 || httpStatus === 429);
  }
  if (RETRYABLE.has(code)) return new ProviderError(message, String(code), true, PAIR_OR_RATE_DELAY[code]);
  if (code === 131047) return new ProviderError('More than 24 hours since the customer last replied — use an approved template', String(code), false);
  if (code === 131050) return new ProviderError(message, String(code), false, undefined, 'opt_out');
  if (code === 190 || code === 10 || code === 200) return new ProviderError(message, String(code), false, undefined, 'channel_auth');
  if (code === 132001 || code === 132015 || code === 132016) return new ProviderError(message, String(code), false, undefined, 'template_unusable');
  return new ProviderError(message, String(code), httpStatus >= 500);
}
