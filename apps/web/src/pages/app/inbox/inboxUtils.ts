import type { ConversationDto } from '@socialpilot/shared';

export function relTime(iso: string | null): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(new Date(iso));
}

/** Human label for the customer-service window, or null when it is closed. */
export function windowLabel(c: ConversationDto): string | null {
  if (!c.windowExpiresAt) return null;
  const ms = new Date(c.windowExpiresAt).getTime() - Date.now();
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m left to reply freely` : `${m}m left to reply freely`;
}

/** YYYY-MM-DD in the workspace timezone, used to group messages by day. */
export function dayKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

export function dayLabel(iso: string, timeZone: string, now = new Date()): string {
  const key = dayKey(iso, timeZone);
  if (key === dayKey(now.toISOString(), timeZone)) return 'Today';
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (key === dayKey(yesterday.toISOString(), timeZone)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-IN', { timeZone, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
}
