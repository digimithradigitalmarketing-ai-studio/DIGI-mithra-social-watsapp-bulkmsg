import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { Bot, BookOpen, CheckCircle2, Hand, Lock, Plus, Send, ShieldAlert, Trash2 } from 'lucide-react';
import type { AiAnswerDto, AiAuditDto, AiSettingsDto, AiSettingsInput, AiUsageDto, KnowledgeSourceDto, MemberDto } from '@socialpilot/shared';
import { api, del, get, getPage, post } from '@/lib/api';
import { handleFormError } from '@/lib/forms';
import { cn, formatDateTime, formatNumber } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Badge, EmptyState, PageHeader, Skeleton, Table, Td, Th } from '@/components/ui/misc';

const tooltipStyle = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 };

function useAiSettings() {
  const b = useWorkspace();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ai-settings', b.id], queryFn: () => get<AiSettingsDto>(`/v1/businesses/${b.id}/ai/settings`) });
  const save = useMutation({
    mutationFn: (v: AiSettingsInput) => api<{ data: AiSettingsDto }>(`/v1/businesses/${b.id}/ai/settings`, { method: 'PUT', json: v }).then((r) => r.data),
    onSuccess: (d) => { qc.setQueryData(['ai-settings', b.id], d); toast.success('AI settings saved'); },
    onError: (e) => handleFormError(e),
  });
  return { q, save };
}

function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  return (
    <label className={cn('flex items-start justify-between gap-4', disabled && 'opacity-50')}>
      <span><span className="block text-sm font-medium">{label}</span>{description && <span className="block text-xs text-muted-foreground">{description}</span>}</span>
      <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={cn('relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors', checked ? 'bg-primary' : 'bg-muted-foreground/30')}>
        <span className={cn('absolute top-0.5 size-5 rounded-full bg-white shadow transition-all', checked ? 'left-5.5' : 'left-0.5')} />
      </button>
    </label>
  );
}

