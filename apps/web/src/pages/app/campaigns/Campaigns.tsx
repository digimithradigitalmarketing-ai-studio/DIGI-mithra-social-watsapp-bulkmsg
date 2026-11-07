import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell } from 'recharts';
import { toast } from 'sonner';
import { AlertTriangle, ArrowLeft, CalendarClock, Download, Megaphone, Pause, Play, Plus, Send, XCircle, CheckCircle2, Undo2 } from 'lucide-react';
import {
  SKIP_REASONS, can, type CampaignDto, type CampaignPreviewDto, type CampaignRecipientDto, type TagDto, type TemplateDto,
} from '@socialpilot/shared';
import { downloadFile, get, getPage, patch, post } from '@/lib/api';
import { handleFormError } from '@/lib/forms';
import { cn, formatDateTime, formatNumber } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Badge, EmptyState, PageHeader, Skeleton, Table, Td, Th } from '@/components/ui/misc';
import { WhatsAppBubble } from '../templates/Templates';
import { TagPill, formatPhone } from '../contacts/shared';

const STATUS_TONE: Record<string, 'neutral' | 'blue' | 'amber' | 'green' | 'red' | 'teal'> = {
  draft: 'neutral', scheduled: 'blue', processing: 'teal', paused: 'amber', completed: 'green', partially_completed: 'amber', failed: 'red', cancelled: 'neutral',
};
export const StatusBadge = ({ s }: { s: string }) => <Badge tone={STATUS_TONE[s] ?? 'neutral'}>{s.replace('_', ' ')}</Badge>;
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');

