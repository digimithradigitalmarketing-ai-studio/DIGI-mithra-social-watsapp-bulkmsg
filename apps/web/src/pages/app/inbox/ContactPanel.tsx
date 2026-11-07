import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ExternalLink, MessageCircle, Plus, Send, UserRound } from 'lucide-react';
import { can, type ConversationDetailDto, type LeadDto, type PipelineDto, type TaskDto } from '@socialpilot/shared';
import { api, get, post } from '@/lib/api';
import { handleFormError } from '@/lib/forms';
import { cn, formatDateTime } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, Badge } from '@/components/ui/misc';
import { ConsentBadge, TagPill, formatPhone } from '../contacts/shared';
import { useChannel } from '../whatsapp/Connection';

export function ContactPanel({ detail, onChanged }: { detail: ConversationDetailDto; onChanged: () => Promise<unknown> }) {
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
    <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-wa-border bg-wa-sidebar xl:block" aria-label="Customer details">
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
