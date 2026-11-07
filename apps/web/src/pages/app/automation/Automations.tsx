import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, CheckCircle2, CircleDashed, GitBranch, Plus, RotateCcw, Sparkles, Workflow, XCircle, Clock, PauseCircle } from 'lucide-react';
import { TRIGGER_LABELS, type ExecutionDto, type TriggerType, type WorkflowDto } from '@socialpilot/shared';
import { get, getPage, post } from '@/lib/api';
import { handleFormError } from '@/lib/forms';
import { cn, formatDateTime } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Badge, EmptyState, PageHeader, Skeleton, Table, Td, Th } from '@/components/ui/misc';
import { formatPhone } from '../contacts/shared';

const STATUS_TONE = { draft: 'neutral', published: 'green', paused: 'amber', archived: 'neutral' } as const;

export default function Automations() {
  const b = useWorkspace();
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['automations', b.id], queryFn: () => get<WorkflowDto[]>(`/v1/businesses/${b.id}/automations`) });
  return (
    <>
      <PageHeader title="Automations" description="Trigger → conditions → actions → delays. Messages still follow consent, opt-out and WhatsApp template rules."
        actions={<>
          <Button variant="outline" asChild><Link to={`/w/${b.id}/automation/executions`}>Execution history</Link></Button>
          <Button onClick={() => setCreating(true)}><Plus /> New workflow</Button>
        </>} />
      {q.isLoading ? <Skeleton className="h-48" /> : !q.data?.length ? (
        <EmptyState icon={<Workflow />} title="No workflows yet" description="Start from a ready-made gym workflow: enquiry acknowledgement, renewal reminders, birthdays, PT follow-ups and more."
          action={<Button onClick={() => setCreating(true)}><Sparkles /> Browse templates</Button>} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {q.data.map((w) => (
            <Link key={w.id} to={`/w/${b.id}/automation/${w.id}`} className="block">
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="leading-snug">{w.name}</CardTitle>
                    <Badge tone={STATUS_TONE[w.status]}>{w.status}</Badge>
                  </div>
                  <CardDescription className="line-clamp-2">{w.description || TRIGGER_LABELS[w.triggerType].description}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p className="flex items-center gap-2 text-muted-foreground"><Sparkles className="size-4 text-primary" /> {TRIGGER_LABELS[w.triggerType].label}</p>
                  <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                    <span><CheckCircle2 className="mr-1 inline size-3.5 text-success" />{w.stats.completed} completed</span>
                    <span><Clock className="mr-1 inline size-3.5" />{w.stats.waiting} waiting</span>
                    {w.stats.failed > 0 && <span className="text-destructive"><XCircle className="mr-1 inline size-3.5" />{w.stats.failed} failed</span>}
                  </div>
                  {w.hasUnpublishedChanges && <Badge tone="amber">Unpublished changes</Badge>}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
      <NewWorkflowDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

function NewWorkflowDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const b = useWorkspace();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [templateKey, setTemplateKey] = useState<string>('');
  const [name, setName] = useState('');
  const templates = useQuery({
    queryKey: ['automation-templates', b.id],
    queryFn: () => get<Array<{ key: string; name: string; description: string; triggerType: TriggerType; stepCount: number }>>(`/v1/businesses/${b.id}/automation-templates`),
    enabled: open,
  });
  const create = useMutation({
    mutationFn: () => post<WorkflowDto>(`/v1/businesses/${b.id}/automations`, { name: name || templates.data?.find((t) => t.key === templateKey)?.name || 'New workflow', templateKey: templateKey || undefined }),
    onSuccess: async (w) => { await qc.invalidateQueries({ queryKey: ['automations', b.id] }); onOpenChange(false); navigate(`/w/${b.id}/automation/${w.id}`); },
    onError: (e) => handleFormError(e),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New workflow" description="Pick a ready-made workflow or start blank. Nothing runs until you publish."
      footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button loading={create.isPending} onClick={() => create.mutate()}>Create</Button></>}>
      <div className="space-y-3">
        <Field id="wf-name" label="Name (optional)"><Input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Uses the template name if empty" /></Field>
        <div className="grid max-h-80 gap-2 overflow-y-auto pr-1" role="radiogroup" aria-label="Templates">
          <button role="radio" aria-checked={!templateKey} onClick={() => setTemplateKey('')} className={cn('rounded-md border p-3 text-left text-sm', !templateKey && 'border-primary bg-accent')}>
            <p className="font-medium">Blank workflow</p><p className="text-xs text-muted-foreground">Choose your own trigger and steps</p>
          </button>
          {templates.data?.map((t) => (
            <button key={t.key} role="radio" aria-checked={templateKey === t.key} onClick={() => setTemplateKey(t.key)} className={cn('rounded-md border p-3 text-left text-sm', templateKey === t.key && 'border-primary bg-accent')}>
              <p className="font-medium">{t.name}</p>
              <p className="text-xs text-muted-foreground">{t.description}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">{TRIGGER_LABELS[t.triggerType].label} · {t.stepCount} steps</p>
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Execution history & failed logs
// ---------------------------------------------------------------------------
const EXEC_ICON = {
  running: <CircleDashed className="size-4 animate-spin text-primary" />, waiting: <Clock className="size-4 text-amber-600" />,
  completed: <CheckCircle2 className="size-4 text-success" />, failed: <XCircle className="size-4 text-destructive" />, cancelled: <PauseCircle className="size-4 text-muted-foreground" />,
};

export function Executions() {
  const b = useWorkspace();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const workflowId = params.get('workflowId') ?? '';
  const [open, setOpen] = useState<string | null>(null);
  const workflows = useQuery({ queryKey: ['automations', b.id], queryFn: () => get<WorkflowDto[]>(`/v1/businesses/${b.id}/automations`) });
  const q = useQuery({
    queryKey: ['executions', b.id, status, workflowId],
    queryFn: () => getPage<ExecutionDto[]>(`/v1/businesses/${b.id}/automation-executions?pageSize=50${status ? `&status=${status}` : ''}${workflowId ? `&workflowId=${workflowId}` : ''}`),
    refetchInterval: 5000,
  });
  const detail = useQuery({ queryKey: ['execution', open], queryFn: () => get<ExecutionDto>(`/v1/businesses/${b.id}/automation-executions/${open}`), enabled: !!open, refetchInterval: 4000 });
  const retry = useMutation({
    mutationFn: (id: string) => post(`/v1/businesses/${b.id}/automation-executions/${id}/retry`),
    onSuccess: async () => { toast.success('Retrying'); await qc.invalidateQueries({ queryKey: ['executions', b.id] }); await qc.invalidateQueries({ queryKey: ['execution'] }); },
    onError: (e) => handleFormError(e),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => post(`/v1/businesses/${b.id}/automation-executions/${id}/cancel`),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['executions', b.id] }); await qc.invalidateQueries({ queryKey: ['execution'] }); },
    onError: (e) => handleFormError(e),
  });
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p); };
  return (
    <>
      <Link to={`/w/${b.id}/automation`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Automations</Link>
      <PageHeader title={status === 'failed' ? 'Failed automation runs' : 'Execution history'} description="Every run, each step and its result. Failed runs can be retried after fixing the cause." />
      <div className="mb-4 flex flex-wrap gap-2">
        {['', 'running', 'waiting', 'completed', 'failed', 'cancelled'].map((s) => (
          <Button key={s || 'all'} size="sm" variant={status === s ? 'default' : 'outline'} onClick={() => set('status', s)} className="capitalize">{s || 'All'}</Button>
        ))}
        <NativeSelect className="ml-auto h-8 w-56" value={workflowId} onChange={(e) => set('workflowId', e.target.value)} aria-label="Workflow">
          <option value="">All workflows</option>{workflows.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </NativeSelect>
      </div>
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          {q.isLoading ? <CardContent className="pt-5"><Skeleton className="h-40" /></CardContent> : !q.data?.data.length ? (
            <CardContent className="pt-5"><EmptyState icon={<GitBranch />} title="No runs" description="Runs appear when a published workflow is triggered." /></CardContent>
          ) : (
            <Table>
              <thead><tr><Th>Run</Th><Th>Contact</Th><Th className="hidden md:table-cell">Started</Th></tr></thead>
              <tbody>{q.data.data.map((e) => (
                <tr key={e.id} className={cn('cursor-pointer hover:bg-muted/50', open === e.id && 'bg-accent')} onClick={() => setOpen(e.id)}>
                  <Td><span className="flex items-center gap-2">{EXEC_ICON[e.status]}<span><span className="font-medium">{e.workflowName}</span> <span className="text-xs text-muted-foreground">v{e.version}</span>
                    {e.error && <span className="block max-w-xs truncate text-xs text-destructive">{e.error}</span>}</span></span></Td>
                  <Td>{e.contact ? (e.contact.name || formatPhone(e.contact.phone)) : '—'}</Td>
                  <Td className="hidden whitespace-nowrap text-xs text-muted-foreground md:table-cell">{formatDateTime(e.startedAt, b.timezone)}</Td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Card>
        <Card className="h-fit lg:col-span-2">
          {!open || !detail.data ? <CardContent className="pt-5 text-sm text-muted-foreground">Select a run to see its steps.</CardContent> : (
            <>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">{EXEC_ICON[detail.data.status]} {detail.data.workflowName}</CardTitle>
                <CardDescription>
                  {detail.data.contact && <Link className="text-primary hover:underline" to={`/w/${b.id}/contacts/${detail.data.contact.id}`}>{detail.data.contact.name || formatPhone(detail.data.contact.phone)}</Link>}
                  {' · '}trigger: {String(detail.data.trigger.type ?? '').replace(/_/g, ' ')}
                  {detail.data.nextRunAt && <> · resumes {formatDateTime(detail.data.nextRunAt, b.timezone)}</>}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {detail.data.error && <p className="rounded-md bg-red-50 p-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{detail.data.error}</p>}
                <ol className="space-y-2">
                  {detail.data.steps?.map((s) => (
                    <li key={s.id} className="rounded-md border p-2 text-sm">
                      <p className="flex items-center justify-between gap-2"><span className="font-medium">{s.type.replace(/_/g, ' ')} <span className="font-mono text-xs text-muted-foreground">{s.nodeId}</span></span>
                        <Badge tone={s.status === 'completed' ? 'green' : s.status === 'failed' ? 'red' : s.status === 'skipped' ? 'amber' : 'blue'}>{s.status}</Badge></p>
                      {s.error && <p className="mt-1 text-xs text-destructive">{s.error}</p>}
                      {s.output != null && Object.keys(s.output as object).length > 0 && <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{JSON.stringify(s.output)}</p>}
                    </li>
                  ))}
                </ol>
                <div className="flex gap-2">
                  {detail.data.status === 'failed' && <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate(detail.data!.id)}><RotateCcw /> Retry from failed step</Button>}
                  {['running', 'waiting'].includes(detail.data.status) && <Button size="sm" variant="outline" onClick={() => cancel.mutate(detail.data!.id)}>Cancel run</Button>}
                </div>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </>
  );
}

export function useWorkflowId() {
  const { workflowId = '' } = useParams();
  return workflowId;
}
