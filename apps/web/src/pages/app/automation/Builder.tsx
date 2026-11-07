import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertTriangle, ArrowLeft, Bell, Bot, CheckCircle2, Clock, FlaskConical, GitBranch, ListChecks, Pause, Play, Plus, Rocket, Save, Send, Sparkles, Tag, Trash2,
  TrendingUp, UserCheck, PencilLine, Archive,
} from 'lucide-react';
import {
  STEP_LABELS, TRIGGER_LABELS, TRIGGER_TYPES, type Condition, type ContactDto, type MemberDto, type PipelineDto, type Step, type StepType, type TagDto,
  type TemplateDto, type Trigger, type TriggerType, type WorkflowDefinition, type WorkflowDto,
} from '@socialpilot/shared';
import { ApiError, api, get, getPage, post } from '@/lib/api';
import { handleFormError } from '@/lib/forms';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { DropdownContent, DropdownItem, DropdownMenu, DropdownTrigger } from '@/components/ui/dropdown';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Badge, Skeleton } from '@/components/ui/misc';
import { formatPhone } from '../contacts/shared';

type ListPath = Array<number | 'yes' | 'no'>;
type Selected = 'trigger' | string; // step id

// ---------------------------------------------------------------------------
// Immutable tree helpers
// ---------------------------------------------------------------------------
function getList(steps: Step[], path: ListPath): Step[] {
  let list = steps;
  for (let i = 0; i < path.length; i += 2) {
    const s = list[path[i] as number] as Extract<Step, { type: 'branch' }>;
    list = path[i + 1] === 'yes' ? s.yes : s.no;
  }
  return list;
}
function mapList(steps: Step[], path: ListPath, fn: (list: Step[]) => Step[]): Step[] {
  if (!path.length) return fn(steps);
  const [i, arm, ...rest] = path as [number, 'yes' | 'no', ...ListPath];
  return steps.map((s, idx) => (idx !== i || s.type !== 'branch' ? s : { ...s, [arm]: mapList(s[arm], rest, fn) }));
}
function findStep(steps: Step[], id: string): Step | undefined {
  for (const s of steps) {
    if (s.id === id) return s;
    if (s.type === 'branch') { const f = findStep(s.yes, id) ?? findStep(s.no, id); if (f) return f; }
  }
  return undefined;
}
function replaceStep(steps: Step[], id: string, next: Step): Step[] {
  return steps.map((s) => (s.id === id ? next : s.type === 'branch' ? { ...s, yes: replaceStep(s.yes, id, next), no: replaceStep(s.no, id, next) } : s));
}
function removeStep(steps: Step[], id: string): Step[] {
  return steps.filter((s) => s.id !== id).map((s) => (s.type === 'branch' ? { ...s, yes: removeStep(s.yes, id), no: removeStep(s.no, id) } : s));
}
const newId = () => `s${Math.random().toString(36).slice(2, 8)}`;

function blankStep(type: StepType): Step {
  const id = newId();
  switch (type) {
    case 'send_template': return { id, type, config: { templateId: '', defaults: {} } } as Step;
    case 'assign_conversation': return { id, type, config: { userId: '' } } as Step;
    case 'create_lead': return { id, type, config: { title: 'New enquiry', source: 'automation' } };
    case 'create_task': return { id, type, config: { title: 'Follow up', dueInHours: 24 } };
    case 'add_tag': case 'remove_tag': return { id, type, config: { tagId: '' } } as Step;
    case 'notify_staff': return { id, type, config: { userIds: [], message: '' } };
    case 'update_field': return { id, type, config: { field: '', value: '' } } as Step;
    case 'wait': return { id, type, config: { amount: 1, unit: 'days' } };
    case 'branch': return { id, type, config: { condition: { kind: 'marketing_consent' } }, yes: [], no: [] };
    case 'ai_reply_suggestion': return { id, type, config: {} };
  }
}

const STEP_ICON: Record<StepType, typeof Send> = {
  send_template: Send, assign_conversation: UserCheck, create_lead: TrendingUp, create_task: ListChecks, add_tag: Tag, remove_tag: Tag,
  notify_staff: Bell, update_field: PencilLine, wait: Clock, branch: GitBranch, ai_reply_suggestion: Bot,
};
const ADDABLE: StepType[] = ['send_template', 'wait', 'branch', 'create_lead', 'create_task', 'assign_conversation', 'add_tag', 'remove_tag', 'notify_staff', 'update_field'];