// ---------------------------------------------------------------------------
export default function CampaignList() {
  const b = useWorkspace();
  const { pathname } = useLocation();
  const view = pathname.endsWith('/scheduled') ? 'scheduled' : pathname.endsWith('/history') ? 'history' : pathname.endsWith('/reports') ? 'reports' : 'all';
  const status = { scheduled: 'scheduled', history: 'completed,partially_completed,failed,cancelled', reports: 'processing,paused,completed,partially_completed,failed', all: '' }[view];
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [view]);
  const q = useQuery({
    queryKey: ['campaigns', b.id, status, page],
    queryFn: () => getPage<CampaignDto[]>(`/v1/businesses/${b.id}/campaigns?page=${page}&pageSize=20${status ? `&status=${status}` : ''}`),
    refetchInterval: (query) => (query.state.data?.data.some((c) => ['scheduled', 'processing'].includes(c.status)) ? 4000 : false),
  });
  const title = { all: 'Broadcast Campaigns', scheduled: 'Scheduled Campaigns', history: 'Campaign History', reports: 'Delivery Reports' }[view];
  const total = q.data?.meta.total ?? 0;
  return (
    <>
      <PageHeader title={title} description="Template messages to opted-in contacts. Consent, opt-outs and limits are checked before every send."
        actions={can(b.myRole, 'campaigns.manage') && <Button asChild><Link to={`/w/${b.id}/campaigns/new`}><Plus /> New campaign</Link></Button>} />
      <Card>
        {q.isLoading ? <CardContent className="pt-5"><Skeleton className="h-48" /></CardContent> : !q.data?.data.length ? (
          <CardContent className="pt-5"><EmptyState icon={<Megaphone />} title="No campaigns here" description="Create a campaign from an approved template and choose who should receive it."
            action={can(b.myRole, 'campaigns.manage') && <Button asChild><Link to={`/w/${b.id}/campaigns/new`}><Plus /> New campaign</Link></Button>} /></CardContent>
        ) : (
          <Table>
            <thead><tr><Th>Campaign</Th><Th>Status</Th><Th className="hidden md:table-cell">When</Th><Th className="text-right">Sent</Th><Th className="hidden text-right sm:table-cell">Delivered</Th><Th className="hidden text-right sm:table-cell">Read</Th><Th className="hidden text-right lg:table-cell">Replied</Th><Th className="hidden text-right lg:table-cell">Failed</Th></tr></thead>
            <tbody>
              {q.data.data.map((c) => (
                <tr key={c.id} className="hover:bg-muted/50">
                  <Td><Link to={`/w/${b.id}/campaigns/${c.id}`} className="font-medium hover:underline">{c.name}</Link><p className="font-mono text-xs text-muted-foreground">{c.template?.name}</p></Td>
                  <Td><StatusBadge s={c.status} /></Td>
                  <Td className="hidden whitespace-nowrap text-muted-foreground md:table-cell">{formatDateTime(c.startedAt ?? c.scheduledAt ?? c.createdAt, b.timezone)}</Td>
                  <Td className="text-right tabular-nums">{formatNumber(c.stats.sent)}</Td>
                  <Td className="hidden text-right tabular-nums sm:table-cell">{pct(c.stats.delivered, c.stats.sent)}</Td>
                  <Td className="hidden text-right tabular-nums sm:table-cell">{pct(c.stats.read, c.stats.sent)}</Td>
                  <Td className="hidden text-right tabular-nums lg:table-cell">{formatNumber(c.stats.replied)}</Td>
                  <Td className="hidden text-right tabular-nums lg:table-cell">{c.stats.failed ? <span className="text-destructive">{c.stats.failed}</span> : 0}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {total > 20 && <div className="flex justify-end gap-2 border-t px-5 py-3"><Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</Button><Button variant="outline" size="sm" disabled={page * 20 >= total} onClick={() => setPage((p) => p + 1)}>Next</Button></div>}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
const STEPS = ['Message', 'Audience', 'Personalise', 'Review & send'];

export function NewCampaign() {
  const b = useWorkspace();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [audience, setAudience] = useState<{ type: 'all' | 'tags'; tagIds: string[] }>({ type: 'tags', tagIds: [] });
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [preview, setPreview] = useState<CampaignPreviewDto | null>(null);
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [scheduledAt, setScheduledAt] = useState('');
  const [busy, setBusy] = useState(false);

  const templates = useQuery({ queryKey: ['templates', b.id], queryFn: () => get<TemplateDto[]>(`/v1/businesses/${b.id}/templates`) });
  const tags = useQuery({ queryKey: ['tags', b.id], queryFn: () => get<TagDto[]>(`/v1/businesses/${b.id}/tags`) });
  const approved = templates.data?.filter((t) => t.status === 'APPROVED' && t.category !== 'AUTHENTICATION') ?? [];
  const template = templates.data?.find((t) => t.id === templateId);
  const audienceCount = useMemo(() => (audience.type === 'all' ? null : tags.data?.filter((t) => audience.tagIds.includes(t.id)).reduce((a, t) => a + t.contactCount, 0)), [audience, tags.data]);

  const canNext = [!!name.trim() && !!templateId, audience.type === 'all' || audience.tagIds.length > 0, true, !!preview && preview.blockers.length === 0 && (when === 'now' || !!scheduledAt)][step];

  /** Persist the draft and fetch validation before the review step. */
  const saveDraftAndPreview = async () => {
    setBusy(true);
    try {
      const body = { name, templateId, audience, variableDefaults: Object.fromEntries(Object.entries(defaults).filter(([, v]) => v.trim())) };
      const c = campaignId ? await patch<CampaignDto>(`/v1/businesses/${b.id}/campaigns/${campaignId}`, body) : await post<CampaignDto>(`/v1/businesses/${b.id}/campaigns`, body);
      setCampaignId(c.id);
      setPreview(await post<CampaignPreviewDto>(`/v1/businesses/${b.id}/campaigns/${c.id}/preview`));
      setStep(3);
    } catch (e) { handleFormError(e); } finally { setBusy(false); }
  };
  const schedule = async () => {
    if (!campaignId) return;
    setBusy(true);
    try {
      await post(`/v1/businesses/${b.id}/campaigns/${campaignId}/schedule`, when === 'later' ? { scheduledAt: new Date(scheduledAt).toISOString() } : {});
      await qc.invalidateQueries({ queryKey: ['campaigns', b.id] });
      toast.success(when === 'now' ? 'Campaign started' : 'Campaign scheduled');
      navigate(`/w/${b.id}/campaigns/${campaignId}`);
    } catch (e) { handleFormError(e); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader title="New campaign" />
      <ol className="mb-6 flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined} className={cn('flex items-center gap-2 rounded-full border px-3 py-1 text-sm', i === step ? 'border-primary bg-accent text-accent-foreground' : i < step ? 'text-foreground' : 'text-muted-foreground')}>
            <span className={cn('flex size-5 items-center justify-center rounded-full text-xs', i < step ? 'bg-success text-white' : i === step ? 'bg-primary text-white' : 'bg-muted')}>{i < step ? '✓' : i + 1}</span>{s}
          </li>
        ))}
      </ol>
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3"><CardContent className="space-y-5 pt-6">
          {step === 0 && (<>
            <Field id="cp-name" label="Campaign name"><Input id="cp-name" placeholder="e.g. November membership renewals" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field id="cp-tpl" label="Approved template" hint={!approved.length ? undefined : 'Only Meta-approved templates can be broadcast.'}>
              <NativeSelect id="cp-tpl" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">Choose a template…</option>{approved.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.category.toLowerCase()}, {t.language})</option>)}
              </NativeSelect>
            </Field>
            {templates.data && !approved.length && <p className="rounded-md bg-muted p-3 text-sm">No approved templates yet. <Link to={`/w/${b.id}/templates/new`} className="text-primary underline">Create one</Link> and submit it for approval.</p>}
            {template?.category === 'MARKETING' && <p className="text-sm text-muted-foreground">Marketing template: only contacts with marketing consent will receive it.</p>}
          </>)}
          {step === 1 && (<>
            <div className="inline-flex rounded-md border bg-background p-1 text-sm" role="radiogroup" aria-label="Audience">
              {(['tags', 'all'] as const).map((t) => <button key={t} role="radio" aria-checked={audience.type === t} onClick={() => setAudience({ ...audience, type: t })} className={cn('rounded px-3 py-1.5', audience.type === t && 'bg-primary text-primary-foreground')}>{t === 'tags' ? 'Contacts with tags' : 'All contacts'}</button>)}
            </div>
            {audience.type === 'tags' && (
              <fieldset><legend className="mb-2 text-sm font-medium">Send to contacts with any of these tags</legend>
                <div className="flex flex-wrap gap-2">{tags.data?.map((t) => (
                  <label key={t.id} className={cn('flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm', audience.tagIds.includes(t.id) && 'border-primary bg-accent')}>
                    <input type="checkbox" checked={audience.tagIds.includes(t.id)} onChange={(e) => setAudience({ ...audience, tagIds: e.target.checked ? [...audience.tagIds, t.id] : audience.tagIds.filter((x) => x !== t.id) })} />
                    <TagPill t={t} /> <span className="text-muted-foreground">{t.contactCount}</span>
                  </label>
                ))}</div>
                {!tags.data?.length && <p className="text-sm text-muted-foreground">No tags yet. <Link to={`/w/${b.id}/contacts/tags`} className="text-primary underline">Create tags</Link> or choose All contacts.</p>}
              </fieldset>
            )}
            {audienceCount != null && <p className="text-sm text-muted-foreground">Up to {formatNumber(audienceCount)} contacts (duplicates and ineligible contacts are removed in the review step).</p>}
          </>)}
          {step === 2 && (<>
            <p className="text-sm text-muted-foreground">Values come from each contact. Set a fallback for contacts missing a value — otherwise they are skipped.</p>
            {!template?.variables.length && <p className="text-sm">This template has no variables.</p>}
            {template?.variables.map((k) => (
              <Field key={k} id={`d-${k}`} label={`{{${k}}}`} hint={k === 'customer_name' ? 'From contact name' : k === 'business_name' ? `Always "${b.name}"` : k === 'customer_phone' ? 'From contact phone' : `From the contact's "${k}" custom field`}>
                <Input id={`d-${k}`} placeholder="Fallback value (optional)" disabled={k === 'business_name' || k === 'customer_phone'} value={defaults[k] ?? ''} onChange={(e) => setDefaults({ ...defaults, [k]: e.target.value })} />
              </Field>
            ))}
          </>)}
          {step === 3 && preview && (<>
            {preview.blockers.map((x) => <p key={x} className="flex gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"><XCircle className="mt-0.5 size-4 shrink-0" />{x}</p>)}
            {preview.warnings.map((x) => <p key={x} className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{x}</p>)}
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-md border p-3"><p className="text-2xl font-semibold">{preview.audienceSize}</p><p className="text-xs text-muted-foreground">In audience</p></div>
              <div className="rounded-md border border-success/40 bg-green-50 p-3 dark:bg-green-950"><p className="text-2xl font-semibold text-success">{preview.eligible}</p><p className="text-xs text-muted-foreground">Will receive</p></div>
              <div className="rounded-md border p-3"><p className="text-2xl font-semibold">{preview.audienceSize - preview.eligible}</p><p className="text-xs text-muted-foreground">Excluded</p></div>
            </div>
            {Object.keys(preview.skipped).length > 0 && (
              <ul className="space-y-1 text-sm">{Object.entries(preview.skipped).map(([k, n]) => <li key={k} className="flex justify-between"><span className="text-muted-foreground">{SKIP_REASONS[k] ?? k}</span><span className="tabular-nums">{n}</span></li>)}</ul>
            )}
            <p className="text-xs text-muted-foreground">Messaging limit: {preview.limits.messagingTier ?? 'unknown'} ({preview.limits.usedLast24h} used in 24h) · Broadcasts this month: {preview.limits.broadcastsThisMonth}{preview.limits.broadcastsLimit != null ? ` of ${preview.limits.broadcastsLimit}` : ''}</p>
            <fieldset className="space-y-2"><legend className="mb-1 text-sm font-medium">When</legend>
              <label className="flex items-center gap-2 text-sm"><input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} /> Send now</label>
              <label className="flex items-center gap-2 text-sm"><input type="radio" name="when" checked={when === 'later'} onChange={() => setWhen('later')} /> Schedule for later ({b.timezone})</label>
              {when === 'later' && <Input type="datetime-local" aria-label="Scheduled time" value={scheduledAt} min={new Date(Date.now() + 5 * 60_000).toISOString().slice(0, 16)} onChange={(e) => setScheduledAt(e.target.value)} className="max-w-xs" />}
            </fieldset>
          </>)}
          <div className="flex justify-between border-t pt-4">
            <Button variant="outline" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>Back</Button>
            {step < 2 && <Button disabled={!canNext} onClick={() => setStep((s) => s + 1)}>Continue</Button>}
            {step === 2 && <Button loading={busy} onClick={saveDraftAndPreview}>Review</Button>}
            {step === 3 && <Button variant="brand" disabled={!canNext} loading={busy} onClick={schedule}>{when === 'now' ? <><Send /> Send campaign</> : <><CalendarClock /> Schedule campaign</>}</Button>}
          </div>
        </CardContent></Card>
        <Card className="h-fit lg:col-span-2">
          <CardHeader><CardTitle>Preview</CardTitle>{preview?.sample[0] && <CardDescription>For {preview.sample[0].contactName || formatPhone(preview.sample[0].phone)}</CardDescription>}</CardHeader>
          <CardContent>
            {template ? <WhatsAppBubble header={template.headerText} body={preview?.sample[0]?.rendered ?? template.body} footer={template.footerText} /> : <p className="text-sm text-muted-foreground">Choose a template to preview.</p>}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
export function CampaignDetail() {
  const b = useWorkspace();
  const { campaignId = '' } = useParams();
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const live = (s?: string) => !!s && ['scheduled', 'processing'].includes(s);
  const q = useQuery({ queryKey: ['campaign', campaignId], queryFn: () => get<CampaignDto>(`/v1/businesses/${b.id}/campaigns/${campaignId}`), refetchInterval: (query) => (live(query.state.data?.status) ? 2000 : false) });
  const recipients = useQuery({
    queryKey: ['campaign-recipients', campaignId, filter],
    queryFn: () => getPage<CampaignRecipientDto[]>(`/v1/businesses/${b.id}/campaigns/${campaignId}/recipients?pageSize=100${filter ? `&status=${filter}` : ''}`),
    refetchInterval: live(q.data?.status) ? 3000 : false,
  });
  const act = useMutation({
    mutationFn: (a: 'pause' | 'resume' | 'cancel' | 'unschedule') => post<CampaignDto>(`/v1/businesses/${b.id}/campaigns/${campaignId}/${a}`),
    onSuccess: async (c) => { setConfirmCancel(false); qc.setQueryData(['campaign', campaignId], c); await qc.invalidateQueries({ queryKey: ['campaigns', b.id] }); toast.success(`Campaign ${c.status}`); },
    onError: (e) => handleFormError(e),
  });
  if (q.isLoading) return <Skeleton className="h-96" />;
  const c = q.data;
  if (!c) return <EmptyState icon={<Megaphone />} title="Campaign not found" description="" />;
  const s = c.stats;
  const canManage = can(b.myRole, 'campaigns.manage');
  const funnel = [
    { k: 'Eligible', v: s.total - s.skipped, color: '#94a3b8' }, { k: 'Sent', v: s.sent, color: '#2f6bff' }, { k: 'Delivered', v: s.delivered, color: '#14b8a6' },
    { k: 'Read', v: s.read, color: '#16a34a' }, { k: 'Replied', v: s.replied, color: '#7c3aed' }, { k: 'Failed', v: s.failed, color: '#dc2626' },
  ];
  const attempted = s.total - s.skipped;
  const progress = attempted ? Math.round(((attempted - s.pending) / attempted) * 100) : 0;

  return (
    <>
      <Link to={`/w/${b.id}/campaigns`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Campaigns</Link>
      <PageHeader title={c.name} description={`${c.template?.name ?? ''} · created by ${c.createdByName ?? '—'}`}
        actions={<>
          <StatusBadge s={c.status} />
          {canManage && c.status === 'scheduled' && <Button size="sm" variant="outline" loading={act.isPending} onClick={() => act.mutate('unschedule')}><Undo2 /> Back to draft</Button>}
          {canManage && c.status === 'processing' && <Button size="sm" variant="outline" loading={act.isPending} onClick={() => act.mutate('pause')}><Pause /> Pause</Button>}
          {canManage && c.status === 'paused' && <Button size="sm" variant="outline" loading={act.isPending} onClick={() => act.mutate('resume')}><Play /> Resume</Button>}
          {canManage && ['scheduled', 'processing', 'paused'].includes(c.status) && <Button size="sm" variant="destructive" onClick={() => setConfirmCancel(true)}><XCircle /> Cancel</Button>}
          <Button size="sm" variant="outline" onClick={() => downloadFile(`/v1/businesses/${b.id}/campaigns/${c.id}/report.csv`, `${c.name.replace(/\W+/g, '-')}-report.csv`).catch(handleFormError)}><Download /> Export</Button>
        </>} />
      {c.status === 'scheduled' && <p className="mb-4 flex items-center gap-2 rounded-md bg-accent p-3 text-sm text-accent-foreground"><CalendarClock className="size-4" /> Scheduled for {formatDateTime(c.scheduledAt, b.timezone)}</p>}
      {['processing', 'paused'].includes(c.status) && (
        <div className="mb-4"><div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>Sending… {s.pending} remaining</span><span>{progress}%</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full brand-gradient transition-all" style={{ width: `${progress}%` }} /></div></div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {funnel.map((f) => (
          <Card key={f.k}><CardContent className="p-4"><p className="text-xs text-muted-foreground">{f.k}</p><p className="text-xl font-semibold tabular-nums">{formatNumber(f.v)}</p>
            {f.k !== 'Eligible' && <p className="text-xs text-muted-foreground">{pct(f.v, f.k === 'Failed' ? attempted : s.sent || attempted)}</p>}</CardContent></Card>
        ))}
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader><CardTitle>Delivery funnel</CardTitle></CardHeader>
          <CardContent><div className="h-56"><ResponsiveContainer>
            <BarChart data={funnel} layout="vertical" margin={{ left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
              <YAxis type="category" dataKey="k" width={70} tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} />
              <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="v" name="Recipients" radius={[0, 4, 4, 0]}>{funnel.map((f) => <Cell key={f.k} fill={f.color} />)}</Bar>
            </BarChart>
          </ResponsiveContainer></div>
          {s.skipped > 0 && <p className="mt-2 text-xs text-muted-foreground">{s.skipped} contact(s) excluded before sending — filter by “skipped” to see why.</p>}
          {c.completedAt && <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground"><CheckCircle2 className="size-3.5" /> Finished {formatDateTime(c.completedAt, b.timezone)}</p>}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Recipients</CardTitle>
            <NativeSelect className="w-40" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter recipients">
              <option value="">All</option>{['pending', 'queued', 'sent', 'delivered', 'read', 'replied', 'failed', 'skipped'].map((x) => <option key={x} value={x}>{x}</option>)}
            </NativeSelect>
          </CardHeader>
          <div className="max-h-[28rem] overflow-y-auto">
            <Table>
              <thead><tr><Th>Contact</Th><Th>Status</Th><Th className="hidden md:table-cell">Detail</Th><Th className="hidden sm:table-cell">Updated</Th></tr></thead>
              <tbody>
                {recipients.data?.data.map((r) => (
                  <tr key={r.id}>
                    <Td><Link to={`/w/${b.id}/contacts/${r.contactId}`} className="font-medium hover:underline">{r.contactName || formatPhone(r.phone)}</Link><p className="text-xs tabular-nums text-muted-foreground">{formatPhone(r.phone)}</p></Td>
                    <Td><Badge tone={r.status === 'failed' ? 'red' : r.status === 'skipped' ? 'neutral' : ['read', 'replied'].includes(r.status) ? 'green' : r.status === 'delivered' ? 'teal' : 'blue'}>{r.status}</Badge></Td>
                    <Td className="hidden max-w-xs text-xs text-muted-foreground md:table-cell">{r.skipReason ? SKIP_REASONS[r.skipReason] ?? r.skipReason : r.errorCode ? `${r.errorCode}: ${r.errorMessage ?? ''}` : r.attempts > 1 ? `${r.attempts} attempts` : ''}</Td>
                    <Td className="hidden whitespace-nowrap text-xs text-muted-foreground sm:table-cell">{formatDateTime(r.repliedAt ?? r.readAt ?? r.deliveredAt ?? r.sentAt, b.timezone)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {recipients.data && !recipients.data.data.length && <p className="p-6 text-center text-sm text-muted-foreground">{c.status === 'scheduled' || c.status === 'draft' ? 'Recipients are selected when the campaign starts.' : 'No recipients with this status.'}</p>}
          </div>
        </Card>
      </div>
      <ConfirmDialog open={confirmCancel} onOpenChange={setConfirmCancel} destructive title="Cancel this campaign?" confirmLabel="Cancel campaign"
        description="Messages already sent cannot be recalled. Remaining recipients will not be messaged." loading={act.isPending} onConfirm={() => act.mutate('cancel')} />
    </>
  );
}
