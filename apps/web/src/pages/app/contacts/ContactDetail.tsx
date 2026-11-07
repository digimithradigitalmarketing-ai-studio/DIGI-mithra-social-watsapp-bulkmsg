import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Archive, ArchiveRestore, FlaskConical, ListChecks, MessageCircle, ShieldCheck, ShieldOff, StickyNote, TrendingUp } from 'lucide-react';
import { can, type ConsentRecordDto, type ContactDto, type LeadDto, type TaskDto, type TimelineMessageDto } from '@socialpilot/shared';
import { get, post } from '@/lib/api';
import { handleFormError } from '@/lib/forms';
import { cn, formatDate, formatDateTime, formatPaise } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Avatar, Badge, EmptyState, Skeleton } from '@/components/ui/misc';
import { ConsentBadge, TagPill, formatPhone } from './shared';
import { useChannel } from '../whatsapp/Connection';

interface Detail { contact: ContactDto; consents: ConsentRecordDto[]; messages: TimelineMessageDto[] }

export default function ContactDetail() {
  const b = useWorkspace();
  const { contactId = '' } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['contact', contactId], queryFn: () => get<Detail>(`/v1/businesses/${b.id}/contacts/${contactId}`) });
  const channel = useChannel(b.id);
  const [consentOpen, setConsentOpen] = useState(false);
  const [simOpen, setSimOpen] = useState(false);
  const canWrite = can(b.myRole, 'contacts.write');
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['contact', contactId] }), qc.invalidateQueries({ queryKey: ['contacts', b.id] })]);
  const archive = useMutation({
    mutationFn: (a: 'archive' | 'restore') => post(`/v1/businesses/${b.id}/contacts/${contactId}/${a}`),
    onSuccess: async () => { await refresh(); toast.success('Saved'); },
    onError: (e) => handleFormError(e),
  });

  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!q.data) return <EmptyState icon={<MessageCircle />} title="Contact not found" description="It may have been removed." />;
  const { contact: c, consents, messages } = q.data;
  const isMock = channel.data?.data?.mode === 'mock';

  return (
    <>
      <Link to={`/w/${b.id}/contacts`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Contacts</Link>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Avatar name={c.name || c.phone} className="size-12 text-base" />
                <div className="min-w-0"><h1 className="truncate text-lg font-semibold">{c.name || 'Unnamed contact'}</h1><p className="tabular-nums text-sm text-muted-foreground">{formatPhone(c.phone)}</p></div>
              </div>
              <div className="mt-4 flex flex-wrap gap-1.5">{c.tags.map((t) => <TagPill key={t.id} t={t} />)}</div>
              <dl className="mt-4 space-y-2 text-sm">
                {[['Email', c.email], ['Language', c.language === 'kn' ? 'ಕನ್ನಡ' : 'English'], ['Birthday', c.birthday], ['Source', c.source.replace(/_/g, ' ')],
                  ['Last contacted', formatDateTime(c.lastContactedAt, b.timezone)], ['Added', formatDate(c.createdAt, b.timezone)],
                  ...Object.entries(c.customFields).map(([k, v]) => [k.replace(/_/g, ' '), v])].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4"><dt className="capitalize text-muted-foreground">{k}</dt><dd className="text-right">{v || '—'}</dd></div>
                ))}
              </dl>
              {c.archivedAt && <Badge tone="amber" className="mt-3">Archived</Badge>}
              {canWrite && (
                <div className="mt-4 flex gap-2">
                  {c.archivedAt
                    ? <Button size="sm" variant="outline" onClick={() => archive.mutate('restore')}><ArchiveRestore /> Restore</Button>
                    : <Button size="sm" variant="outline" onClick={() => archive.mutate('archive')}><Archive /> Archive</Button>}
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div><CardTitle>Consent</CardTitle><CardDescription>Append-only record of opt-ins and opt-outs</CardDescription></div>
              <ConsentBadge c={c} />
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                {consents.length === 0 && <li className="text-sm text-muted-foreground">No consent recorded. This contact will not receive campaigns.</li>}
                {consents.map((x) => (
                  <li key={x.id} className="flex gap-3 text-sm">
                    {x.status === 'granted' ? <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" /> : <ShieldOff className="mt-0.5 size-4 shrink-0 text-destructive" />}
                    <div><p><span className="font-medium capitalize">{x.purpose}</span> {x.status} · {x.source.replace(/_/g, ' ')}</p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(x.occurredAt, b.timezone)}{x.capturedBy ? ` · by ${x.capturedBy}` : ''}</p></div>
                  </li>
                ))}
              </ul>
              {canWrite && <Button size="sm" variant="outline" className="mt-4" onClick={() => setConsentOpen(true)}>Record consent change</Button>}
            </CardContent>
          </Card>
        </div>
        <div className="space-y-6 lg:col-span-2">
        <CustomerTimeline contactId={c.id} />
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div><CardTitle>Message history</CardTitle><CardDescription>Reply from the <Link to={`/w/${b.id}/inbox`} className="text-primary hover:underline">team inbox</Link></CardDescription></div>
            {isMock && <Button size="sm" variant="outline" onClick={() => setSimOpen(true)}><FlaskConical /> Simulate customer reply</Button>}
          </CardHeader>
          <CardContent>
            {messages.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">No messages yet</p> : (
              <ol className="space-y-3">
                {[...messages].reverse().map((m) => (
                  <li key={m.id} className={cn('flex', m.direction === 'outbound' ? 'justify-end' : 'justify-start')}>
                    <div className={cn('max-w-[80%] rounded-lg px-3 py-2 text-sm', m.direction === 'outbound' ? 'bg-accent text-accent-foreground' : 'border bg-card')}>
                      {m.campaignName && <p className="mb-1 text-[11px] font-medium uppercase tracking-wide opacity-70">Campaign · {m.campaignName}</p>}
                      <p className="whitespace-pre-wrap">{m.body ?? `[${m.type}]`}</p>
                      <p className="mt-1 text-[11px] opacity-70">{formatDateTime(m.createdAt, b.timezone)}{m.direction === 'outbound' && ` · ${m.status}${m.errorCode ? ` (${m.errorCode})` : ''}`}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
        </div>
      </div>
      <ConsentDialog open={consentOpen} onOpenChange={setConsentOpen} onDone={refresh} />
      <SimulateDialog open={simOpen} onOpenChange={setSimOpen} phone={c.phone} name={c.name} onDone={refresh} />
    </>
  );
}

interface TimelineData {
  notes: Array<{ id: string; body: string; authorName: string | null; createdAt: string }>;
  leads: LeadDto[];
  tasks: TaskDto[];
  stageEvents: Array<{ leadTitle: string; stage: string | null; byName: string | null; createdAt: string }>;
}

/** Notes, leads, follow-ups and stage changes for one customer. */
function CustomerTimeline({ contactId }: { contactId: string }) {
  const b = useWorkspace();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const q = useQuery({ queryKey: ['timeline', contactId], queryFn: () => get<TimelineData>(`/v1/businesses/${b.id}/contacts/${contactId}/timeline`) });
  const addNote = useMutation({
    mutationFn: () => post(`/v1/businesses/${b.id}/contacts/${contactId}/notes`, { body: note }),
    onSuccess: async () => { setNote(''); await qc.invalidateQueries({ queryKey: ['timeline', contactId] }); },
    onError: (e) => handleFormError(e),
  });
  const items = [
    ...(q.data?.notes ?? []).map((n) => ({ at: n.createdAt, icon: <StickyNote className="size-4 text-amber-600" />, text: n.body, meta: n.authorName ?? 'Team' })),
    ...(q.data?.stageEvents ?? []).map((e) => ({ at: e.createdAt, icon: <TrendingUp className="size-4 text-primary" />, text: `${e.leadTitle} → ${e.stage ?? '—'}`, meta: e.byName ?? '' })),
    ...(q.data?.tasks ?? []).map((t) => ({ at: t.createdAt, icon: <ListChecks className={cn('size-4', t.overdue ? 'text-destructive' : 'text-teal')} />, text: `${t.status === 'done' ? '✓ ' : ''}${t.title}`, meta: t.dueAt ? `due ${formatDateTime(t.dueAt, b.timezone)}` : '' })),
  ].sort((a, z) => z.at.localeCompare(a.at));
  return (
    <Card>
      <CardHeader><CardTitle>Customer timeline</CardTitle><CardDescription>{q.data?.leads.length ?? 0} lead(s) · notes, follow-ups and pipeline changes</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) addNote.mutate(); }}>
          <Input placeholder="Add a note (visible to your team only)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="New note" />
          <Button type="submit" loading={addNote.isPending} disabled={!note.trim()}>Add</Button>
        </form>
        {q.data?.leads.map((l) => (
          <div key={l.id} className="flex items-center justify-between rounded-md border p-2 text-sm">
            <span className="font-medium">{l.title}</span>
            <span className="flex items-center gap-2">{l.valuePaise != null && <span className="text-muted-foreground">{formatPaise(l.valuePaise)}</span>}<Badge tone={l.status === 'won' ? 'green' : l.status === 'lost' ? 'red' : 'blue'}>{l.status}</Badge></span>
          </div>
        ))}
        <ol className="space-y-3">
          {items.length === 0 && <li className="text-sm text-muted-foreground">Nothing yet.</li>}
          {items.map((it, i) => (
            <li key={i} className="flex gap-3 text-sm">{it.icon}<div><p className="whitespace-pre-wrap">{it.text}</p><p className="text-xs text-muted-foreground">{formatDateTime(it.at, b.timezone)}{it.meta ? ` · ${it.meta}` : ''}</p></div></li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function ConsentDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => Promise<unknown> }) {
  const b = useWorkspace();
  const { contactId = '' } = useParams();
  const [v, setV] = useState({ purpose: 'marketing', status: 'granted', source: '', note: '' });
  const save = useMutation({
    mutationFn: () => post(`/v1/businesses/${b.id}/contacts/${contactId}/consents`, { ...v, note: v.note || undefined }),
    onSuccess: async () => { onOpenChange(false); setV({ purpose: 'marketing', status: 'granted', source: '', note: '' }); await onDone(); toast.success('Consent recorded'); },
    onError: (e) => handleFormError(e),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Record consent change" description="Consent records are kept permanently as evidence. Revoking marketing consent also adds the number to your suppression list."
      footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button loading={save.isPending} disabled={v.source.trim().length < 3} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="cs-purpose" label="Purpose"><NativeSelect id="cs-purpose" value={v.purpose} onChange={(e) => setV({ ...v, purpose: e.target.value })}><option value="marketing">Marketing</option><option value="utility">Service / utility</option></NativeSelect></Field>
        <Field id="cs-status" label="Change"><NativeSelect id="cs-status" value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}><option value="granted">Granted (opt in)</option><option value="revoked">Revoked (opt out)</option></NativeSelect></Field>
        <div className="sm:col-span-2"><Field id="cs-source" label="How / where"><Input id="cs-source" placeholder="e.g. Customer asked at front desk" value={v.source} onChange={(e) => setV({ ...v, source: e.target.value })} /></Field></div>
        <div className="sm:col-span-2"><Field id="cs-note" label="Note (optional)"><Input id="cs-note" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field></div>
      </div>
    </Dialog>
  );
}

function SimulateDialog({ open, onOpenChange, phone, name, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; phone: string; name: string; onDone: () => Promise<unknown> }) {
  const b = useWorkspace();
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: () => post(`/v1/businesses/${b.id}/channels/whatsapp/mock/inbound`, { phone, name, text }),
    onSuccess: async () => { setText(''); onOpenChange(false); await onDone(); toast.success('Simulated reply received'); },
    onError: (e) => handleFormError(e),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Simulate a customer message" description="Test tool for mock connections: the message goes through the same webhook processing as real WhatsApp messages. Try STOP or START."
      footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button loading={send.isPending} disabled={!text.trim()} onClick={() => send.mutate()}>Send as customer</Button></>}>
      <Field id="sim-text" label={`Message from ${name || phone}`}><Input id="sim-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Hi, is the gym open on Sunday?" /></Field>
    </Dialog>
  );
}
