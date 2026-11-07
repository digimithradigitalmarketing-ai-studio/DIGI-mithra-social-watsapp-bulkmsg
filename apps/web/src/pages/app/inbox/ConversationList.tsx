import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { ConversationDto, InboxCountsDto } from '@socialpilot/shared';
import { get, getPage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Input, NativeSelect } from '@/components/ui/input';
import { Avatar, Skeleton } from '@/components/ui/misc';
import { formatPhone } from '../contacts/shared';
import { relTime } from './inboxUtils';

type View = 'all' | 'mine' | 'unassigned';

/** Left panel: search, view and status filters, and the conversation list. Data comes from the existing inbox endpoints. */
export function ConversationList({ activeId }: { activeId?: string }) {
  const b = useWorkspace();
  const navigate = useNavigate();
  const [view, setView] = useState<View>('all');
  const [status, setStatus] = useState<'active' | 'closed'>('active');
  const [q, setQ] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const counts = useQuery({ queryKey: ['inbox-counts', b.id], queryFn: () => get<InboxCountsDto>(`/v1/businesses/${b.id}/inbox/counts`), refetchInterval: 5000 });
  const list = useQuery({
    queryKey: ['conversations', b.id, view, status, q],
    queryFn: () => getPage<ConversationDto[]>(`/v1/businesses/${b.id}/conversations?view=${view}&status=${status}&pageSize=50${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    refetchInterval: 5000,
  });
  const views: Array<{ k: View; label: string; n?: number }> = [
    { k: 'all', label: 'All', n: counts.data?.all },
    { k: 'mine', label: 'Mine', n: counts.data?.mine },
    { k: 'unassigned', label: 'Unassigned', n: counts.data?.unassigned },
  ];
  const rows = (list.data?.data ?? []).filter((c) => !unreadOnly || c.unreadCount > 0);

  return (
    <section className={cn('flex w-full flex-col bg-wa-sidebar md:w-[22rem] md:shrink-0 md:border-r md:border-wa-border', activeId && 'hidden md:flex')} aria-label="Conversations">
      <header className="space-y-2 bg-wa-header px-3 py-2.5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-wa-text">Chats</h2>
          <span className="text-xs text-wa-text-muted">{counts.data ? `${counts.data.unread} unread` : ''}</span>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 size-4 text-wa-text-muted" aria-hidden />
          <Input className="h-9 rounded-lg border-0 bg-wa-sidebar pl-8 text-wa-text placeholder:text-wa-text-muted" placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs" role="tablist" aria-label="Filter conversations">
          {views.map((v) => (
            <button key={v.k} role="tab" aria-selected={view === v.k} onClick={() => setView(v.k)}
              className={cn('rounded-full px-2.5 py-1 font-medium', view === v.k ? 'bg-wa-accent text-white' : 'bg-wa-sidebar text-wa-text-muted hover:text-wa-text')}>
              {v.label}{v.n != null && <span className="ml-1 opacity-80">{v.n}</span>}
            </button>
          ))}
          <button role="tab" aria-selected={unreadOnly} onClick={() => setUnreadOnly((x) => !x)}
            className={cn('rounded-full px-2.5 py-1 font-medium', unreadOnly ? 'bg-wa-accent text-white' : 'bg-wa-sidebar text-wa-text-muted hover:text-wa-text')}>
            Unread
          </button>
          <NativeSelect className="ml-auto h-7 w-24 text-xs" value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'closed')} aria-label="Status filter">
            <option value="active">Open</option><option value="closed">Closed</option>
          </NativeSelect>
        </div>
      </header>
      <ul className="flex-1 overflow-y-auto">
        {list.isLoading && <li className="space-y-2 p-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</li>}
        {list.isError && <li className="p-6 text-center text-sm text-destructive">Could not load conversations. Refresh to try again.</li>}
        {!list.isLoading && rows.length === 0 && <li className="p-6 text-center text-sm text-wa-text-muted">{unreadOnly ? 'No unread conversations' : 'No conversations'}</li>}
        {rows.map((c) => (
          <li key={c.id}>
            <button onClick={() => navigate(`/w/${b.id}/inbox/${c.id}`)} aria-current={c.id === activeId ? 'true' : undefined}
              className={cn('flex w-full gap-3 px-3 py-2.5 text-left hover:bg-wa-hover', c.id === activeId && 'bg-wa-selected')}>
              <Avatar name={c.contact.name || c.contact.phone} className="size-11 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className={cn('truncate text-sm text-wa-text', c.unreadCount ? 'font-semibold' : 'font-medium')}>{c.contact.name || formatPhone(c.contact.phone)}</span>
                  <span className={cn('ml-auto shrink-0 text-xs', c.unreadCount ? 'text-wa-accent' : 'text-wa-text-muted')}>{relTime(c.lastMessageAt)}</span>
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span className="truncate text-xs text-wa-text-muted">{c.lastMessagePreview ?? 'No messages yet'}</span>
                  {c.unreadCount > 0 && <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-wa-primary px-1 text-[10px] font-semibold text-white">{c.unreadCount}</span>}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-wa-text-muted">
                  {c.aiHandoffReason && <span className="rounded bg-amber-100 px-1 font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300" title={c.aiHandoffReason}>Needs a person</span>}
                  {c.windowOpen ? <span className="text-wa-accent">24h window open</span> : <span>Template only</span>}
                  {c.assignedTo && <span className="truncate">· {c.assignedTo.name}</span>}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