function PlanGate({ s }: { s: AiSettingsDto }) {
  const b = useWorkspace();
  if (s.planTokenLimit > 0) return null;
  return (
    <div className="mb-6 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <Lock className="mt-0.5 size-4 shrink-0" />
      <span>Business AI is included in the <strong>Business</strong> plan. You can build your knowledge base now and test answers once AI is available. <Link to={`/w/${b.id}/settings/subscription`} className="underline">View plans</Link></span>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function AiSupport() {
  const { q, save } = useAiSettings();
  const [instructions, setInstructions] = useState('');
  useEffect(() => { if (q.data) setInstructions(q.data.systemInstructions); }, [q.data]);
  if (!q.data) return <Skeleton className="h-96" />;
  const s = q.data;
  const locked = s.planTokenLimit <= 0;
  return (
    <>
      <PageHeader title="AI Customer Support" description="A business-specific assistant that answers only from your knowledge base and hands everything else to your team." />
      <PlanGate s={s} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Bot className="size-5 text-primary" /> Assistant</CardTitle>
            <CardDescription>Provider: {s.provider === 'mock' ? 'Mock (offline, quotes your knowledge base — for testing)' : s.provider} · model {s.model}</CardDescription></CardHeader>
          <CardContent className="space-y-5">
            <Toggle label="Enable AI" description="Allows reply suggestions, the content assistant and automation AI steps." checked={s.enabled} disabled={locked} onChange={(v) => save.mutate({ enabled: v })} />
            <Toggle label="Auto-reply to customers on WhatsApp" description="Answers new customer messages within the 24-hour window when confident. Stops as soon as a person replies or the AI hands off."
              checked={s.autoReplyEnabled} disabled={locked || !s.enabled} onChange={(v) => save.mutate({ autoReplyEnabled: v })} />
            <Toggle label="Only unassigned conversations" description="Never reply in conversations already assigned to a team member." checked={s.onlyWhenUnassigned} onChange={(v) => save.mutate({ onlyWhenUnassigned: v })} />
            <fieldset><legend className="mb-1.5 text-sm font-medium">Reply languages</legend>
              <div className="flex gap-4 text-sm">
                {(['en', 'kn'] as const).map((l) => (
                  <label key={l} className="flex items-center gap-2"><input type="checkbox" checked={s.languages.includes(l)}
                    onChange={(e) => { const next = e.target.checked ? [...s.languages, l] : s.languages.filter((x) => x !== l); if (next.length) save.mutate({ languages: next }); }} />
                    {l === 'en' ? 'English' : 'ಕನ್ನಡ Kannada'}</label>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Kannada messages get Kannada replies when enabled (with Gemini; the offline mock quotes entries as written).</p>
            </fieldset>
            <div className="grid grid-cols-2 gap-3">
              <Field id="ai-tone" label="Tone"><NativeSelect id="ai-tone" value={s.tone} onChange={(e) => save.mutate({ tone: e.target.value as AiSettingsDto['tone'] })}>
                <option value="friendly">Friendly</option><option value="professional">Professional</option><option value="concise">Concise</option></NativeSelect></Field>
              <Field id="ai-conf" label="Hand off below confidence" hint="Lower = answers more often."><NativeSelect id="ai-conf" value={String(s.handoffConfidenceThreshold)} onChange={(e) => save.mutate({ handoffConfidenceThreshold: Number(e.target.value) })}>
                {[0.6, 0.7, 0.8, 0.9].map((v) => <option key={v} value={v}>{Math.round(v * 100)}%</option>)}</NativeSelect></Field>
            </div>
            <Field id="ai-instr" label="Extra guidance (optional)" hint="e.g. “Invite people to book a free trial at reception.” The safety rules always take priority.">
              <textarea id="ai-instr" rows={3} maxLength={2000} value={instructions} onChange={(e) => setInstructions(e.target.value)}
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring" />
            </Field>
            <Button variant="outline" disabled={instructions === s.systemInstructions} loading={save.isPending} onClick={() => save.mutate({ systemInstructions: instructions })}>Save guidance</Button>
          </CardContent>
        </Card>
        <Playground />
      </div>
      <Card className="mt-6">
        <CardHeader><CardTitle className="flex items-center gap-2"><ShieldAlert className="size-5 text-teal" /> Built-in safeguards</CardTitle></CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground md:grid-cols-2">
          {['Answers only from your active knowledge-base entries', 'Prices, phone numbers and links must appear in your knowledge base, or the reply goes to staff',
            'Health, injury and medical questions always go to staff', 'Customers asking for a person are handed off immediately',
            'Customer messages are treated as untrusted text (prompt-injection protection)', 'Monthly token and spend limits; every AI call is logged in the audit trail',
            'Personal numbers and emails are masked in logs', 'Customer messages are not used to train AI models'].map((t) => (
            <p key={t} className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> {t}</p>
          ))}
        </CardContent>
      </Card>
    </>
  );
}

function Playground() {
  const b = useWorkspace();
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<Array<{ q: string; r: AiAnswerDto }>>([]);
  const ask = useMutation({
    mutationFn: () => post<AiAnswerDto>(`/v1/businesses/${b.id}/ai/test`, { question }),
    onSuccess: (r) => { setHistory((h) => [{ q: question, r }, ...h].slice(0, 6)); setQuestion(''); },
    onError: (e) => handleFormError(e),
  });
  return (
    <Card>
      <CardHeader><CardTitle>Try it</CardTitle><CardDescription>Ask what a customer might ask. Nothing is sent on WhatsApp. Counts towards AI usage.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (question.trim()) ask.mutate(); }}>
          <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What are your timings on Sunday?" aria-label="Test question" />
          <Button type="submit" loading={ask.isPending} aria-label="Ask"><Send /></Button>
        </form>
        {history.length === 0 && <p className="text-sm text-muted-foreground">Answers appear here with the sources used and any safety checks that fired.</p>}
        <ul className="space-y-3">
          {history.map(({ q, r }, i) => (
            <li key={i} className="rounded-md border p-3 text-sm">
              <p className="font-medium">“{q}”</p>
              {r.answer && <p className="mt-2 rounded-md bg-accent p-2 text-accent-foreground">{r.answer}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                <Badge tone={r.outcome === 'answered' ? 'green' : r.outcome === 'handoff' ? 'amber' : 'red'}>{r.outcome === 'answered' ? 'Would reply' : r.outcome === 'handoff' ? 'Would hand off' : r.outcome.replace('_', ' ')}</Badge>
                {r.confidence > 0 && <Badge>{Math.round(r.confidence * 100)}% confidence</Badge>}
                {r.guards.map((g) => <Badge key={g} tone="red">{g.replace(/_/g, ' ')}</Badge>)}
                {r.sources.map((s) => <Badge key={s.id} tone="blue">{s.title}</Badge>)}
              </div>
              {r.handoffReason && <p className="mt-1 text-xs text-muted-foreground">{r.handoffReason}</p>}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
export function Knowledge() {
  const b = useWorkspace();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'faq' | 'text'>('faq');
  const [faq, setFaq] = useState({ question: '', answer: '', language: 'en' });
  const [doc, setDoc] = useState({ title: '', content: '', language: 'en' });
  const q = useQuery({ queryKey: ['ai-knowledge', b.id], queryFn: () => get<KnowledgeSourceDto[]>(`/v1/businesses/${b.id}/ai/knowledge`) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['ai-knowledge', b.id] });
  const add = useMutation({
    mutationFn: () => post(`/v1/businesses/${b.id}/ai/knowledge`, tab === 'faq' ? { sourceType: 'faq', ...faq } : { sourceType: 'text', ...doc }),
    onSuccess: async () => { setFaq({ question: '', answer: '', language: faq.language }); setDoc({ title: '', content: '', language: doc.language }); await invalidate(); toast.success('Added to knowledge base'); },
    onError: (e) => handleFormError(e),
  });
  const toggle = useMutation({ mutationFn: (k: KnowledgeSourceDto) => api(`/v1/businesses/${b.id}/ai/knowledge/${k.id}`, { method: 'PATCH', json: { status: k.status === 'active' ? 'disabled' : 'active' } }), onSuccess: invalidate, onError: (e) => handleFormError(e) });
  const remove = useMutation({ mutationFn: (id: string) => del(`/v1/businesses/${b.id}/ai/knowledge/${id}`), onSuccess: invalidate, onError: (e) => handleFormError(e) });
  const faqs = q.data?.filter((k) => k.sourceType === 'faq') ?? [];
  const docs = q.data?.filter((k) => k.sourceType === 'text') ?? [];
  return (
    <>
      <PageHeader title="Knowledge Base & FAQ" description="The only facts the assistant may use. Keep prices, timings and offers here up to date — anything missing is handed to staff." />
      <Card className="mb-6">
        <CardHeader>
          <div className="inline-flex w-fit rounded-md border bg-background p-1 text-sm" role="tablist">
            <button role="tab" aria-selected={tab === 'faq'} onClick={() => setTab('faq')} className={cn('rounded px-3 py-1.5', tab === 'faq' && 'bg-primary text-primary-foreground')}>FAQ entry</button>
            <button role="tab" aria-selected={tab === 'text'} onClick={() => setTab('text')} className={cn('rounded px-3 py-1.5', tab === 'text' && 'bg-primary text-primary-foreground')}>Business information</button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {tab === 'faq' ? (<>
            <Field id="kb-q" label="Question customers ask"><Input id="kb-q" value={faq.question} placeholder="What are your timings?" onChange={(e) => setFaq({ ...faq, question: e.target.value })} /></Field>
            <Field id="kb-a" label="Approved answer"><textarea id="kb-a" rows={3} value={faq.answer} onChange={(e) => setFaq({ ...faq, answer: e.target.value })} placeholder="We are open 5am–10pm Monday to Saturday and 6am–12pm on Sunday."
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring" /></Field>
          </>) : (<>
            <Field id="kb-t" label="Title"><Input id="kb-t" value={doc.title} placeholder="Facilities, location and parking" onChange={(e) => setDoc({ ...doc, title: e.target.value })} /></Field>
            <Field id="kb-c" label="Content" hint="Plain text. Separate topics with blank lines."><textarea id="kb-c" rows={6} value={doc.content} onChange={(e) => setDoc({ ...doc, content: e.target.value })}
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring" /></Field>
          </>)}
          <div className="flex items-end gap-3">
            <Field id="kb-l" label="Language"><NativeSelect id="kb-l" className="w-36" value={tab === 'faq' ? faq.language : doc.language}
              onChange={(e) => (tab === 'faq' ? setFaq({ ...faq, language: e.target.value }) : setDoc({ ...doc, language: e.target.value }))}><option value="en">English</option><option value="kn">ಕನ್ನಡ</option></NativeSelect></Field>
            <Button onClick={() => add.mutate()} loading={add.isPending}><Plus /> Add</Button>
          </div>
        </CardContent>
      </Card>
      {q.isLoading ? <Skeleton className="h-48" /> : !q.data?.length ? (
        <EmptyState icon={<BookOpen />} title="Your knowledge base is empty" description="Start with 5–10 common questions: timings, fees, location, trial sessions, personal training, holidays." />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {[['FAQ', faqs], ['Business information', docs]].map(([label, list]) => (
            <Card key={label as string}>
              <CardHeader><CardTitle>{label as string} <span className="text-sm font-normal text-muted-foreground">({(list as KnowledgeSourceDto[]).length})</span></CardTitle></CardHeader>
              <ul className="divide-y">
                {(list as KnowledgeSourceDto[]).map((k) => (
                  <li key={k.id} className={cn('flex gap-3 px-5 py-3 text-sm', k.status === 'disabled' && 'opacity-50')}>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{k.question ?? k.title}{k.language === 'kn' && <Badge className="ml-2">ಕನ್ನಡ</Badge>}</p>
                      <p className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">{k.answer ?? k.content}</p>
                    </div>
                    <div className="flex shrink-0 items-start gap-1">
                      <Button size="sm" variant="ghost" onClick={() => toggle.mutate(k)}>{k.status === 'active' ? 'Disable' : 'Enable'}</Button>
                      <Button size="icon" variant="ghost" aria-label="Delete entry" onClick={() => remove.mutate(k.id)}><Trash2 /></Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
export function Handoff() {
  const b = useWorkspace();
  const { q, save } = useAiSettings();
  const members = useQuery({ queryKey: ['members', b.id], queryFn: () => get<MemberDto[]>(`/v1/businesses/${b.id}/members`) });
  const [kw, setKw] = useState('');
  const [max, setMax] = useState(6);
  useEffect(() => { if (q.data) { setKw(q.data.handoffKeywords.join(', ')); setMax(q.data.maxAiRepliesPerConversation); } }, [q.data]);
  if (!q.data) return <Skeleton className="h-64" />;
  const s = q.data;
  return (
    <>
      <PageHeader title="Human Handoff" description="When the assistant stops and your team takes over. Every automated conversation can always reach a person." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Hand className="size-5 text-primary" /> Hand off when…</CardTitle></CardHeader>
          <CardContent className="space-y-4 text-sm">
            <ul className="space-y-1 text-muted-foreground">
              <li>• the answer isn't in the knowledge base or confidence is below {Math.round(s.handoffConfidenceThreshold * 100)}%</li>
              <li>• the question is about health, injuries or medicine</li>
              <li>• a price, phone number or link isn't in the knowledge base</li>
              <li>• the monthly AI limit is reached</li>
            </ul>
            <Field id="ho-kw" label="…or the customer uses any of these words (comma separated)"><Input id="ho-kw" value={kw} onChange={(e) => setKw(e.target.value)} /></Field>
            <Field id="ho-max" label="…or the AI has already replied this many times in the conversation"><Input id="ho-max" type="number" min={1} max={50} value={max} onChange={(e) => setMax(Number(e.target.value))} /></Field>
            <Button loading={save.isPending} onClick={() => save.mutate({ handoffKeywords: kw.split(',').map((x) => x.trim()).filter(Boolean), maxAiRepliesPerConversation: max })}>Save</Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Then</CardTitle><CardDescription>The AI stops replying in that conversation, adds an internal note with the reason, and notifies:</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            {members.data?.filter((m) => m.status === 'active').map((m) => (
              <label key={m.userId} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.handoffNotifyUserIds.includes(m.userId)}
                onChange={(e) => save.mutate({ handoffNotifyUserIds: e.target.checked ? [...s.handoffNotifyUserIds, m.userId] : s.handoffNotifyUserIds.filter((x) => x !== m.userId) })} />
                {m.fullName} <span className="text-xs capitalize text-muted-foreground">{m.role}</span></label>
            ))}
            <p className="pt-2 text-xs text-muted-foreground">Handed-off conversations show in the Team Inbox. A team member replying also stops the AI.</p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
export function AiUsage() {
  const b = useWorkspace();
  const { q: settings, save } = useAiSettings();
  const [outcome, setOutcome] = useState('');
  const [limits, setLimits] = useState({ tokens: '', spend: '' });
  const usage = useQuery({ queryKey: ['ai-usage', b.id], queryFn: () => get<AiUsageDto>(`/v1/businesses/${b.id}/ai/usage`) });
  const audit = useQuery({ queryKey: ['ai-audit', b.id, outcome], queryFn: () => getPage<AiAuditDto[]>(`/v1/businesses/${b.id}/ai/audit?pageSize=50${outcome ? `&outcome=${outcome}` : ''}`) });
  useEffect(() => { if (settings.data) setLimits({ tokens: settings.data.monthlyTokenLimit ? String(settings.data.monthlyTokenLimit) : '', spend: settings.data.monthlySpendLimitPaise ? String(settings.data.monthlySpendLimitPaise / 100) : '' }); }, [settings.data]);
  const u = usage.data;
  const pct = u?.month.tokenLimit ? Math.min(100, Math.round((u.month.tokens / u.month.tokenLimit) * 100)) : 0;
  return (
    <>
      <PageHeader title="AI Usage" description="Tokens, estimated cost, outcomes and the full audit trail of AI answers." />
      {!u ? <Skeleton className="h-64" /> : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Tokens this month</p><p className="text-xl font-semibold">{formatNumber(u.month.tokens)}</p>
              {u.month.tokenLimit ? <><div className="mt-2 h-1.5 rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} /></div><p className="mt-1 text-xs text-muted-foreground">{pct}% of {formatNumber(u.month.tokenLimit)}</p></> : <p className="text-xs text-muted-foreground">Not included in plan</p>}</CardContent></Card>
            <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Estimated cost</p><p className="text-xl font-semibold">₹{(u.month.costPaise / 100).toFixed(2)}</p><p className="text-xs text-muted-foreground">{u.month.spendLimitPaise ? `cap ₹${u.month.spendLimitPaise / 100}` : 'no spend cap'}</p></CardContent></Card>
            <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Answered (30 days)</p><p className="text-xl font-semibold text-success">{u.outcomes.answered ?? 0}</p></CardContent></Card>
            <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Handed to staff (30 days)</p><p className="text-xl font-semibold text-amber-600">{(u.outcomes.handoff ?? 0) + (u.outcomes.blocked ?? 0) + (u.outcomes.limit_reached ?? 0)}</p></CardContent></Card>
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2"><CardHeader><CardTitle>Daily answers</CardTitle></CardHeader><CardContent><div className="h-56"><ResponsiveContainer>
              <BarChart data={u.daily.map((d) => ({ ...d, date: d.date.slice(5) }))} margin={{ left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} minTickGap={16} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
                <Tooltip contentStyle={tooltipStyle} /><Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="answered" name="Answered" stackId="a" fill="#16a34a" /><Bar dataKey="handoff" name="Handed off" stackId="a" fill="#d97706" radius={[4, 4, 0, 0]} />
              </BarChart></ResponsiveContainer></div></CardContent></Card>
            <Card><CardHeader><CardTitle>Limits</CardTitle><CardDescription>Optional caps below your plan allowance ({formatNumber(settings.data?.planTokenLimit ?? 0)} tokens).</CardDescription></CardHeader>
              <CardContent className="space-y-3">
                <Field id="lim-t" label="Monthly token cap" hint="Empty = plan allowance"><Input id="lim-t" type="number" min={0} value={limits.tokens} onChange={(e) => setLimits({ ...limits, tokens: e.target.value })} /></Field>
                <Field id="lim-s" label="Monthly spend cap (₹)" hint="Estimated from configured rates"><Input id="lim-s" type="number" min={0} value={limits.spend} onChange={(e) => setLimits({ ...limits, spend: e.target.value })} /></Field>
                <Button loading={save.isPending} onClick={() => save.mutate({ monthlyTokenLimit: Number(limits.tokens || 0), monthlySpendLimitPaise: Math.round(Number(limits.spend || 0) * 100) })}>Save limits</Button>
              </CardContent></Card>
          </div>
          <Card>
            <CardHeader className="flex-row items-center justify-between"><div><CardTitle>Audit trail</CardTitle><CardDescription>Every AI call. Phone numbers and emails are masked.</CardDescription></div>
              <NativeSelect className="w-44" value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Outcome"><option value="">All outcomes</option>{['answered', 'handoff', 'blocked', 'limit_reached', 'error'].map((o) => <option key={o} value={o}>{o.replace('_', ' ')}</option>)}</NativeSelect></CardHeader>
            <Table>
              <thead><tr><Th>When</Th><Th>Question → answer</Th><Th>Outcome</Th><Th className="hidden md:table-cell">Feature</Th></tr></thead>
              <tbody>{audit.data?.data.map((a) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(a.createdAt, b.timezone)}{a.contactName && <span className="block">{a.contactName}</span>}</Td>
                  <Td className="max-w-xl text-sm"><p className="font-medium">“{a.question}”</p>{a.answer && <p className="text-muted-foreground">{a.answer}</p>}{a.handoffReason && <p className="text-xs text-amber-700 dark:text-amber-400">{a.handoffReason}</p>}</Td>
                  <Td><Badge tone={a.outcome === 'answered' ? 'green' : a.outcome === 'handoff' ? 'amber' : 'red'}>{a.outcome.replace('_', ' ')}</Badge>{a.confidence != null && a.confidence > 0 && <span className="block text-xs text-muted-foreground">{Math.round(a.confidence * 100)}%</span>}
                    {a.guards.map((g) => <span key={g} className="block text-[11px] text-destructive">{g.replace(/_/g, ' ')}</span>)}</Td>
                  <Td className="hidden text-xs text-muted-foreground md:table-cell">{a.feature.replace(/_/g, ' ')}<span className="block">{a.inputTokens + a.outputTokens} tokens</span></Td>
                </tr>
              ))}</tbody>
            </Table>
            {audit.data && !audit.data.data.length && <p className="p-6 text-center text-sm text-muted-foreground">No AI calls yet.</p>}
          </Card>
        </div>
      )}
    </>
  );
}

