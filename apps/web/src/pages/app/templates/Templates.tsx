import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileText, Plus, RefreshCw, Send, Sparkles, Trash2 } from 'lucide-react';
import { BUILTIN_VARIABLES, SUGGESTED_CUSTOM_VARIABLES, TEMPLATE_LANGUAGES, can, extractVariables, type TemplateDto } from '@socialpilot/shared';
import { del, get, post } from '@/lib/api';
import { handleFormError } from '@/lib/forms';
import { formatDate } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Badge, EmptyState, PageHeader, Skeleton, Table, Td, Th } from '@/components/ui/misc';

export const templateTone = (s: string) => (s === 'APPROVED' ? 'green' : s === 'PENDING' ? 'amber' : s === 'REJECTED' || s === 'DISABLED' ? 'red' : 'neutral') as 'green' | 'amber' | 'red' | 'neutral';

export function WhatsAppBubble({ header, body, footer }: { header?: string | null; body: string; footer?: string | null }) {
  return (
    <div className="rounded-xl bg-[#e5ddd5] p-4 dark:bg-[#0b141a]">
      <div className="max-w-sm rounded-lg rounded-tl-none bg-white p-3 text-sm text-slate-900 shadow-sm dark:bg-[#202c33] dark:text-slate-100">
        {header && <p className="mb-1 font-semibold">{header}</p>}
        <p className="whitespace-pre-wrap">{body || <span className="text-slate-400">Your message…</span>}</p>
        {footer && <p className="mt-2 text-xs text-slate-500">{footer}</p>}
        <p className="mt-1 text-right text-[10px] text-slate-400">10:30</p>
      </div>
    </div>
  );
}

