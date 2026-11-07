import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertTriangle, ArrowLeft, Check, CheckCheck, Clock, Sparkles, ExternalLink, FileText, Inbox as InboxIcon, Lock, MessageCircle, Plus, Search, Send, StickyNote, UserRound, XCircle,
} from 'lucide-react';
import {
  can, type AiAnswerDto, type CannedReplyDto, type ConversationDetailDto, type ConversationDto, type InboxCountsDto, type LeadDto, type MemberDto, type PipelineDto, type TaskDto, type TemplateDto,
} from '@socialpilot/shared';
import { get, getPage, post, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { handleFormError } from '@/lib/forms';
import { cn, formatDateTime } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { Avatar, Badge, EmptyState, Skeleton } from '@/components/ui/misc';
import { ConsentBadge, TagPill, formatPhone } from '../contacts/shared';
import { useChannel } from '../whatsapp/Connection';

const relTime = (iso: string | null) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(new Date(iso));
};

function windowLabel(c: ConversationDto) {
  if (!c.windowExpiresAt) return null;
  const ms = new Date(c.windowExpiresAt).getTime() - Date.now();
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m left to reply freely` : `${m}m left to reply freely`;
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'queued' || status === 'sending') return <Clock className="size-3" aria-label={status} />;
  if (status === 'sent') return <Check className="size-3" aria-label="sent" />;
  if (status === 'delivered') return <CheckCheck className="size-3" aria-label="delivered" />;
  if (status === 'read') return <CheckCheck className="size-3 text-sky-500" aria-label="read" />;
  if (status === 'failed') return <XCircle className="size-3 text-destructive" aria-label="failed" />;
  return null;
}

export default function Inbox() {
  const b = useWorkspace();
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const [view, setView] = useState<'all' | 'mine' | 'unassigned'>('all');
  const [status, setStatus] = useState<'active' | 'closed'>('active');
  const [q, setQ] = useState('');

  const counts = useQuery({ queryKey: ['inbox-counts', b.id], queryFn: () => get<InboxCountsDto>(`/v1/businesses/${b.id}/inbox/counts`), refetchInterval: 5000 });
  const list = useQuery({
    queryKey: ['conversations', b.id, view, status, q],
    queryFn: () => getPage<ConversationDto[]>(`/v1/businesses/${b.id}/conversations?view=${view}&status=${status}&pageSize=50${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    refetchInterval: 5000,
  });
  const views = [
    { k: 'all' as const, label: 'All', n: counts.data?.all },
    { k: 'mine' as const, label: 'Mine', n: counts.data?.mine },
    { k: 'unassigned' as const, label: 'Unassigned', n: counts.data?.unassigned },
  ];

  return (
    <div className="flex h-full">
      <section className={cn('flex w-full flex-col border-r bg-card md:w-80 md:shrink-0', conversationId && 'hidden md:flex')} aria-label="Conversations">
        <div className="space-y-2 border-b p-3">
          <div className="flex gap-1" role="tablist">
            {views.map((v) => (
              <button key={v.k} role="tab" aria-selected={view === v.k} onClick={() => setView(v.k)}
                className={cn('flex-1 rounded-md px-2 py-1.5 text-sm', view === v.k ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}>
                {v.label}{v.n != null && <span className="ml-1 opacity-70">{v.n}</span>}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1"><Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input className="h-9 pl-8" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations" /></div>
            <NativeSelect className="h-9 w-28" value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'closed')} aria-label="Status filter">
              <option value="active">Open</option><option value="closed">Closed</option>
            </NativeSelect>
          </div>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {list.isLoading && <li className="space-y-2 p-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</li>}
          {list.data?.data.length === 0 && <li className="p-6 text-center text-sm text-muted-foreground">No conversations</li>}
          {list.data?.data.map((c) => (
            <li key={c.id}>
              <button onClick={() => navigate(`/w/${b.id}/inbox/${c.id}`)}
                className={cn('flex w-full gap-3 border-b px-3 py-3 text-left hover:bg-muted/60', c.id === conversationId && 'bg-accent')}>
                <Avatar name={c.contact.name || c.contact.phone} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className={cn('truncate text-sm', c.unreadCount ? 'font-semibold' : 'font-medium')}>{c.contact.name || formatPhone(c.contact.phone)}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{relTime(c.lastMessageAt)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="truncate text-xs text-muted-foreground">{c.lastMessagePreview ?? '—'}</span>
                    {c.unreadCount > 0 && <span className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-white">{c.unreadCount}</span>}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    {c.aiHandoffReason && <span className="rounded bg-amber-100 px-1 font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300" title={c.aiHandoffReason}>Needs a person</span>}
                    {c.windowOpen ? <span className="text-success">● 24h open</span> : <span>● window closed</span>}
                    {c.assignedTo && <span className="truncate">· {c.assignedTo.name}</span>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {conversationId ? <Thread key={conversationId} id={conversationId} /> : (
        <div className="hidden flex-1 items-center justify-center md:flex">
          <EmptyState icon={<InboxIcon />} title="Select a conversation" description="Customer messages from WhatsApp appear here in real time." />
        </div>
      )}
    </div>
  );
}

function Thread({ id }: { id: string }) {
  const b = useWorkspace();
  const { me } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const endRef = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ['conversation', id], queryFn: () => get<ConversationDetailDto>(`/v1/businesses/${b.id}/conversations/${id}`), refetchInterval: 3000, retry: false });
  const members = useQuery({ queryKey: ['members', b.id], queryFn: () => get<MemberDto[]>(`/v1/businesses/${b.id}/members`) });
  const invalidate = () => Promise.all([qc.invalidateQueries({ queryKey: ['conversation', id] }), qc.invalidateQueries({ queryKey: ['conversations', b.id] }), qc.invalidateQueries({ queryKey: ['inbox-counts', b.id] })]);

  const unread = q.data?.conversation.unreadCount ?? 0;
  useEffect(() => {
    if (unread > 0) void post(`/v1/businesses/${b.id}/conversations/${id}/read`).then(() => qc.invalidateQueries({ queryKey: ['inbox-counts', b.id] }));
  }, [unread, b.id, id, qc]);
  const lastCount = q.data ? q.data.messages.length + q.data.notes.length : 0;
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [lastCount]);

  const assign = useMutation({
    mutationFn: (userId: string | null) => post<ConversationDto | null>(`/v1/businesses/${b.id}/conversations/${id}/assign`, { userId }),
    onSuccess: async (c) => { await invalidate(); toast.success(c?.assignedTo ? `Assigned to ${c.assignedTo.name}` : c ? 'Unassigned' : 'Reassigned'); if (!c) navigate(`/w/${b.id}/inbox`); },
    onError: (e) => handleFormError(e),
  });
  const setStatus = useMutation({
    mutationFn: (status: string) => post(`/v1/businesses/${b.id}/conversations/${id}/status`, { status }),
    onSuccess: async () => { await invalidate(); },
    onError: (e) => handleFormError(e),
  });

  if (q.isLoading) return <div className="flex-1 p-6"><Skeleton className="h-full" /></div>;
  if (!q.data) return <div className="flex flex-1 items-center justify-center p-6"><EmptyState icon={<Lock />} title="Conversation unavailable" description="It may have been reassigned to someone else." /></div>;
  const { conversation: c, contact, messages, notes } = q.data;
  const canAssignOthers = can(b.myRole, 'conversations.assign');
  const timeline = [
    ...messages.map((m) => ({ kind: 'msg' as const, at: m.createdAt, m })),
    ...notes.map((n) => ({ kind: 'note' as const, at: n.createdAt, n })),
  ].sort((a, z) => a.at.localeCompare(z.at));
  const wl = windowLabel(c);

  return (
    <>
      <section className="flex min-w-0 flex-1 flex-col bg-background" aria-label="Conversation">
        <header className="flex flex-wrap items-center gap-2 border-b bg-card px-3 py-2">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => navigate(`/w/${b.id}/inbox`)} aria-label="Back to conversations"><ArrowLeft /></Button>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{contact.name || formatPhone(contact.phone)}</p>
            <p className="text-xs text-muted-foreground">{formatPhone(contact.phone)} · {wl ? <span className="text-success">{wl}</span> : <span>24h window closed — templates only</span>}</p>
          </div>
          <NativeSelect className="h-8 w-44 text-xs" aria-label="Assigned to" value={c.assignedTo?.id ?? ''} disabled={assign.isPending}
            onChange={(e) => assign.mutate(e.target.value || null)}>
            <option value="">Unassigned</option>
            {(members.data ?? []).filter((m) => m.status === 'active' && (canAssignOthers || m.userId === me?.id || m.userId === c.assignedTo?.id))
              .map((m) => <option key={m.userId} value={m.userId}>{m.userId === me?.id ? `${m.fullName} (me)` : m.fullName}</option>)}
          </NativeSelect>
          {c.status === 'closed'
            ? <Button size="sm" variant="outline" onClick={() => setStatus.mutate('open')}>Reopen</Button>
            : <>
                <Button size="sm" variant="outline" className="hidden sm:inline-flex" onClick={() => setStatus.mutate(c.status === 'pending' ? 'open' : 'pending')}>{c.status === 'pending' ? 'Mark open' : 'Mark pending'}</Button>
                <Button size="sm" onClick={() => setStatus.mutate('closed')}><Check /> Close</Button>
              </>}
        </header>
        <div className="flex-1 space-y-2 overflow-y-auto px-3 py-4 sm:px-6" role="log" aria-live="polite">
          {timeline.map((t) => t.kind === 'note' ? (
            <div key={`n${t.n.id}`} className="mx-auto max-w-md rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
              <p className="mb-0.5 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide opacity-70"><StickyNote className="size-3" /> Internal note · {t.n.authorName ?? 'Team'}</p>
              <p className="whitespace-pre-wrap">{t.n.body}</p>
            </div>
          ) : (
            <div key={t.m.id} className={cn('flex', t.m.direction === 'outbound' ? 'justify-end' : 'justify-start')}>
              <div className={cn('max-w-[78%] rounded-lg px-3 py-2 text-sm shadow-sm', t.m.direction === 'outbound' ? 'rounded-tr-none bg-[#d9fdd3] text-slate-900 dark:bg-[#005c4b] dark:text-white' : 'rounded-tl-none border bg-card')}>
                {(t.m.campaignName || t.m.type === 'template') && <p className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-60">{t.m.campaignName ? `Campaign · ${t.m.campaignName}` : 'Template'}</p>}
                <p className="whitespace-pre-wrap break-words">{t.m.body ?? `[${t.m.type}]`}</p>
                <p className="mt-1 flex items-center justify-end gap-1 text-[10px] opacity-60">
                  {t.m.direction === 'outbound' && t.m.sentByName && <span>{t.m.sentByName} ·</span>}
                  {formatDateTime(t.m.createdAt, b.timezone)}
                  {t.m.direction === 'outbound' && <StatusIcon status={t.m.status} />}
                </p>
                {t.m.status === 'failed' && <p className="mt-1 text-[11px] text-destructive">Not delivered{t.m.errorMessage ? `: ${t.m.errorMessage}` : ''}</p>}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
        {c.status === 'closed'
          ? <p className="border-t bg-card p-4 text-center text-sm text-muted-foreground">This conversation is closed. Reopen it to reply.</p>
          : <Composer conversation={c} onSent={invalidate} />}
      </section>
      <ContactPanel detail={q.data} onChanged={invalidate} />
    </>
  );
}

function Composer({ conversation: c, onSent }: { conversation: ConversationDto; onSent: () => Promise<unknown> }) {
  const b = useWorkspace();
  const [mode, setMode] = useState<'reply' | 'template' | 'note'>(c.windowOpen ? 'reply' : 'template');
  const [text, setText] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const canned = useQuery({ queryKey: ['canned', b.id], queryFn: () => get<CannedReplyDto[]>(`/v1/businesses/${b.id}/canned-replies`) });
  const templates = useQuery({ queryKey: ['templates', b.id], queryFn: () => get<TemplateDto[]>(`/v1/businesses/${b.id}/templates`), enabled: mode === 'template' });
  const approved = templates.data?.filter((t) => t.status === 'APPROVED') ?? [];
  const template = approved.find((t) => t.id === templateId);
  useEffect(() => {
    if (!c.windowOpen && mode === 'reply') setMode('template');
    if (c.windowOpen && mode === 'template' && !templateId) setMode('reply'); // customer just wrote back
  }, [c.windowOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const slash = mode === 'reply' && text.startsWith('/') && !text.includes(' ') ? text.slice(1).toLowerCase() : null;
  const suggestions = useMemo(() => (slash === null ? [] : (canned.data ?? []).filter((x) => x.shortcut.startsWith(slash) || x.title.toLowerCase().includes(slash)).slice(0, 6)), [slash, canned.data]);

  const [suggesting, setSuggesting] = useState(false);
  const suggest = async () => {
    setSuggesting(true);
    try {
      const r = await post<AiAnswerDto>(`/v1/businesses/${b.id}/conversations/${c.id}/ai-suggest`);
      if (r.answer) {
        setMode('reply');
        setText(r.answer);
        toast.success(`Suggestion ready (${Math.round(r.confidence * 100)}% confidence) — review before sending`);
      } else toast.info(`No suggestion: ${r.handoffReason ?? r.outcome}`);
    } catch (e) { handleFormError(e); } finally { setSuggesting(false); }
  };
  const send = async () => {
    setBusy(true);
    try {
      if (mode === 'note') {
        await post(`/v1/businesses/${b.id}/conversations/${c.id}/notes`, { body: text });
      } else if (mode === 'reply') {
        await post(`/v1/businesses/${b.id}/conversations/${c.id}/messages`, { type: 'text', body: text, clientId: crypto.randomUUID() });
      } else {
        await post(`/v1/businesses/${b.id}/conversations/${c.id}/messages`, { type: 'template', templateId, variables: vars, clientId: crypto.randomUUID() });
        setTemplateId(''); setVars({});
      }
      setText('');
      await onSent();
    } catch (e) { handleFormError(e); } finally { setBusy(false); }
  };
  const ready = mode === 'template' ? !!templateId : text.trim().length > 0;

  return (
    <div className="border-t bg-card p-3">
      <div className="mb-2 flex gap-1 text-sm" role="tablist" aria-label="Composer mode">
        {(['reply', 'template', 'note'] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} disabled={m === 'reply' && !c.windowOpen} onClick={() => setMode(m)}
            className={cn('rounded-md px-2.5 py-1 disabled:opacity-40', mode === m ? (m === 'note' ? 'bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100' : 'bg-accent text-accent-foreground') : 'hover:bg-muted')}>
            {m === 'reply' ? 'Reply' : m === 'template' ? 'Template' : 'Internal note'}
          </button>
        ))}
        {c.windowOpen && (
          <Button type="button" size="sm" variant="ghost" className="ml-auto h-7" loading={suggesting} onClick={suggest} title="Draft a reply from your AI knowledge base">
            <Sparkles /> Suggest reply
          </Button>
        )}
      </div>
      {!c.windowOpen && mode !== 'note' && (
        <p className="mb-2 flex items-start gap-2 rounded-md bg-muted p-2 text-xs text-muted-foreground"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          More than 24 hours since the customer's last message. WhatsApp only allows approved templates until they reply.</p>
      )}
      {mode === 'template' ? (
        <div className="space-y-2">
          <NativeSelect value={templateId} onChange={(e) => { setTemplateId(e.target.value); setVars({}); }} aria-label="Template">
            <option value="">Choose an approved template…</option>
            {approved.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.category.toLowerCase()})</option>)}
          </NativeSelect>
          {template && (
            <>
              <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">{template.body}</p>
              <p className="text-[11px] text-muted-foreground">Values are filled from the contact automatically; type to override or fill in missing ones.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {template.variables.filter((v) => v !== 'business_name').map((v) => (
                  <Input key={v} className="h-8 text-xs" placeholder={`{{${v}}}`} aria-label={v} value={vars[v] ?? ''} onChange={(e) => setVars({ ...vars, [v]: e.target.value })} />
                ))}
              </div>
            </>
          )}
          <div className="flex justify-end"><Button onClick={send} loading={busy} disabled={!ready}><FileText /> Send template</Button></div>
        </div>
      ) : (
        <div className="relative">
          {suggestions.length > 0 && (
            <ul className="absolute bottom-full mb-1 w-full overflow-hidden rounded-md border bg-card shadow-lg" role="listbox" aria-label="Canned replies">
              {suggestions.map((s) => (
                <li key={s.id}><button className="w-full px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => setText(s.body)}>
                  <span className="font-mono text-xs text-primary">/{s.shortcut}</span> <span className="font-medium">{s.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{s.body}</span></button></li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-2">
            <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={4096}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && ready && !busy) { e.preventDefault(); void send(); } }}
              aria-label={mode === 'note' ? 'Internal note' : 'Reply'}
              placeholder={mode === 'note' ? 'Only your team sees notes…' : 'Type a reply — "/" for quick replies, Shift+Enter for a new line'}
              className={cn('min-h-[2.5rem] flex-1 resize-none rounded-md border border-input px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring', mode === 'note' ? 'bg-amber-50 dark:bg-amber-950' : 'bg-background')} />
            <Button onClick={send} loading={busy} disabled={!ready} aria-label={mode === 'note' ? 'Add note' : 'Send'}>{mode === 'note' ? <StickyNote /> : <Send />}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ContactPanel({ detail, onChanged }: { detail: ConversationDetailDto; onChanged: () => Promise<unknown> }) {
  const b = useWorkspace();
  const qc = useQueryClient();
  const { contact, conversation: c } = detail;
  const [tagDraft, setTagDraft] = useState('');
  const [leadTitle, setLeadTitle] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [simText, setSimText] = useState('');
  const channel = useChannel(b.id);
  const simulate = async () => {
    try {
      await post(`/v1/businesses/${b.id}/channels/whatsapp/mock/inbound`, { phone: contact.phone, name: contact.name, text: simText });
      setSimText(''); await onChanged();
    } catch (e) { handleFormError(e); }
  };
  const leads = useQuery({ queryKey: ['leads', b.id, 'contact', contact.id], queryFn: () => get<LeadDto[]>(`/v1/businesses/${b.id}/leads?contactId=${contact.id}`), refetchInterval: 10_000 });
  const tasks = useQuery({ queryKey: ['tasks', b.id, 'contact', contact.id], queryFn: () => get<TaskDto[]>(`/v1/businesses/${b.id}/tasks?contactId=${contact.id}&status=open`), refetchInterval: 10_000 });
  const pipelines = useQuery({ queryKey: ['pipelines', b.id], queryFn: () => get<PipelineDto[]>(`/v1/businesses/${b.id}/pipelines`) });
  const stageName = (id: string | null) => pipelines.data?.flatMap((p) => p.stages).find((s) => s.id === id)?.name ?? '—';

  const saveTags = async (tags: string[]) => {
    try { await api(`/v1/businesses/${b.id}/conversations/${c.id}/tags`, { method: 'PUT', json: { tags } }); await onChanged(); } catch (e) { handleFormError(e); }
  };
  const addLead = async () => {
    try {
      await post(`/v1/businesses/${b.id}/leads`, { contactId: contact.id, title: leadTitle, source: 'whatsapp' });
      setLeadTitle(''); await qc.invalidateQueries({ queryKey: ['leads', b.id] }); toast.success('Lead created');
    } catch (e) { handleFormError(e); }
  };
  const addTask = async () => {
    try {
      const due = new Date(); due.setDate(due.getDate() + 1); due.setHours(10, 0, 0, 0);
      await post(`/v1/businesses/${b.id}/tasks`, { title: taskTitle, conversationId: c.id, dueAt: due.toISOString() });
      setTaskTitle(''); await qc.invalidateQueries({ queryKey: ['tasks', b.id] }); toast.success('Follow-up due tomorrow 10am');
    } catch (e) { handleFormError(e); }
  };
  const completeTask = async (id: string) => {
    try { await api(`/v1/businesses/${b.id}/tasks/${id}`, { method: 'PATCH', json: { status: 'done' } }); await qc.invalidateQueries({ queryKey: ['tasks', b.id] }); } catch (e) { handleFormError(e); }
  };

  return (
    <aside className="hidden w-80 shrink-0 overflow-y-auto border-l bg-card xl:block" aria-label="Customer details">
      <div className="border-b p-4 text-center">
        <Avatar name={contact.name || contact.phone} className="mx-auto size-14 text-lg" />
        <p className="mt-2 font-semibold">{contact.name || 'Unnamed'}</p>
        <p className="text-sm tabular-nums text-muted-foreground">{formatPhone(contact.phone)}</p>
        <div className="mt-2 flex justify-center"><ConsentBadge c={contact} /></div>
        <Link to={`/w/${b.id}/contacts/${contact.id}`} className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">Full profile <ExternalLink className="size-3" /></Link>
      </div>
      <div className="space-y-5 p-4 text-sm">
        {contact.tags.length > 0 && <div className="flex flex-wrap gap-1">{contact.tags.map((t) => <TagPill key={t.id} t={t} />)}</div>}
        {Object.keys(contact.customFields).length > 0 && (
          <dl className="space-y-1">{Object.entries(contact.customFields).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2"><dt className="capitalize text-muted-foreground">{k.replace(/_/g, ' ')}</dt><dd>{v}</dd></div>))}</dl>
        )}
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Conversation labels</p>
          <div className="flex flex-wrap gap-1">
            {c.tags.map((t) => (
              <button key={t} onClick={() => saveTags(c.tags.filter((x) => x !== t))} className="rounded-full border px-2 py-0.5 text-xs hover:bg-muted" aria-label={`Remove label ${t}`}>{t} ×</button>
            ))}
          </div>
          <form className="mt-2 flex gap-1" onSubmit={(e) => { e.preventDefault(); if (tagDraft.trim()) { void saveTags([...c.tags, tagDraft.trim()]); setTagDraft(''); } }}>
            <Input className="h-8 text-xs" placeholder="Add label" value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} aria-label="New label" />
          </form>
        </div>
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Leads</p>
          <ul className="space-y-1.5">
            {leads.data?.map((l) => (
              <li key={l.id} className="rounded-md border p-2"><p className="font-medium">{l.title}</p>
                <p className="text-xs text-muted-foreground">{stageName(l.stageId)} · <Badge tone={l.status === 'won' ? 'green' : l.status === 'lost' ? 'red' : 'blue'}>{l.status}</Badge></p></li>
            ))}
          </ul>
          {can(b.myRole, 'leads.update') && (
            <form className="mt-2 flex gap-1" onSubmit={(e) => { e.preventDefault(); if (leadTitle.trim().length >= 2) void addLead(); }}>
              <Input className="h-8 text-xs" placeholder="New lead, e.g. PT package" value={leadTitle} onChange={(e) => setLeadTitle(e.target.value)} aria-label="New lead title" />
              <Button size="icon" className="size-8" type="submit" aria-label="Create lead"><Plus /></Button>
            </form>
          )}
        </div>
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Follow-ups</p>
          <ul className="space-y-1">
            {tasks.data?.map((t) => (
              <li key={t.id} className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" aria-label={`Complete ${t.title}`} onChange={() => completeTask(t.id)} />
                <span><span className={cn(t.overdue && 'text-destructive')}>{t.title}</span><span className="block text-xs text-muted-foreground">{formatDateTime(t.dueAt, b.timezone)}{t.assignedTo ? ` · ${t.assignedTo.name}` : ''}</span></span>
              </li>
            ))}
          </ul>
          <form className="mt-2 flex gap-1" onSubmit={(e) => { e.preventDefault(); if (taskTitle.trim().length >= 2) void addTask(); }}>
            <Input className="h-8 text-xs" placeholder="Follow up tomorrow…" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} aria-label="New follow-up" />
            <Button size="icon" className="size-8" type="submit" aria-label="Create follow-up"><Plus /></Button>
          </form>
        </div>
        {channel.data?.data?.mode === 'mock' && (
          <div className="rounded-md border border-dashed border-amber-400 p-2">
            <p className="mb-1 text-xs font-medium text-amber-700 dark:text-amber-300">Test tool (mock connection)</p>
            <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); if (simText.trim()) void simulate(); }}>
              <Input className="h-8 text-xs" placeholder="Simulate customer message" value={simText} onChange={(e) => setSimText(e.target.value)} aria-label="Simulated customer message" />
              <Button size="icon" variant="outline" className="size-8" type="submit" aria-label="Send as customer"><Send /></Button>
            </form>
          </div>
        )}
        <p className="flex items-center gap-1 text-xs text-muted-foreground"><MessageCircle className="size-3" /> Started {formatDateTime(c.createdAt, b.timezone)}</p>
        {!c.assignedTo && <p className="flex items-center gap-1 text-xs text-muted-foreground"><UserRound className="size-3" /> Replying assigns this conversation to you</p>}
      </div>
    </aside>
  );
}
