import { Check, CheckCheck, Clock, RotateCcw, XCircle, StickyNote } from 'lucide-react';
import type { InboxMessageDto } from '@socialpilot/shared';
import { cn, formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/** Delivery state from the database / webhooks. Never inferred on the client. */
export function DeliveryIcon({ status }: { status: string }) {
  if (status === 'queued' || status === 'sending') return <Clock className="size-3" aria-label="Sending" />;
  if (status === 'sent') return <Check className="size-3" aria-label="Sent" />;
  if (status === 'delivered') return <CheckCheck className="size-3" aria-label="Delivered" />;
  if (status === 'read') return <CheckCheck className="size-3 text-wa-read" aria-label="Read" />;
  if (status === 'failed') return <XCircle className="size-3 text-destructive" aria-label="Failed" />;
  return null;
}

export function DateSeparator({ label }: { label: string }) {
  return (
    <div className="sticky top-2 z-10 my-3 flex justify-center" role="separator" aria-label={label}>
      <span className="rounded-md bg-wa-bubble-in px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-wa-text-muted shadow-sm">{label}</span>
    </div>
  );
}

export function InternalNote({ author, body, at, timezone }: { author: string | null; body: string; at: string; timezone: string }) {
  return (
    <div className="mx-auto max-w-md rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
      <p className="mb-0.5 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide opacity-70"><StickyNote className="size-3" /> Internal note · {author ?? 'Team'}</p>
      <p className="whitespace-pre-wrap break-words">{body}</p>
      <p className="mt-1 text-right text-[10px] opacity-60">{formatDateTime(at, timezone)}</p>
    </div>
  );
}

/** Text and template messages are the only types stored today; anything else shows as a labelled placeholder. */
export function MessageBubble({ m, timezone, onRetry, retrying }: { m: InboxMessageDto; timezone: string; onRetry?: (m: InboxMessageDto) => void; retrying?: boolean }) {
  const outbound = m.direction === 'outbound';
  const failed = outbound && m.status === 'failed';
  return (
    <div className={cn('flex px-2 sm:px-6', outbound ? 'justify-end' : 'justify-start')} data-direction={m.direction}>
      <div className={cn(
        'relative max-w-[85%] min-w-0 rounded-lg px-2.5 py-1.5 text-sm text-wa-text shadow-sm sm:max-w-[65%]',
        outbound ? 'rounded-tr-none bg-wa-bubble-out' : 'rounded-tl-none bg-wa-bubble-in',
        failed && 'ring-1 ring-destructive',
      )}>
        {(m.campaignName || m.type === 'template') && (
          <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-wa-text-muted">{m.campaignName ? `Broadcast · ${m.campaignName}` : 'Template'}</p>
        )}
        {m.type !== 'text' && m.type !== 'template' && (
          <p className="mb-0.5 text-xs italic text-wa-text-muted">[{m.type} message: preview not available]</p>
        )}
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{m.body ?? ''}</p>
        <p className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-wa-text-muted">
          {outbound && m.sentByName && <span className="truncate">{m.sentByName} ·</span>}
          <span>{formatDateTime(m.createdAt, timezone)}</span>
          {outbound && <DeliveryIcon status={m.status} />}
        </p>
        {failed && (
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-destructive">
            <span>Not delivered{m.errorMessage ? `: ${m.errorMessage}` : ''}</span>
            {onRetry && m.type === 'text' && (
              <Button size="sm" variant="outline" className="h-7 border-destructive/40 text-destructive" loading={retrying} onClick={() => onRetry(m)}>
                <RotateCcw /> Retry
              </Button>
            )}
            {m.type === 'template' && <span className="text-wa-text-muted">Resend from the Template tab</span>}
          </div>
        )}
      </div>
    </div>
  );
}