export default function Templates() {
  const b = useWorkspace();
  const qc = useQueryClient();
  const canManage = can(b.myRole, 'templates.manage');
  const q = useQuery({ queryKey: ['templates', b.id], queryFn: () => get<TemplateDto[]>(`/v1/businesses/${b.id}/templates`), refetchInterval: (query) => (query.state.data?.some((t) => t.status === 'PENDING') ? 3000 : false) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['templates', b.id] });
  const submit = useMutation({ mutationFn: (id: string) => post<TemplateDto>(`/v1/businesses/${b.id}/templates/${id}/submit`), onSuccess: async () => { await invalidate(); toast.success('Submitted to Meta for review'); }, onError: (e) => handleFormError(e) });
  const sync = useMutation({ mutationFn: () => post<{ updated: number; imported: number; note?: string }>(`/v1/businesses/${b.id}/templates/sync`), onSuccess: async (r) => { await invalidate(); toast.success(r.note ?? `Synced: ${r.updated} updated, ${r.imported} imported`); }, onError: (e) => handleFormError(e) });
  const remove = useMutation({ mutationFn: (id: string) => del(`/v1/businesses/${b.id}/templates/${id}`), onSuccess: async () => { await invalidate(); toast.success('Deleted'); }, onError: (e) => handleFormError(e) });

  return (
    <>
      <PageHeader title="Message Templates" description="Campaigns and messages outside the 24-hour window must use templates approved by Meta."
        actions={canManage && <>
          <Button variant="outline" onClick={() => sync.mutate()} loading={sync.isPending}><RefreshCw /> Sync from Meta</Button>
          <Button asChild><Link to={`/w/${b.id}/templates/new`}><Plus /> New template</Link></Button>
        </>} />
      <Card>
        {q.isLoading ? <CardContent className="pt-5"><Skeleton className="h-40" /></CardContent> : !q.data?.length ? (
          <CardContent className="pt-5"><EmptyState icon={<FileText />} title="No templates yet" description="Create a template such as a membership renewal reminder, then submit it to Meta for approval."
            action={canManage && <Button asChild><Link to={`/w/${b.id}/templates/new`}><Plus /> New template</Link></Button>} /></CardContent>
        ) : (
          <Table>
            <thead><tr><Th>Template</Th><Th className="hidden md:table-cell">Category</Th><Th>Status</Th><Th className="hidden lg:table-cell">Message</Th><Th /></tr></thead>
            <tbody>
              {q.data.map((t) => (
                <tr key={t.id}>
                  <Td><p className="font-mono text-sm font-medium">{t.name}</p><p className="text-xs text-muted-foreground">{TEMPLATE_LANGUAGES[t.language as keyof typeof TEMPLATE_LANGUAGES] ?? t.language} · {formatDate(t.createdAt, b.timezone)}{t.provider === 'mock' ? ' · mock review' : ''}</p></Td>
                  <Td className="hidden md:table-cell"><Badge tone={t.category === 'MARKETING' ? 'blue' : 'teal'}>{t.category.toLowerCase()}</Badge></Td>
                  <Td><Badge tone={templateTone(t.status)}>{t.status.toLowerCase()}</Badge>{t.rejectionReason && <p className="mt-1 max-w-48 text-xs text-destructive">{t.rejectionReason}</p>}</Td>
                  <Td className="hidden max-w-md truncate text-muted-foreground lg:table-cell">{t.body}</Td>
                  <Td className="whitespace-nowrap text-right">
                    {canManage && ['DRAFT', 'REJECTED'].includes(t.status) && <>
                      <Button size="sm" variant="outline" loading={submit.isPending && submit.variables === t.id} onClick={() => submit.mutate(t.id)}><Send /> Submit</Button>
                      <Button size="icon" variant="ghost" aria-label={`Delete ${t.name}`} onClick={() => remove.mutate(t.id)}><Trash2 /></Button>
                    </>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

export function NewTemplate() {
  const b = useWorkspace();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [v, setV] = useState({ name: '', language: 'en', category: 'MARKETING', headerText: '', body: '', footerText: '' });
  const [examples, setExamples] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const vars = useMemo(() => extractVariables(v.body), [v.body]);
  const previewBody = v.body.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_m, k: string) => examples[k] || `{{${k}}}`);
  const insert = (k: string) => setV((x) => ({ ...x, body: `${x.body}{{${k}}}` }));
  const [idea, setIdea] = useState('');
  const [drafting, setDrafting] = useState(false);
  const draft = async () => {
    setDrafting(true);
    try {
      const r = await post<{ text: string }>(`/v1/businesses/${b.id}/ai/content`, { kind: 'template_body', prompt: idea, category: v.category, language: v.language === 'kn' ? 'kn' : 'en' });
      setV((x) => ({ ...x, body: r.text.replace(/^\[Mock draft\]\s*/, '').slice(0, 1024) }));
      toast.success('Draft added — edit it before submitting');
    } catch (e) { handleFormError(e); } finally { setDrafting(false); }
  };

  const save = async (andSubmit: boolean) => {
    setBusy(true); setErrors({});
    try {
      const t = await post<TemplateDto>(`/v1/businesses/${b.id}/templates`, { ...v, examples: Object.fromEntries(vars.map((k) => [k, examples[k] ?? ''])) });
      if (andSubmit) await post(`/v1/businesses/${b.id}/templates/${t.id}/submit`);
      await qc.invalidateQueries({ queryKey: ['templates', b.id] });
      toast.success(andSubmit ? 'Template submitted for review' : 'Draft saved');
      navigate(`/w/${b.id}/templates`);
    } catch (e) {
      const f = (e as { fields?: Record<string, string> }).fields;
      if (f && Object.keys(f).length) setErrors(f); else handleFormError(e);
    } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader title="New template" description="Write your message with friendly placeholders like {{customer_name}}. We convert them to Meta's numbered format automatically." />
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3"><CardContent className="space-y-4 pt-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-3"><Field id="t-name" label="Template name" error={errors.name} hint="Lowercase letters, numbers and underscores, e.g. membership_renewal">
              <Input id="t-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></Field></div>
            <Field id="t-cat" label="Category" hint={v.category === 'MARKETING' ? 'Offers, announcements. Needs marketing consent.' : 'Reminders about an existing membership or payment.'}>
              <NativeSelect id="t-cat" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}><option value="MARKETING">Marketing</option><option value="UTILITY">Utility</option></NativeSelect></Field>
            <Field id="t-lang" label="Language"><NativeSelect id="t-lang" value={v.language} onChange={(e) => setV({ ...v, language: e.target.value })}>
              {Object.entries(TEMPLATE_LANGUAGES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</NativeSelect></Field>
          </div>
          <Field id="t-header" label="Header (optional)" error={errors.headerText}><Input id="t-header" maxLength={60} value={v.headerText} onChange={(e) => setV({ ...v, headerText: e.target.value })} /></Field>
          <div className="flex gap-2 rounded-md border border-dashed p-2">
            <Input aria-label="Describe the message for AI" className="h-9" placeholder="AI draft: e.g. remind members their membership expires soon and offer a renewal call" value={idea} onChange={(e) => setIdea(e.target.value)} />
            <Button type="button" variant="outline" className="h-9" loading={drafting} disabled={idea.trim().length < 3} onClick={draft}><Sparkles /> Draft with AI</Button>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="t-body" className="text-sm font-medium">Message body</label>
            <textarea id="t-body" rows={6} maxLength={1024} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} aria-invalid={!!errors.body}
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring aria-[invalid=true]:border-destructive"
              placeholder="Hi {{customer_name}}, your membership at {{business_name}} expires on {{membership_expiry}}. Reply YES to renew. Reply STOP to opt out." />
            {errors.body && <p role="alert" className="text-xs text-destructive">{errors.body}</p>}
            <div className="flex flex-wrap gap-1.5">
              {[...Object.keys(BUILTIN_VARIABLES), ...SUGGESTED_CUSTOM_VARIABLES].map((k) => <button key={k} type="button" onClick={() => insert(k)} className="rounded-full border px-2 py-0.5 text-xs hover:bg-muted">{`{{${k}}}`}</button>)}
            </div>
            <p className="text-xs text-muted-foreground">Other names are read from contact custom fields (e.g. from your CSV import) or campaign defaults. {v.body.length}/1024</p>
          </div>
          <Field id="t-footer" label="Footer (optional)"><Input id="t-footer" maxLength={60} value={v.footerText} onChange={(e) => setV({ ...v, footerText: e.target.value })} /></Field>
          {vars.length > 0 && (
            <fieldset className="space-y-3 rounded-md border p-4"><legend className="px-1 text-sm font-medium">Sample values (sent to Meta for review)</legend>
              {vars.map((k) => <Field key={k} id={`ex-${k}`} label={`{{${k}}}`} error={errors[`examples.${k}`]}><Input id={`ex-${k}`} value={examples[k] ?? ''} onChange={(e) => setExamples({ ...examples, [k]: e.target.value })} /></Field>)}
            </fieldset>
          )}
          <div className="flex gap-2">
            <Button variant="outline" loading={busy} onClick={() => save(false)}>Save draft</Button>
            <Button variant="brand" loading={busy} onClick={() => save(true)}><Send /> Save & submit for approval</Button>
          </div>
        </CardContent></Card>
        <Card className="h-fit lg:col-span-2">
          <CardHeader><CardTitle>Preview</CardTitle><CardDescription>How customers will see it</CardDescription></CardHeader>
          <CardContent><WhatsAppBubble header={v.headerText} body={previewBody} footer={v.footerText} /></CardContent>
        </Card>
      </div>
    </>
  );
}