interface Refs { templates: TemplateDto[]; tags: TagDto[]; members: MemberDto[]; stages: PipelineDto['stages'] }

function summary(step: Step, refs: Refs): string {
  const tag = (id: string) => refs.tags.find((t) => t.id === id)?.name;
  const member = (id: string) => refs.members.find((m) => m.userId === id)?.fullName;
  switch (step.type) {
    case 'send_template': return refs.templates.find((t) => t.id === step.config.templateId)?.name ?? 'Choose a template';
    case 'assign_conversation': return member(step.config.userId) ? `to ${member(step.config.userId)}` : 'Choose a team member';
    case 'create_lead': return step.config.title;
    case 'create_task': return `${step.config.title} · due in ${step.config.dueInHours}h`;
    case 'add_tag': case 'remove_tag': return tag(step.config.tagId) ?? 'Choose a tag';
    case 'notify_staff': return step.config.userIds.length ? `${step.config.userIds.map(member).filter(Boolean).join(', ')}` : 'Choose who to notify';
    case 'update_field': return step.config.field ? `${step.config.field} = ${step.config.value}` : 'Choose a field';
    case 'wait': return `${step.config.amount} ${step.config.unit}`;
    case 'branch': return conditionText(step.config.condition, refs);
    case 'ai_reply_suggestion': return 'Available in Phase 5';
  }
}
function conditionText(c: Condition, refs: Refs) {
  switch (c.kind) {
    case 'has_tag': return `Has tag “${refs.tags.find((t) => t.id === c.tagId)?.name ?? '?'}”`;
    case 'marketing_consent': return 'Has marketing consent';
    case 'field_equals': return `${c.field || '?'} = “${c.value}”`;
    case 'field_present': return `${c.field || '?'} is filled in`;
    case 'message_contains': return `Message contains ${c.keywords.join(', ') || '…'}`;
    case 'replied_since_start': return 'Customer replied since this run started';
    case 'language_is': return `Language is ${c.language === 'kn' ? 'Kannada' : 'English'}`;
  }
}
function triggerText(t: Trigger, refs: Refs) {
  const c = t.config as Record<string, unknown>;
  switch (t.type) {
    case 'tag_added': return `Tag “${refs.tags.find((x) => x.id === c.tagId)?.name ?? 'choose a tag'}”`;
    case 'customer_replied': return (c.keywords as string[] | undefined)?.length ? `Contains: ${(c.keywords as string[]).join(', ')}` : 'Any message';
    case 'membership_expiring': case 'payment_due': return `${c.daysBefore} day(s) before “${c.field}”, at ${c.hour}:00`;
    case 'birthday': return `At ${c.hour}:00 on their birthday`;
    case 'scheduled': return c.mode === 'daily' ? `Every day at ${c.time ?? '?'}` : c.at ? `Once at ${new Date(String(c.at)).toLocaleString('en-IN')}` : 'Choose a time';
    case 'lead_stage_changed': return c.stageId ? `Moved to “${refs.stages.find((s) => s.id === c.stageId)?.name ?? '?'}”` : 'Any stage';
    default: return TRIGGER_LABELS[t.type].description;
  }
}

