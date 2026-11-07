import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, FileText, Paperclip, Send, Smile, Sparkles, StickyNote } from 'lucide-react';
import type { AiAnswerDto, CannedReplyDto, ConversationDto, TemplateDto } from '@socialpilot/shared';
import { get, post } from '@/lib/api';
import { handleFormError } from '@/lib/forms';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';

/** Common emoji as plain Unicode characters (no artwork). */
const EMOJI = ['😀', '😊', '👍', '🙏', '🔥', '💪', '🎉', '❤️', '😅', '🙌', '✅', '📅', '🏋️', '🥗', '⏰', '💰'];

/**
 * Reply composer. Free-form replies are only offered inside the 24-hour customer-service window;
 * outside it the composer switches to approved templates and says why.
 */
export function MessageComposer({ conversation: c, onSent, seed }: { conversation: ConversationDto; onSent: () => Promise<unknown>; seed?: { text: string; nonce: number } | null }) {
  const b = useWorkspace();
  const [mode, setMode] = useState<'reply' | 'template' | 'note'>(c.windowOpen ? 'reply' : 'template');
  const [text, setText] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const canned = useQuery({ queryKey: ['canned', b.id], queryFn: () => get<CannedReplyDto[]>(`/v1/businesses/${b.id}/canned-replies`) });
  const templates = useQuery({ queryKey: ['templates', b.id], queryFn: () => get<TemplateDto[]>(`/v1/businesses/${b.id}/templates`), enabled: mode === 'template' });
  const approved = templates.data?.filter((t) => t.status === 'APPROVED') ?? [];
  const template = approved.find((t) => t.id === templateId);

  useEffect(() => {
    if (!c.windowOpen && mode === 'reply') setMode('template');
    if (c.windowOpen && mode === 'template' && !templateId) setMode('reply'); // the customer just wrote back
  }, [c.windowOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Retry of a failed text message: pre-fill the reply box with the same text.
  useEffect(() => {
    if (seed && c.windowOpen) { setMode('reply'); setText(seed.text); }
  }, [seed?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const slash = mode === 'reply' && text.startsWith('/') && !text.includes(' ') ? text.slice(1).toLowerCase() : null;
  const suggestions = useMemo(() => (slash === null ? [] : (canned.data ?? []).filter((x) => x.shortcut.startsWith(slash) || x.title.toLowerCase().includes(slash)).slice(0, 6)), [slash, canned.data]);

  const [suggesting, setSuggesting] = useState(false);
  const suggest = async () => {
    setSuggesting(true);
    try {
      const r = await post<AiAnswerDto>(`/v1/businesses/${b.id}/conversations/${c.id}/ai-suggest`);
      if (r.answer) { setMode('reply'); setText(r.answer); toast.success(`Suggestion ready (${Math.round(r.confidence * 100)}% confidence). Review before sending.`); }
      else toast.info(`No suggestion: ${r.handoffReason ?? r.outcome}`);
    } catch (e) { handleFormError(e); } finally { setSuggesting(false); }
  };

  const send = useMutation({
    mutationFn: async () => {
      if (mode === 'note') return post(`/v1/businesses/${b.id}/conversations/${c.id}/notes`, { body: text });
      if (mode === 'reply') return post(`/v1/businesses/${b.id}/conversations/${c.id}/messages`, { type: 'text', body: text, clientId: crypto.randomUUID() });
      return post(`/v1/businesses/${b.id}/conversations/${c.id}/messages`, { type: 'template', templateId, variables: vars, clientId: crypto.randomUUID() });
    },
    onSuccess: async () => {
      if (mode === 'template') { setTemplateId(''); setVars({}); }
      setText('');
      await onSent();
    },
    onError: (e) => handleFormError(e),
  });
  const busyNow = busy || send.isPending;
  const ready = mode === 'template' ? !!templateId : text.trim().length > 0;
  const submit = () => { if (ready && !busyNow) void send.mutateAsync().catch(() => undefined); };

  return (
    <div className="border-t border-wa-border bg-wa-header p-2 sm:p-3">
      <div className="mb-2 flex flex-wrap items-center gap-1 text-sm" role="tablist" aria-label="Composer mode">
        {(['reply', 'template', 'note'] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} disabled={m === 'reply' && !c.windowOpen} onClick={() => setMode(m)}
            className={cn('rounded-md px-2.5 py-1 disabled:opacity-40', mode === m ? (m === 'note' ? 'bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100' : 'bg-wa-selected text-wa-text') : 'text-wa-text-muted hover:bg-wa-hover')}>
            {m === 'reply' ? 'Reply' : m === 'template' ? 'Template' : 'Internal note'}
          </button>
        ))}
        {c.windowOpen && (
          <Button type="button" size="sm" variant="ghost" className="ml-auto h-7" loading={suggesting} onClick={suggest} title="Draft a reply from your AI knowledge base">
            <Sparkles /> <span className="hidden sm:inline">Suggest reply</span>
          </Button>
        )}
      </div>
      {!c.windowOpen && mode !== 'note' && (
        <p className="mb-2 flex items-start gap-2 rounded-md bg-wa-sidebar p-2 text-xs text-wa-text-muted">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          More than 24 hours since the customer's last message. WhatsApp only allows approved templates until they reply.
        </p>
      )}
      {mode === 'template' ? (
        <div className="space-y-2">
          <NativeSelect value={templateId} onChange={(e) => { setTemplateId(e.target.value); setVars({}); }} aria-label="Template">
            <option value="">Choose an approved template…</option>
            {approved.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.category.toLowerCase()})</option>)}
          </NativeSelect>
          {template && (
            <>
              <p className="rounded-md bg-wa-sidebar p-2 text-xs text-wa-text-muted">{template.body}</p>
              <p className="text-[11px] text-wa-text-muted">Values are filled from the contact automatically; type to override or fill in missing ones.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {template.variables.filter((v) => v !== 'business_name').map((v) => (
                  <Input key={v} className="h-9 text-xs" placeholder={`{{${v}}}`} aria-label={v} value={vars[v] ?? ''} onChange={(e) => setVars({ ...vars, [v]: e.target.value })} />
                ))}
              </div>
            </>
          )}
          <div className="flex justify-end"><Button onClick={submit} loading={busyNow} disabled={!ready}><FileText /> Send template</Button></div>
        </div>
      ) : (
        <div className="relative">
          {suggestions.length > 0 && (
            <ul className="absolute bottom-full mb-1 w-full overflow-hidden rounded-md border border-wa-border bg-wa-sidebar shadow-lg" role="listbox" aria-label="Canned replies">
              {suggestions.map((s) => (
                <li key={s.id}><button className="w-full px-3 py-2 text-left text-sm text-wa-text hover:bg-wa-hover" onClick={() => setText(s.body)}>
                  <span className="font-mono text-xs text-wa-accent">/{s.shortcut}</span> <span className="font-medium">{s.title}</span>
                  <span className="block truncate text-xs text-wa-text-muted">{s.body}</span></button></li>
              ))}
            </ul>
          )}
          {emojiOpen && (
            <div className="mb-2 grid grid-cols-8 gap-1 rounded-md border border-wa-border bg-wa-sidebar p-2 sm:grid-cols-16" role="group" aria-label="Emoji">
              {EMOJI.map((e) => (
                <button key={e} type="button" className="flex size-9 items-center justify-center rounded text-lg hover:bg-wa-hover" aria-label={`Insert ${e}`}
                  onClick={() => setText((t) => t + e)}>{e}</button>
              ))}
            </div>
          )}
          <div className="flex items-end gap-1.5">
            <Button type="button" variant="ghost" size="icon" className="shrink-0 text-wa-text-muted" aria-label="Emoji" aria-pressed={emojiOpen} onClick={() => setEmojiOpen((x) => !x)}><Smile /></Button>
            <Button type="button" variant="ghost" size="icon" className="shrink-0 text-wa-text-muted" disabled aria-label="Attach file (not available yet)" title="Sending media is not available yet"><Paperclip /></Button>
            <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} maxLength={4096}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
              aria-label={mode === 'note' ? 'Internal note' : 'Reply'}
              placeholder={mode === 'note' ? 'Only your team sees notes…' : 'Type a message. "/" for quick replies'}
              className={cn('max-h-40 min-h-10 flex-1 resize-y rounded-lg border border-wa-border px-3 py-2 text-sm text-wa-text placeholder:text-wa-text-muted focus-visible:outline-2 focus-visible:outline-ring',
                mode === 'note' ? 'bg-amber-50 dark:bg-amber-950' : 'bg-wa-sidebar')} />
            <Button onClick={submit} loading={busyNow} disabled={!ready} aria-label={mode === 'note' ? 'Add note' : 'Send'} className="size-10 shrink-0 rounded-full bg-wa-accent p-0 text-white hover:bg-wa-accent/90">
              {mode === 'note' ? <StickyNote /> : <Send />}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
