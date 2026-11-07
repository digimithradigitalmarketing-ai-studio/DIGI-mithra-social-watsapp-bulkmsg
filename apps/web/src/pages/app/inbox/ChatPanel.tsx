import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Check, Lock, Search, UserRound, X } from 'lucide-react';
import { can, type ConversationDetailDto, type InboxMessageDto, type MemberDto } from '@socialpilot/shared';
import { get, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { handleFormError } from '@/lib/forms';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { Avatar, EmptyState, Skeleton } from '@/components/ui/misc';
import { formatPhone } from '../contacts/shared';
import { ContactPanel } from './ContactPanel';
import { MessageComposer } from './MessageComposer';
import { DateSeparator, InternalNote, MessageBubble } from './MessageBubble';
import { dayKey, dayLabel, windowLabel } from './inboxUtils';

/** Centre panel for one conversation: header, searchable history, composer and the contact details. */
export function ChatPanel({ id }: { id: string }) {
  const b = useWorkspace();
  const { me } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const endRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['conversation', id], queryFn: () => get<ConversationDetailDto>(`/v1/businesses/${b.id}/conversations/${id}`), refetchInterval: 3000, retry: false });
  const members = useQuery({ queryKey: ['members', b.id], queryFn: () => get<MemberDto[]>(`/v1/businesses/${b.id}/members`) });
  const invalidate = () => Promise.all([qc.invalidateQueries({ queryKey: ['conversation', id] }), qc.invalidateQueries({ queryKey: ['conversations', b.id] }), qc.invalidateQueries({ queryKey: ['inbox-counts', b.id] })]);

  const unread = q.data?.conversation.unreadCount ?? 0;
  useEffect(() => {
    if (unread > 0) void post(`/v1/businesses/${b.id}/conversations/${id}/read`).then(() => qc.invalidateQueries({ queryKey: ['inbox-counts', b.id] }));
  }, [unread, b.id, id, qc]);
  const lastCount = q.data ? q.data.messages.length + q.data.notes.length : 0;
  useEffect(() => { if (!search) endRef.current?.scrollIntoView({ block: 'end' }); }, [lastCount, search]);

  const assign = useMutation({
    mutationFn: (userId: string | null) => post<ConversationDetailDto['conversation'] | null>(`/v1/businesses/${b.id}/conversations/${id}/assign`, { userId }),
    onSuccess: async (c) => { await invalidate(); toast.success(c?.assignedTo ? `Assigned to ${c.assignedTo.name}` : c ? 'Unassigned' : 'Reassigned'); if (!c) navigate(`/w/${b.id}/inbox`); },
    onError: (e) => handleFormError(e),
  });
  const setStatus = useMutation({
    mutationFn: (status: string) => post(`/v1/businesses/${b.id}/conversations/${id}/status`, { status }),
    onSuccess: invalidate,
    onError: (e) => handleFormError(e),
  });
  const resend = useMutation({
    mutationFn: (m: InboxMessageDto) => post(`/v1/businesses/${b.id}/conversations/${id}/messages`, { type: 'text', body: m.body ?? '', clientId: crypto.randomUUID() }),
    onMutate: (m) => setRetryingId(m.id),
    onSettled: () => setRetryingId(null),
    onSuccess: invalidate,
    onError: (e) => handleFormError(e),
  });
  const retry = (m: InboxMessageDto) => {
    if (!q.data?.conversation.windowOpen) return toast.error('The 24-hour window has closed. Send an approved template instead.');
    resend.mutate(m);
  };

  if (q.isLoading) return <div className="flex-1 bg-wa-wallpaper p-6"><Skeleton className="h-full" /></div>;
  if (!q.data) return <div className="flex flex-1 items-center justify-center bg-wa-wallpaper p-6"><EmptyState icon={<Lock />} title="Conversation unavailable" description="It may have been reassigned to someone else." /></div>;
  const { conversation: c, contact, messages, notes } = q.data;
  const canAssignOthers = can(b.myRole, 'conversations.assign');
  const timeline = useMemo(() => [
    ...messages.map((m) => ({ kind: 'msg' as const, at: m.createdAt, m })),
    ...notes.map((n) => ({ kind: 'note' as const, at: n.createdAt, n })),
  ].sort((a, z) => a.at.localeCompare(z.at)), [messages, notes]);
  const term = search?.trim().toLowerCase() ?? '';
  const visible = term ? timeline.filter((t) => (t.kind === 'msg' ? (t.m.body ?? '') : t.n.body).toLowerCase().includes(term)) : timeline;
  const wl = windowLabel(c);

  // Date separators are inserted where the local day changes.
  let lastDay = '';
  const rows: Array<{ type: 'sep'; key: string; label: string } | { type: 'item'; key: string; item: (typeof timeline)[number] }> = [];
  for (const t of visible) {
    const day = dayKey(t.at, b.timezone);
    if (day !== lastDay) { rows.push({ type: 'sep', key: `s${day}`, label: dayLabel(t.at, b.timezone) }); lastDay = day; }
    rows.push({ type: 'item', key: t.kind === 'msg' ? t.m.id : `n${t.n.id}`, item: t });
  }

  return (
    <>
    <section className="flex min-w-0 flex-1 flex-col bg-wa-wallpaper" aria-label="Conversation">
      <header className="flex items-center gap-2 border-b border-wa-border bg-wa-header px-2 py-2 sm:px-3">
        <Button variant="ghost" size="icon" className="shrink-0 md:hidden" onClick={() => navigate(`/w/${b.id}/inbox`)} aria-label="Back to conversations"><ArrowLeft /></Button>
        <Avatar name={contact.name || contact.phone} className="size-10 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-wa-text">{contact.name || formatPhone(contact.phone)}</p>
          <p className="truncate text-xs text-wa-text-muted">
            {c.status === 'closed' ? 'Conversation closed' : wl ? <span className="text-wa-accent">{wl}</span> : 'Template messages only (24h window closed)'}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="shrink-0 text-wa-text-muted" aria-label="Search messages" onClick={() => setSearch(search === null ? '' : null)}><Search /></Button>
        <NativeSelect className="hidden h-8 w-40 text-xs sm:block" aria-label="Assigned to" value={c.assignedTo?.id ?? ''} disabled={assign.isPending}
          onChange={(e) => assign.mutate(e.target.value || null)}>
          <option value="">Unassigned</option>
          {(members.data ?? []).filter((m) => m.status === 'active' && (canAssignOthers || m.userId === me?.id || m.userId === c.assignedTo?.id))
            .map((m) => <option key={m.userId} value={m.userId}>{m.userId === me?.id ? `${m.fullName} (me)` : m.fullName}</option>)}
        </NativeSelect>
        {c.status === 'closed'
          ? <Button size="sm" variant="outline" onClick={() => setStatus.mutate('open')}>Reopen</Button>
          : <Button size="sm" onClick={() => setStatus.mutate('closed')} aria-label="Close conversation"><Check /><span className="hidden sm:inline">Close</span></Button>}
        <Button variant="ghost" size="icon" className="shrink-0 text-wa-text-muted xl:hidden" aria-label="Contact details" onClick={() => navigate(`/w/${b.id}/contacts/${contact.id}`)}><UserRound /></Button>
      </header>
      {search !== null && (
        <div className="flex items-center gap-2 border-b border-wa-border bg-wa-header px-3 py-2">
          <Search className="size-4 text-wa-text-muted" aria-hidden />
          <Input autoFocus className="h-8 border-0 bg-wa-sidebar text-wa-text" placeholder="Search loaded messages" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search messages" />
          <span className="shrink-0 text-xs text-wa-text-muted">{term ? `${visible.length} found` : ''}</span>
          <Button variant="ghost" size="icon" className="size-8" aria-label="Close search" onClick={() => setSearch(null)}><X /></Button>
        </div>
      )}
      <div className="flex-1 space-y-1.5 overflow-y-auto overflow-x-hidden py-3" role="log" aria-live="polite">
        {rows.length === 0 && <p className="p-6 text-center text-sm text-wa-text-muted">{term ? 'No matching messages in the loaded history' : 'No messages yet'}</p>}
        {rows.map((r) => r.type === 'sep' ? <DateSeparator key={r.key} label={r.label} /> : r.item.kind === 'note' ? (
          <div key={r.key} className="px-2 sm:px-6"><InternalNote author={r.item.n.authorName} body={r.item.n.body} at={r.item.n.createdAt} timezone={b.timezone} /></div>
        ) : (
          <MessageBubble key={r.key} m={r.item.m} timezone={b.timezone} onRetry={retry} retrying={retryingId === r.item.m.id} />
        ))}
        <div ref={endRef} />
      </div>
      {c.status === 'closed'
        ? <p className="border-t border-wa-border bg-wa-header p-4 text-center text-sm text-wa-text-muted">This conversation is closed. Reopen it to reply.</p>
        : <MessageComposer conversation={c} onSent={invalidate} />}
    </section>
    <ContactPanel detail={q.data} onChanged={invalidate} />
    </>
  );
}