// ---------------------------------------------------------------------------
export default function Builder() {
  const b = useWorkspace();
  const { workflowId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const wf = useQuery({ queryKey: ['automation', workflowId], queryFn: () => get<WorkflowDto>(`/v1/businesses/${b.id}/automations/${workflowId}`) });
  const templates = useQuery({ queryKey: ['templates', b.id], queryFn: () => get<TemplateDto[]>(`/v1/businesses/${b.id}/templates`) });
  const tags = useQuery({ queryKey: ['tags', b.id], queryFn: () => get<TagDto[]>(`/v1/businesses/${b.id}/tags`) });
  const members = useQuery({ queryKey: ['members', b.id], queryFn: () => get<MemberDto[]>(`/v1/businesses/${b.id}/members`) });
  const pipelines = useQuery({ queryKey: ['pipelines', b.id], queryFn: () => get<PipelineDto[]>(`/v1/businesses/${b.id}/pipelines`) });
  const refs: Refs = { templates: templates.data ?? [], tags: tags.data ?? [], members: (members.data ?? []).filter((m) => m.status === 'active'), stages: pipelines.data?.[0]?.stages ?? [] };

  const [def, setDef] = useState<WorkflowDefinition | null>(null);
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<Selected>('trigger');
  const [errors, setErrors] = useState<Array<{ stepId?: string; message: string }>>([]);
  const [testOpen, setTestOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  useEffect(() => {
    if (wf.data && !def) {
      setDef((wf.data.draft ?? wf.data.published?.definition) as WorkflowDefinition);
      setName(wf.data.name);
    }
  }, [wf.data, def]);
  const update = (next: WorkflowDefinition) => { setDef(next); setDirty(true); };
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const saveDraft = async () => {
    const w = await api<{ data: WorkflowDto }>(`/v1/businesses/${b.id}/automations/${workflowId}/draft`, { method: 'PUT', json: { definition: def, name } });
    qc.setQueryData(['automation', workflowId], w.data);
    setDirty(false);
    return w.data;
  };
  const save = useMutation({ mutationFn: saveDraft, onSuccess: () => toast.success('Draft saved'), onError: (e) => handleFormError(e) });
  const publish = useMutation({
    mutationFn: async () => { await saveDraft(); return post<WorkflowDto>(`/v1/businesses/${b.id}/automations/${workflowId}/publish`); },
    onSuccess: async (w) => { setErrors([]); qc.setQueryData(['automation', workflowId], w); await qc.invalidateQueries({ queryKey: ['automations', b.id] }); toast.success(`Published version ${w.published?.version}`); },
    onError: (e) => {
      const list = e instanceof ApiError ? (e.details as { errors?: Array<{ stepId?: string; message: string }> } | undefined)?.errors : undefined;
      if (list?.length) { setErrors(list); toast.error(`${list.length} problem(s) to fix before publishing`); if (list[0]?.stepId) setSelected(list[0].stepId); }
      else handleFormError(e);
    },
  });
  const lifecycle = useMutation({
    mutationFn: (a: 'pause' | 'resume' | 'archive') => post<WorkflowDto | null>(`/v1/businesses/${b.id}/automations/${workflowId}/${a}`),
    onSuccess: async (w, a) => {
      await qc.invalidateQueries({ queryKey: ['automations', b.id] });
      if (a === 'archive') { navigate(`/w/${b.id}/automation`); return; }
      if (w) qc.setQueryData(['automation', workflowId], w);
      toast.success(a === 'pause' ? 'Paused — no new runs will start' : 'Resumed');
    },
    onError: (e) => handleFormError(e),
  });

  if (wf.isLoading || !def) return <Skeleton className="h-96" />;
  const w = wf.data!;
  const selectedStep = selected === 'trigger' ? null : findStep(def.steps, selected);
  const stepErrors = (id?: string) => errors.filter((e) => e.stepId === id);

  return (
    <>
      <Link to={`/w/${b.id}/automation`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Automations</Link>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input className="h-10 max-w-md text-lg font-semibold" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} aria-label="Workflow name" />
        <Badge tone={w.status === 'published' ? 'green' : w.status === 'paused' ? 'amber' : 'neutral'}>{w.status}{w.published ? ` · v${w.published.version}` : ''}</Badge>
        {dirty ? <Badge tone="amber">Unsaved changes</Badge>
          : !w.published ? <Badge tone="amber">Not published yet</Badge>
          : w.hasUnpublishedChanges ? <Badge tone="amber">Draft differs from live version</Badge> : null}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" asChild><Link to={`/w/${b.id}/automation/executions?workflowId=${w.id}`}>Runs ({w.stats.completed + w.stats.failed + w.stats.waiting})</Link></Button>
          {w.status === 'published' && <Button variant="outline" onClick={() => setTestOpen(true)}><FlaskConical /> Test run</Button>}
          {w.status === 'published' && <Button variant="outline" loading={lifecycle.isPending} onClick={() => lifecycle.mutate('pause')}><Pause /> Pause</Button>}
          {w.status === 'paused' && <Button variant="outline" loading={lifecycle.isPending} onClick={() => lifecycle.mutate('resume')}><Play /> Resume</Button>}
          <Button variant="ghost" size="icon" aria-label="Archive workflow" onClick={() => setArchiveOpen(true)}><Archive /></Button>
          <Button variant="outline" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}><Save /> Save draft</Button>
          <Button variant="brand" loading={publish.isPending} onClick={() => publish.mutate()}><Rocket /> {w.published ? 'Publish changes' : 'Publish'}</Button>
        </div>
      </div>
      {errors.length > 0 && (
        <div className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <p className="mb-1 flex items-center gap-2 font-medium"><AlertTriangle className="size-4" /> Fix these before publishing</p>
          <ul className="list-inside list-disc">{errors.map((e, i) => <li key={i}><button className="underline-offset-2 hover:underline" onClick={() => e.stepId && setSelected(e.stepId)}>{e.message}</button></li>)}</ul>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="overflow-x-auto rounded-lg border bg-muted/30 p-6">
          <div className="mx-auto flex w-fit min-w-72 flex-col items-center">
            <button onClick={() => setSelected('trigger')} className={cn('w-80 rounded-lg border-2 bg-card p-3 text-left shadow-sm', selected === 'trigger' ? 'border-primary' : 'border-transparent')}>
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-primary"><Sparkles className="size-4" /> When</p>
              <p className="mt-1 font-medium">{TRIGGER_LABELS[def.trigger.type].label}</p>
              <p className="text-xs text-muted-foreground">{triggerText(def.trigger, refs)}</p>
            </button>
            <StepList steps={def.steps} path={[]} def={def} update={update} selected={selected} setSelected={setSelected} refs={refs} errorIds={new Set(errors.map((e) => e.stepId).filter(Boolean) as string[])} />
            <div className="mt-1 flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground"><CheckCircle2 className="size-3.5" /> End</div>
          </div>
        </div>
        <Card className="h-fit lg:sticky lg:top-4">
          <CardContent className="space-y-4 pt-5">
            {selected === 'trigger' || !selectedStep ? (
              <TriggerEditor def={def} update={update} refs={refs} />
            ) : (
              <StepEditor key={selectedStep.id} step={selectedStep} refs={refs} errors={stepErrors(selectedStep.id)}
                onChange={(s) => update({ ...def, steps: replaceStep(def.steps, s.id, s) })}
                onDelete={() => { update({ ...def, steps: removeStep(def.steps, selectedStep.id) }); setSelected('trigger'); }} />
            )}
          </CardContent>
        </Card>
      </div>
      <TestRunDialog open={testOpen} onOpenChange={setTestOpen} workflowId={w.id} needsText={def.trigger.type === 'customer_replied'} />
      <ConfirmDialog open={archiveOpen} onOpenChange={setArchiveOpen} destructive title="Archive this workflow?" confirmLabel="Archive"
        description="It stops immediately and waiting runs are cancelled. Run history is kept." loading={lifecycle.isPending} onConfirm={() => lifecycle.mutate('archive')} />
    </>
  );
}

function Inserter({ onAdd }: { onAdd: (t: StepType) => void }) {
  return (
    <div className="flex flex-col items-center">
      <div className="h-4 w-px bg-border" />
      <DropdownMenu>
        <DropdownTrigger asChild>
          <button className="flex size-7 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm hover:border-primary hover:text-primary" aria-label="Add step"><Plus className="size-4" /></button>
        </DropdownTrigger>
        <DropdownContent align="start">
          {ADDABLE.map((t) => { const Icon = STEP_ICON[t]; return <DropdownItem key={t} onSelect={() => onAdd(t)}><Icon /> {STEP_LABELS[t]}</DropdownItem>; })}
        </DropdownContent>
      </DropdownMenu>
      <div className="h-4 w-px bg-border" />
    </div>
  );
}

function StepList({ steps, path, def, update, selected, setSelected, refs, errorIds }: {
  steps: Step[]; path: ListPath; def: WorkflowDefinition; update: (d: WorkflowDefinition) => void; selected: Selected; setSelected: (s: Selected) => void; refs: Refs; errorIds: Set<string>;
}) {
  const insert = (index: number, type: StepType) => {
    const step = blankStep(type);
    update({ ...def, steps: mapList(def.steps, path, (list) => [...list.slice(0, index), step, ...list.slice(index)]) });
    setSelected(step.id);
  };
  return (
    <div className="flex flex-col items-center">
      <Inserter onAdd={(t) => insert(0, t)} />
      {steps.map((s, i) => {
        const Icon = STEP_ICON[s.type];
        return (
          <div key={s.id} className="flex flex-col items-center">
            <button onClick={() => setSelected(s.id)} className={cn('w-80 rounded-lg border-2 bg-card p-3 text-left shadow-sm',
              selected === s.id ? 'border-primary' : errorIds.has(s.id) ? 'border-destructive' : 'border-transparent', s.type === 'wait' && 'bg-amber-50 dark:bg-amber-950/40')}>
              <p className="flex items-center gap-2 text-sm font-medium"><Icon className={cn('size-4', s.type === 'branch' ? 'text-teal' : 'text-primary')} /> {STEP_LABELS[s.type]}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{summary(s, refs)}</p>
            </button>
            {s.type === 'branch' && (
              <div className="mt-2 grid grid-cols-2 gap-4 rounded-lg border border-dashed p-3">
                {(['yes', 'no'] as const).map((arm) => (
                  <div key={arm} className="flex flex-col items-center">
                    <Badge tone={arm === 'yes' ? 'green' : 'red'}>{arm === 'yes' ? 'Yes' : 'No'}</Badge>
                    <StepList steps={s[arm]} path={[...path, i, arm]} def={def} update={update} selected={selected} setSelected={setSelected} refs={refs} errorIds={errorIds} />
                  </div>
                ))}
              </div>
            )}
            <Inserter onAdd={(t) => insert(i + 1, t)} />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector: trigger
// ---------------------------------------------------------------------------
function TriggerEditor({ def, update, refs }: { def: WorkflowDefinition; update: (d: WorkflowDefinition) => void; refs: Refs }) {
  const t = def.trigger;
  const c = t.config as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const setType = (type: TriggerType) => {
    const defaults: Record<TriggerType, object> = {
      enquiry_submitted: {}, website_form_submitted: {}, contact_created: {}, tag_added: { tagId: '' }, customer_replied: { keywords: [] }, lead_stage_changed: {},
      membership_expiring: { field: 'membership_expiry', daysBefore: 7, hour: 9 }, payment_due: { field: 'payment_due', daysBefore: 1, hour: 10 }, birthday: { hour: 9 },
      scheduled: { mode: 'daily', time: '09:00', audience: { type: 'all', tagIds: [] } },
    };
    update({ ...def, trigger: { type, config: defaults[type] } as Trigger });
  };
  const set = (patch: Record<string, unknown>) => update({ ...def, trigger: { ...t, config: { ...c, ...patch } } as Trigger });
  const kind = TRIGGER_LABELS[t.type].kind;
  return (
    <>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Trigger</p>
      <Field id="tr-type" label="Start this workflow when…">
        <NativeSelect id="tr-type" value={t.type} onChange={(e) => setType(e.target.value as TriggerType)}>
          {TRIGGER_TYPES.map((x) => <option key={x} value={x}>{TRIGGER_LABELS[x].label}</option>)}
        </NativeSelect>
      </Field>
      <p className="text-xs text-muted-foreground">{TRIGGER_LABELS[t.type].description}</p>
      {t.type === 'tag_added' && <TagSelect id="tr-tag" label="Tag" value={c.tagId} refs={refs} onChange={(v) => set({ tagId: v })} />}
      {t.type === 'customer_replied' && (
        <Field id="tr-kw" label="Only if the message contains (comma separated, optional)">
          <Input id="tr-kw" defaultValue={(c.keywords ?? []).join(', ')} placeholder="personal training, PT, trainer"
            onBlur={(e) => set({ keywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
        </Field>
      )}
      {t.type === 'lead_stage_changed' && (
        <Field id="tr-stage" label="Stage"><NativeSelect id="tr-stage" value={c.stageId ?? ''} onChange={(e) => set({ stageId: e.target.value || undefined })}>
          <option value="">Any stage</option>{refs.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</NativeSelect></Field>
      )}
      {(t.type === 'membership_expiring' || t.type === 'payment_due') && (
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-3"><Field id="tr-field" label="Date field on the contact" hint="Values like 2026-11-30, 30/11/2026 or 30 Nov all work."><Input id="tr-field" value={c.field} onChange={(e) => set({ field: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} /></Field></div>
          <Field id="tr-days" label="Days before"><Input id="tr-days" type="number" min={0} max={90} value={c.daysBefore} onChange={(e) => set({ daysBefore: Number(e.target.value) })} /></Field>
          <Field id="tr-hour" label="At hour"><Input id="tr-hour" type="number" min={0} max={23} value={c.hour} onChange={(e) => set({ hour: Number(e.target.value) })} /></Field>
        </div>
      )}
      {t.type === 'birthday' && <Field id="tr-bh" label="At hour (business timezone)"><Input id="tr-bh" type="number" min={0} max={23} value={c.hour} onChange={(e) => set({ hour: Number(e.target.value) })} /></Field>}
      {t.type === 'scheduled' && (
        <>
          <Field id="tr-mode" label="Repeat"><NativeSelect id="tr-mode" value={c.mode} onChange={(e) => set({ mode: e.target.value })}><option value="daily">Every day</option><option value="once">Once</option></NativeSelect></Field>
          {c.mode === 'daily'
            ? <Field id="tr-time" label="Time"><Input id="tr-time" type="time" value={c.time ?? '09:00'} onChange={(e) => set({ time: e.target.value })} /></Field>
            : <Field id="tr-at" label="Date and time"><Input id="tr-at" type="datetime-local" value={c.at ? new Date(c.at).toLocaleString('sv').slice(0, 16) : ''} onChange={(e) => set({ at: e.target.value ? new Date(e.target.value).toISOString() : undefined })} /></Field>}
          <Field id="tr-aud" label="For"><NativeSelect id="tr-aud" value={c.audience?.type ?? 'all'} onChange={(e) => set({ audience: { type: e.target.value, tagIds: c.audience?.tagIds ?? [] } })}><option value="all">All contacts</option><option value="tags">Contacts with tags</option></NativeSelect></Field>
          {c.audience?.type === 'tags' && (
            <div className="flex flex-wrap gap-2">{refs.tags.map((tg) => (
              <label key={tg.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={(c.audience.tagIds ?? []).includes(tg.id)}
                onChange={(e) => set({ audience: { type: 'tags', tagIds: e.target.checked ? [...c.audience.tagIds, tg.id] : c.audience.tagIds.filter((x: string) => x !== tg.id) } })} /> {tg.name}</label>
            ))}</div>
          )}
        </>
      )}
      {kind === 'event' && (
        <Field id="tr-re" label="If the same contact triggers it again">
          <NativeSelect id="tr-re" value={def.reentry} onChange={(e) => update({ ...def, reentry: e.target.value as WorkflowDefinition['reentry'] })}>
            <option value="daily">Run at most once per day</option><option value="once">Run only once ever</option><option value="always">Run every time</option>
          </NativeSelect>
        </Field>
      )}
    </>
  );
}

function TagSelect({ id, label, value, refs, onChange }: { id: string; label: string; value: string; refs: Refs; onChange: (v: string) => void }) {
  return <Field id={id} label={label}><NativeSelect id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}><option value="">Choose a tag…</option>{refs.tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</NativeSelect></Field>;
}
function MemberSelect({ id, label, value, refs, onChange }: { id: string; label: string; value: string | undefined; refs: Refs; onChange: (v: string) => void }) {
  return <Field id={id} label={label}><NativeSelect id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}><option value="">Choose…</option>{refs.members.map((m) => <option key={m.userId} value={m.userId}>{m.fullName} ({m.role})</option>)}</NativeSelect></Field>;
}

// ---------------------------------------------------------------------------
// Inspector: step
// ---------------------------------------------------------------------------
function StepEditor({ step, refs, errors, onChange, onDelete }: { step: Step; refs: Refs; errors: Array<{ message: string }>; onChange: (s: Step) => void; onDelete: () => void }) {
  const c = step.config as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const set = (patch: Record<string, unknown>) => onChange({ ...step, config: { ...c, ...patch } } as Step);
  const approved = refs.templates.filter((t) => t.status === 'APPROVED');
  const tpl = refs.templates.find((t) => t.id === c.templateId);
  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{STEP_LABELS[step.type]}</p>
        <Button variant="ghost" size="icon" aria-label="Delete step" onClick={onDelete}><Trash2 /></Button>
      </div>
      {errors.map((e, i) => <p key={i} className="rounded-md bg-red-50 p-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">{e.message}</p>)}
      {step.type === 'send_template' && (
        <>
          <Field id="st-tpl" label="Approved template" hint="Marketing templates go only to contacts with marketing consent; others need service consent. Opt-outs are always skipped.">
            <NativeSelect id="st-tpl" value={c.templateId} onChange={(e) => set({ templateId: e.target.value })}>
              <option value="">Choose…</option>{approved.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.category.toLowerCase()})</option>)}
            </NativeSelect>
          </Field>
          {!approved.length && <p className="text-xs text-muted-foreground">No approved templates yet. <Link to="../../templates/new" relative="path" className="text-primary underline">Create one</Link>.</p>}
          {tpl && <p className="rounded-md bg-muted p-2 text-xs">{tpl.body}</p>}
          {tpl?.variables.filter((v) => !['business_name', 'customer_phone'].includes(v)).map((v) => (
            <Field key={v} id={`st-def-${v}`} label={`Fallback for {{${v}}}`}><Input id={`st-def-${v}`} value={c.defaults?.[v] ?? ''} onChange={(e) => set({ defaults: { ...c.defaults, [v]: e.target.value } })} /></Field>
          ))}
        </>
      )}
      {step.type === 'wait' && (
        <div className="grid grid-cols-2 gap-2">
          <Field id="st-amt" label="Wait"><Input id="st-amt" type="number" min={1} value={c.amount} onChange={(e) => set({ amount: Number(e.target.value) })} /></Field>
          <Field id="st-unit" label="Unit"><NativeSelect id="st-unit" value={c.unit} onChange={(e) => set({ unit: e.target.value })}><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></NativeSelect></Field>
        </div>
      )}
      {step.type === 'branch' && <ConditionEditor condition={c.condition} refs={refs} onChange={(condition) => set({ condition })} />}
      {step.type === 'create_lead' && (
        <>
          <Field id="st-lt" label="Lead title"><Input id="st-lt" value={c.title} onChange={(e) => set({ title: e.target.value })} /></Field>
          <Field id="st-ls" label="Source"><Input id="st-ls" value={c.source} onChange={(e) => set({ source: e.target.value })} /></Field>
          <Field id="st-lstage" label="Stage"><NativeSelect id="st-lstage" value={c.stageId ?? ''} onChange={(e) => set({ stageId: e.target.value || undefined })}><option value="">First stage</option>{refs.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</NativeSelect></Field>
          <MemberSelect id="st-la" label="Assign to (optional)" value={c.assignTo} refs={refs} onChange={(v) => set({ assignTo: v || undefined })} />
        </>
      )}
      {step.type === 'create_task' && (
        <>
          <Field id="st-tt" label="Task"><Input id="st-tt" value={c.title} onChange={(e) => set({ title: e.target.value })} /></Field>
          <Field id="st-td" label="Due in (hours)"><Input id="st-td" type="number" min={0} value={c.dueInHours} onChange={(e) => set({ dueInHours: Number(e.target.value) })} /></Field>
          <MemberSelect id="st-ta" label="Assign to (optional)" value={c.assignTo} refs={refs} onChange={(v) => set({ assignTo: v || undefined })} />
        </>
      )}
      {(step.type === 'add_tag' || step.type === 'remove_tag') && <TagSelect id="st-tag" label="Tag" value={c.tagId} refs={refs} onChange={(v) => set({ tagId: v })} />}
      {step.type === 'assign_conversation' && <MemberSelect id="st-as" label="Assign the open conversation to" value={c.userId} refs={refs} onChange={(v) => set({ userId: v })} />}
      {step.type === 'notify_staff' && (
        <>
          <fieldset><legend className="mb-1 text-sm font-medium">Notify</legend>
            {refs.members.map((m) => (
              <label key={m.userId} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={c.userIds.includes(m.userId)}
                onChange={(e) => set({ userIds: e.target.checked ? [...c.userIds, m.userId] : c.userIds.filter((x: string) => x !== m.userId) })} /> {m.fullName}</label>
            ))}
          </fieldset>
          <Field id="st-msg" label="Message"><Input id="st-msg" value={c.message} onChange={(e) => set({ message: e.target.value })} /></Field>
          <p className="text-xs text-muted-foreground">Shown in the bell menu with a link to the conversation or contact.</p>
        </>
      )}
      {step.type === 'update_field' && (
        <>
          <Field id="st-f" label="Custom field key"><Input id="st-f" value={c.field} placeholder="membership_status" onChange={(e) => set({ field: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} /></Field>
          <Field id="st-v" label="Value"><Input id="st-v" value={c.value} onChange={(e) => set({ value: e.target.value })} /></Field>
        </>
      )}
      {step.type === 'ai_reply_suggestion' && <p className="text-sm text-muted-foreground">AI reply suggestions arrive with the AI Center in Phase 5. This step is skipped for now.</p>}
      <p className="text-[11px] text-muted-foreground">Step id: <span className="font-mono">{step.id}</span></p>
    </>
  );
}

function ConditionEditor({ condition, refs, onChange }: { condition: Condition; refs: Refs; onChange: (c: Condition) => void }) {
  const c = condition as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const kinds: Array<[Condition['kind'], string]> = [
    ['marketing_consent', 'Has marketing consent'], ['has_tag', 'Has tag'], ['replied_since_start', 'Customer replied since this run started'],
    ['message_contains', 'Triggering message contains'], ['field_equals', 'Field equals'], ['field_present', 'Field is filled in'], ['language_is', 'Language is'],
  ];
  const defaults: Record<Condition['kind'], Condition> = {
    marketing_consent: { kind: 'marketing_consent' }, has_tag: { kind: 'has_tag', tagId: '' } as Condition, replied_since_start: { kind: 'replied_since_start' },
    message_contains: { kind: 'message_contains', keywords: [] } as unknown as Condition, field_equals: { kind: 'field_equals', field: '', value: '' } as Condition,
    field_present: { kind: 'field_present', field: '' } as Condition, language_is: { kind: 'language_is', language: 'kn' },
  };
  return (
    <>
      <Field id="cd-kind" label="If…"><NativeSelect id="cd-kind" value={condition.kind} onChange={(e) => onChange(defaults[e.target.value as Condition['kind']])}>
        {kinds.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</NativeSelect></Field>
      {condition.kind === 'has_tag' && <TagSelect id="cd-tag" label="Tag" value={c.tagId} refs={refs} onChange={(v) => onChange({ kind: 'has_tag', tagId: v })} />}
      {condition.kind === 'message_contains' && <Field id="cd-kw" label="Keywords (comma separated)"><Input id="cd-kw" defaultValue={(c.keywords ?? []).join(', ')} onBlur={(e) => onChange({ kind: 'message_contains', keywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>}
      {(condition.kind === 'field_equals' || condition.kind === 'field_present') && <Field id="cd-f" label="Custom field key"><Input id="cd-f" value={c.field} onChange={(e) => onChange({ ...c, field: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') } as Condition)} /></Field>}
      {condition.kind === 'field_equals' && <Field id="cd-v" label="Equals"><Input id="cd-v" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value } as Condition)} /></Field>}
      {condition.kind === 'language_is' && <Field id="cd-l" label="Language"><NativeSelect id="cd-l" value={c.language} onChange={(e) => onChange({ kind: 'language_is', language: e.target.value as 'en' | 'kn' })}><option value="en">English</option><option value="kn">Kannada</option></NativeSelect></Field>}
      <p className="text-xs text-muted-foreground">Add steps under <strong>Yes</strong> and <strong>No</strong> on the canvas. Both continue with the steps after the If/else.</p>
    </>
  );
}

function TestRunDialog({ open, onOpenChange, workflowId, needsText }: { open: boolean; onOpenChange: (o: boolean) => void; workflowId: string; needsText: boolean }) {
  const b = useWorkspace();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [contact, setContact] = useState<ContactDto | null>(null);
  const [text, setText] = useState('');
  const results = useQuery({ queryKey: ['contact-search', b.id, search], queryFn: () => getPage<ContactDto[]>(`/v1/businesses/${b.id}/contacts?pageSize=6&q=${encodeURIComponent(search)}`), enabled: open && search.length >= 2 && !contact });
  const run = useMutation({
    mutationFn: () => post<{ executionId: string }>(`/v1/businesses/${b.id}/automations/${workflowId}/test`, { contactId: contact!.id, text: text || undefined }),
    onSuccess: () => { onOpenChange(false); toast.success('Test run started'); navigate(`/w/${b.id}/automation/executions?workflowId=${workflowId}`); },
    onError: (e) => handleFormError(e),
  });
  const hint = useMemo(() => 'Runs the live (published) version now for one contact. Real actions happen: messages are sent (on mock connections nothing leaves the app).', []);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Test run" description={hint}
      footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button loading={run.isPending} disabled={!contact} onClick={() => run.mutate()}><Play /> Run now</Button></>}>
      <div className="space-y-3">
        {contact ? (
          <div className="flex items-center justify-between rounded-md border p-2 text-sm"><span>{contact.name || 'Unnamed'} · {formatPhone(contact.phone)}</span><Button size="sm" variant="ghost" onClick={() => setContact(null)}>Change</Button></div>
        ) : (
          <Field id="tr-contact" label="Contact"><Input id="tr-contact" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or phone" />
            <ul className="mt-1 divide-y rounded-md border empty:hidden">{results.data?.data.map((c) => <li key={c.id}><button className="w-full px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => setContact(c)}>{c.name || 'Unnamed'} · {formatPhone(c.phone)}</button></li>)}</ul>
          </Field>
        )}
        {needsText && <Field id="tr-text" label="Pretend message text (for keyword conditions)"><Input id="tr-text" value={text} onChange={(e) => setText(e.target.value)} /></Field>}
      </div>
    </Dialog>
  );
}
