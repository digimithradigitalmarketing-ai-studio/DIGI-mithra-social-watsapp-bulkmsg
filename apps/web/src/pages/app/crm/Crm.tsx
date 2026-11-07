import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { Download, GripVertical, ListChecks, MessageSquareText, Plus, Trash2, TrendingUp } from 'lucide-react';
import {
  LEAD_SOURCES, can, type CannedReplyDto, type ContactDto, type LeadDto, type MemberDto, type PipelineDto, type ReportsDto, type TaskDto,
} from '@socialpilot/shared';
import { api, del, downloadFile, get, getPage, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { handleFormError } from '@/lib/forms';
import { cn, formatDate, formatDateTime, formatNumber, formatPaise } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Badge, EmptyState, PageHeader, Skeleton, Table, Td, Th } from '@/components/ui/misc';
import { formatPhone } from '../contacts/shared';

const tooltipStyle = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 };

// ---------------------------------------------------------------------------
// Canned replies
// ---------------------------------------------------------------------------
export function CannedReplies() {
  const b = useWorkspace();
  const qc = useQueryClient();
  const canManage = can(b.myRole, 'campaigns.manage');
  const [v, setV] = useState({ shortcut: '', title: '', body: '' });
  const q = useQuery({ queryKey: ['canned', b.id], queryFn: () => get<CannedReplyDto[]>(`/v1/businesses/${b.id}/canned-replies`) });
  const create = useMutation({
    mutationFn: () => post(`/v1/businesses/${b.id}/canned-replies`, v),
    onSuccess: async () => { setV({ shortcut: '', title: '', body: '' }); await qc.invalidateQueries({ queryKey: ['canned', b.id] }); toast.success('Quick reply saved'); },
    onError: (e) => handleFormError(e),
  });
  const remove = useMutation({ mutationFn: (id: string) => del(`/v1/businesses/${b.id}/canned-replies/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['canned', b.id] }), onError: (e) => handleFormError(e) });
  return (
    <>
      <PageHeader title="Canned Replies" description='Type "/" in the inbox reply box to insert one. Free-form replies can only be sent within 24 hours of the customer’s last message.' />
      {canManage && (
        <Card className="mb-6"><CardContent className="grid gap-3 pt-5 md:grid-cols-[10rem_14rem_1fr_auto] md:items-end">
          <Field id="cr-short" label="Shortcut"><Input id="cr-short" placeholder="hours" value={v.shortcut} onChange={(e) => setV({ ...v, shortcut: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })} /></Field>
          <Field id="cr-title" label="Title"><Input id="cr-title" placeholder="Opening hours" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
          <Field id="cr-body" label="Message"><Input id="cr-body" placeholder="We are open 5am–10pm, Monday to Saturday." value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} /></Field>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!v.shortcut || !v.title || !v.body}><Plus /> Add</Button>
        </CardContent></Card>
      )}
      {q.isLoading ? <Skeleton className="h-40" /> : !q.data?.length ? (
        <EmptyState icon={<MessageSquareText />} title="No quick replies yet" description="Save answers to common questions: timings, fees, location, trial booking." />
      ) : (
        <Card><Table>
          <thead><tr><Th>Shortcut</Th><Th>Title</Th><Th className="hidden md:table-cell">Message</Th><Th /></tr></thead>
          <tbody>{q.data.map((r) => (
            <tr key={r.id}><Td className="font-mono text-primary">/{r.shortcut}</Td><Td className="font-medium">{r.title}</Td>
              <Td className="hidden max-w-lg truncate text-muted-foreground md:table-cell">{r.body}</Td>
              <Td className="text-right">{canManage && <Button variant="ghost" size="icon" aria-label={`Delete /${r.shortcut}`} onClick={() => remove.mutate(r.id)}><Trash2 /></Button>}</Td></tr>
          ))}</tbody>
        </Table></Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Lead pipeline (kanban)
// ---------------------------------------------------------------------------
export function Pipeline() {
  const b = useWorkspace();
  const qc = useQueryClient();
  const [mine, setMine] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const pipelines = useQuery({ queryKey: ['pipelines', b.id], queryFn: () => get<PipelineDto[]>(`/v1/businesses/${b.id}/pipelines`) });
  const pipeline = pipelines.data?.[0];
  const leads = useQuery({
    queryKey: ['leads', b.id, 'board', mine],
    queryFn: () => get<LeadDto[]>(`/v1/businesses/${b.id}/leads${mine ? '?assignedTo=me' : ''}`),
  });
  const canEdit = can(b.myRole, 'leads.update');
  const move = useMutation({
    mutationFn: ({ id, stageId }: { id: string; stageId: string }) => api<{ data: LeadDto }>(`/v1/businesses/${b.id}/leads/${id}`, { method: 'PATCH', json: { stageId } }),
    onMutate: async ({ id, stageId }) => {
      const key = ['leads', b.id, 'board', mine];
      const prev = qc.getQueryData<LeadDto[]>(key);
      qc.setQueryData<LeadDto[]>(key, (old) => old?.map((l) => (l.id === id ? { ...l, stageId } : l)));
      return { prev, key };
    },
    onError: (e, _v, ctx) => { if (ctx) qc.setQueryData(ctx.key, ctx.prev); handleFormError(e); },
    onSettled: () => qc.invalidateQueries({ queryKey: ['leads', b.id] }),
  });

  if (pipelines.isLoading || leads.isLoading) return <Skeleton className="h-96" />;
  if (!pipeline) return <EmptyState icon={<TrendingUp />} title="No pipeline" description="A default pipeline is created with every workspace." />;
  const total = (stageId: string) => (leads.data ?? []).filter((l) => l.stageId === stageId).reduce((a, l) => a + (l.valuePaise ?? 0), 0);

  return (
    <>
      <PageHeader title="Lead Pipeline" description="Drag cards between stages, or use the stage menu on each card."
        actions={<>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only my leads</label>
          {canEdit && <Button onClick={() => setCreating(true)}><Plus /> New lead</Button>}
        </>} />
      <div className="flex gap-3 overflow-x-auto pb-4">
        {pipeline.stages.map((s) => {
          const items = (leads.data ?? []).filter((l) => l.stageId === s.id);
          return (
            <section key={s.id} aria-label={s.name}
              onDragOver={(e) => { if (canEdit && dragId) { e.preventDefault(); setOverStage(s.id); } }}
              onDragLeave={() => setOverStage((o) => (o === s.id ? null : o))}
              onDrop={(e) => { e.preventDefault(); if (dragId) move.mutate({ id: dragId, stageId: s.id }); setDragId(null); setOverStage(null); }}
              className={cn('flex w-72 shrink-0 flex-col rounded-lg border bg-muted/40', overStage === s.id && 'ring-2 ring-primary')}>
              <header className="flex items-center justify-between border-b px-3 py-2">
                <span className="font-medium">{s.name} <span className="text-muted-foreground">{items.length}</span></span>
                {total(s.id) > 0 && <span className="text-xs text-muted-foreground">{formatPaise(total(s.id))}</span>}
              </header>
              <ul className="flex min-h-24 flex-col gap-2 p-2">
                {items.map((l) => (
                  <li key={l.id} draggable={canEdit} onDragStart={() => setDragId(l.id)} onDragEnd={() => setDragId(null)}
                    className={cn('rounded-md border bg-card p-3 shadow-sm', canEdit && 'cursor-grab', dragId === l.id && 'opacity-50')}>
                    <div className="flex items-start gap-1">
                      {canEdit && <GripVertical className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
                      <div className="min-w-0 flex-1">
                        <p className="font-medium leading-snug">{l.title}</p>
                        <Link to={`/w/${b.id}/contacts/${l.contact.id}`} className="text-xs text-muted-foreground hover:underline">{l.contact.name || formatPhone(l.contact.phone)}</Link>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                          {l.valuePaise != null && <Badge tone="green">{formatPaise(l.valuePaise)}</Badge>}
                          <Badge>{l.source.replace(/_/g, ' ')}</Badge>
                          {l.assignedTo && <span className="text-muted-foreground">{l.assignedTo.name}</span>}
                        </div>
                        {canEdit && (
                          <NativeSelect className="mt-2 h-7 text-xs" aria-label={`Move ${l.title}`} value={l.stageId ?? ''} onChange={(e) => move.mutate({ id: l.id, stageId: e.target.value })}>
                            {pipeline.stages.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
                          </NativeSelect>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <NewLeadDialog open={creating} onOpenChange={setCreating} pipeline={pipeline} />
    </>
  );
}

function NewLeadDialog({ open, onOpenChange, pipeline }: { open: boolean; onOpenChange: (o: boolean) => void; pipeline: PipelineDto }) {
  const b = useWorkspace();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [contact, setContact] = useState<ContactDto | null>(null);
  const [v, setV] = useState({ title: '', source: 'walk_in', valueRupees: '', stageId: pipeline.stages[0]?.id ?? '' });
  const results = useQuery({
    queryKey: ['contact-search', b.id, search],
    queryFn: () => getPage<ContactDto[]>(`/v1/businesses/${b.id}/contacts?pageSize=6&q=${encodeURIComponent(search)}`),
    enabled: open && search.trim().length >= 2 && !contact,
  });
  const create = useMutation({
    mutationFn: () => post(`/v1/businesses/${b.id}/leads`, { contactId: contact!.id, title: v.title, source: v.source, stageId: v.stageId, valueRupees: v.valueRupees ? Number(v.valueRupees) : undefined }),
    onSuccess: async () => { onOpenChange(false); setContact(null); setSearch(''); setV({ ...v, title: '', valueRupees: '' }); await qc.invalidateQueries({ queryKey: ['leads', b.id] }); toast.success('Lead created'); },
    onError: (e) => handleFormError(e),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New lead"
      footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button loading={create.isPending} disabled={!contact || v.title.trim().length < 2} onClick={() => create.mutate()}>Create lead</Button></>}>
      <div className="space-y-4">
        {contact ? (
          <div className="flex items-center justify-between rounded-md border p-2 text-sm"><span><span className="font-medium">{contact.name || 'Unnamed'}</span> · {formatPhone(contact.phone)}</span><Button size="sm" variant="ghost" onClick={() => setContact(null)}>Change</Button></div>
        ) : (
          <Field id="lead-contact" label="Contact" hint="Search by name or phone. Add new people from Contacts first.">
            <Input id="lead-contact" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ravi or 98765…" />
            <ul className="mt-1 divide-y rounded-md border empty:hidden">
              {results.data?.data.map((c) => <li key={c.id}><button className="w-full px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => setContact(c)}>{c.name || 'Unnamed'} · {formatPhone(c.phone)}</button></li>)}
            </ul>
          </Field>
        )}
        <Field id="lead-title" label="What are they interested in?"><Input id="lead-title" placeholder="Annual membership" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field id="lead-source" label="Source"><NativeSelect id="lead-source" value={v.source} onChange={(e) => setV({ ...v, source: e.target.value })}>{LEAD_SOURCES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</NativeSelect></Field>
          <Field id="lead-stage" label="Stage"><NativeSelect id="lead-stage" value={v.stageId} onChange={(e) => setV({ ...v, stageId: e.target.value })}>{pipeline.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</NativeSelect></Field>
          <Field id="lead-value" label="Value (₹)"><Input id="lead-value" type="number" min={0} value={v.valueRupees} onChange={(e) => setV({ ...v, valueRupees: e.target.value })} /></Field>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Follow-up tasks
// ---------------------------------------------------------------------------
export function Tasks() {
  const b = useWorkspace();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [view, setView] = useState<'mine' | 'all' | 'overdue' | 'unassigned'>('mine');
  const [status, setStatus] = useState<'open' | 'done'>('open');
  const [v, setV] = useState({ title: '', due: '', assignedTo: '' });
  const members = useQuery({ queryKey: ['members', b.id], queryFn: () => get<MemberDto[]>(`/v1/businesses/${b.id}/members`) });
  const q = useQuery({ queryKey: ['tasks', b.id, view, status], queryFn: () => get<TaskDto[]>(`/v1/businesses/${b.id}/tasks?view=${view}&status=${status}`) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['tasks', b.id] });
  const create = useMutation({
    mutationFn: () => post(`/v1/businesses/${b.id}/tasks`, { title: v.title, dueAt: v.due ? new Date(v.due).toISOString() : undefined, assignedTo: v.assignedTo || me?.id }),
    onSuccess: async () => { setV({ title: '', due: '', assignedTo: '' }); await invalidate(); toast.success('Task added'); },
    onError: (e) => handleFormError(e),
  });
  const update = useMutation({
    mutationFn: ({ id, status: s }: { id: string; status: string }) => api(`/v1/businesses/${b.id}/tasks/${id}`, { method: 'PATCH', json: { status: s } }),
    onSuccess: invalidate, onError: (e) => handleFormError(e),
  });
  return (
    <>
      <PageHeader title="Follow-Up Tasks" description="Reminders for calls, trial visits and renewals. Create them from the inbox or a contact too." />
      <Card className="mb-6"><CardContent className="grid gap-3 pt-5 md:grid-cols-[1fr_14rem_12rem_auto] md:items-end">
        <Field id="t-title" label="Task"><Input id="t-title" placeholder="Call back about trial session" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
        <Field id="t-due" label="Due"><Input id="t-due" type="datetime-local" value={v.due} onChange={(e) => setV({ ...v, due: e.target.value })} /></Field>
        <Field id="t-who" label="Assign to"><NativeSelect id="t-who" value={v.assignedTo} onChange={(e) => setV({ ...v, assignedTo: e.target.value })}>
          <option value="">Me</option>{members.data?.filter((m) => m.status === 'active' && m.userId !== me?.id).map((m) => <option key={m.userId} value={m.userId}>{m.fullName}</option>)}
        </NativeSelect></Field>
        <Button onClick={() => create.mutate()} loading={create.isPending} disabled={v.title.trim().length < 2}><Plus /> Add</Button>
      </CardContent></Card>
      <div className="mb-3 flex flex-wrap gap-2">
        {(['mine', 'overdue', 'unassigned', 'all'] as const).map((k) => (
          <Button key={k} size="sm" variant={view === k ? 'default' : 'outline'} onClick={() => setView(k)} className="capitalize">{k === 'mine' ? 'My tasks' : k}</Button>
        ))}
        <NativeSelect className="ml-auto h-8 w-32" value={status} onChange={(e) => setStatus(e.target.value as 'open' | 'done')} aria-label="Status"><option value="open">Open</option><option value="done">Done</option></NativeSelect>
      </div>
      <Card>
        {q.isLoading ? <CardContent className="pt-5"><Skeleton className="h-32" /></CardContent> : !q.data?.length ? (
          <CardContent className="pt-5"><EmptyState icon={<ListChecks />} title="Nothing here" description={status === 'open' ? 'You are all caught up.' : 'No completed tasks yet.'} /></CardContent>
        ) : (
          <ul className="divide-y">
            {q.data.map((t) => (
              <li key={t.id} className="flex items-start gap-3 px-5 py-3">
                <input type="checkbox" className="mt-1 size-4" checked={t.status === 'done'} aria-label={`Mark ${t.title} ${t.status === 'done' ? 'open' : 'done'}`}
                  onChange={() => update.mutate({ id: t.id, status: t.status === 'done' ? 'open' : 'done' })} />
                <div className="min-w-0 flex-1">
                  <p className={cn('font-medium', t.status === 'done' && 'text-muted-foreground line-through')}>{t.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {t.dueAt && <span className={cn(t.overdue && 'font-medium text-destructive')}>{t.overdue ? 'Overdue · ' : 'Due '}{formatDateTime(t.dueAt, b.timezone)}</span>}
                    {t.contact && <> · <Link to={`/w/${b.id}/contacts/${t.contact.id}`} className="hover:underline">{t.contact.name || formatPhone(t.contact.phone)}</Link></>}
                    {t.conversationId && <> · <Link to={`/w/${b.id}/inbox/${t.conversationId}`} className="hover:underline">conversation</Link></>}
                    {t.assignedTo && view !== 'mine' && <> · {t.assignedTo.name}</>}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>{sub && <p className="text-xs text-muted-foreground">{sub}</p>}</CardContent></Card>;
}
const mins = (m: number | null) => (m == null ? '—' : m < 1 ? '< 1 min' : m < 60 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`);

export function Reports() {
  const b = useWorkspace();
  const [days, setDays] = useState(30);
  const q = useQuery({ queryKey: ['reports', b.id, days], queryFn: () => get<ReportsDto>(`/v1/businesses/${b.id}/reports?days=${days}`) });
  const d = q.data;
  const daily = useMemo(() => d?.daily.map((x) => ({ ...x, date: x.date.slice(5) })) ?? [], [d]);
  return (
    <>
      <PageHeader title="Reports" description="Conversations, leads, campaigns and team performance."
        actions={<>
          <NativeSelect className="w-36" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Date range"><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></NativeSelect>
          <Button variant="outline" onClick={() => downloadFile(`/v1/businesses/${b.id}/reports/team.csv?days=${days}`, `team-report-${days}d.csv`).catch(handleFormError)}><Download /> Export</Button>
        </>} />
      {!d ? <Skeleton className="h-96" /> : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label="Customer messages" value={formatNumber(d.conversations.inbound)} sub={`${formatNumber(d.conversations.outbound)} sent by your team & campaigns`} />
            <Kpi label="Median first response" value={mins(d.conversations.medianFirstResponseMinutes)} sub={`${d.conversations.started} conversations started`} />
            <Kpi label="Open now" value={formatNumber(d.conversations.openNow)} sub={`${d.conversations.unassignedNow} unassigned`} />
            <Kpi label="Leads won" value={formatNumber(d.leads.won)} sub={`${formatPaise(d.leads.wonValuePaise)} · ${d.leads.created} new leads`} />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card><CardHeader><CardTitle>Daily activity</CardTitle></CardHeader><CardContent><div className="h-64"><ResponsiveContainer>
              <LineChart data={daily} margin={{ left: -20, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} minTickGap={20} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
                <Tooltip contentStyle={tooltipStyle} /><Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="inbound" name="Customer messages" stroke="#14b8a6" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="outbound" name="Sent" stroke="#2f6bff" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="leads" name="New leads" stroke="#7c3aed" strokeWidth={2} dot={false} />
              </LineChart></ResponsiveContainer></div></CardContent></Card>
            <Card><CardHeader><CardTitle>Pipeline by stage</CardTitle><CardDescription>All open and closed leads</CardDescription></CardHeader><CardContent><div className="h-64"><ResponsiveContainer>
              <BarChart data={d.leads.byStage} margin={{ left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="stage" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} interval={0} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
                <Tooltip contentStyle={tooltipStyle} /><Bar dataKey="count" name="Leads" fill="#2f6bff" radius={[4, 4, 0, 0]} />
              </BarChart></ResponsiveContainer></div></CardContent></Card>
          </div>
          <Card>
            <CardHeader><CardTitle>Team performance</CardTitle><CardDescription>Last {days} days · open conversations are current</CardDescription></CardHeader>
            <Table>
              <thead><tr><Th>Member</Th><Th className="text-right">Replies</Th><Th className="text-right">Open assigned</Th><Th className="text-right">Median first response</Th><Th className="text-right">Tasks done</Th><Th className="text-right">Leads won</Th></tr></thead>
              <tbody>{d.team.map((t) => (
                <tr key={t.userId}><Td><span className="font-medium">{t.name}</span> <span className="text-xs capitalize text-muted-foreground">{t.role}</span></Td>
                  <Td className="text-right tabular-nums">{t.replies}</Td><Td className="text-right tabular-nums">{t.conversationsAssigned}</Td>
                  <Td className="text-right tabular-nums">{mins(t.medianFirstResponseMinutes)}</Td><Td className="text-right tabular-nums">{t.tasksDone}</Td><Td className="text-right tabular-nums">{t.leadsWon}</Td></tr>
              ))}</tbody>
            </Table>
          </Card>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card><CardHeader><CardTitle>Lead sources</CardTitle></CardHeader>
              {d.leads.bySource.length === 0 ? <CardContent><p className="text-sm text-muted-foreground">No leads in this period.</p></CardContent> : (
                <Table><thead><tr><Th>Source</Th><Th className="text-right">Leads</Th><Th className="text-right">Won</Th><Th className="text-right">Conversion</Th></tr></thead>
                  <tbody>{d.leads.bySource.map((s) => <tr key={s.source}><Td className="capitalize">{s.source.replace(/_/g, ' ')}</Td><Td className="text-right">{s.count}</Td><Td className="text-right">{s.won}</Td><Td className="text-right">{s.count ? `${Math.round((s.won / s.count) * 100)}%` : '—'}</Td></tr>)}</tbody></Table>
              )}
            </Card>
            <Card><CardHeader><CardTitle>Campaigns</CardTitle><CardDescription>{d.campaigns.count} started in this period</CardDescription></CardHeader>
              <CardContent className="grid grid-cols-3 gap-3 text-center text-sm">
                {(['sent', 'delivered', 'read', 'replied', 'failed'] as const).map((k) => <div key={k}><p className="text-lg font-semibold tabular-nums">{formatNumber(d.campaigns[k])}</p><p className="text-xs capitalize text-muted-foreground">{k}</p></div>)}
                <div><Link to={`/w/${b.id}/campaigns/reports`} className="text-xs text-primary hover:underline">Campaign reports →</Link></div>
              </CardContent></Card>
          </div>
          <p className="text-xs text-muted-foreground">Report period starts {formatDate(d.range.from, b.timezone)}.</p>
        </div>
      )}
    </>
  );
}
