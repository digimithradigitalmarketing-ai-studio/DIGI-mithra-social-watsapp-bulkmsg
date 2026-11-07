import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Copy, FlaskConical, MessageCircle, Plug, ShieldCheck, Unplug, AlertTriangle } from 'lucide-react';
import { can, type ChannelDto } from '@socialpilot/shared';
import { api, del, post } from '@/lib/api';
import { handleFormError } from '@/lib/forms';
import { formatDateTime, cn } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Badge, EmptyState, PageHeader, Skeleton } from '@/components/ui/misc';

export function useChannel(businessId: string) {
  return useQuery({
    queryKey: ['channel', businessId],
    queryFn: () => api<{ data: ChannelDto | null; meta: { mockAllowed: boolean } }>(`/v1/businesses/${businessId}/channels/whatsapp`),
  });
}

export default function Connection() {
  const b = useWorkspace();
  const qc = useQueryClient();
  const q = useChannel(b.id);
  const [mode, setMode] = useState<'meta' | 'mock'>('meta');
  const [form, setForm] = useState({ wabaId: '', phoneNumberId: '', accessToken: '', displayPhoneNumber: '' });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const canManage = can(b.myRole, 'channels.manage');
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['channel', b.id] }), qc.invalidateQueries({ queryKey: ['dashboard', b.id] })]);

  const connect = useMutation({
    mutationFn: () => post<ChannelDto>(`/v1/businesses/${b.id}/channels/whatsapp`,
      mode === 'mock' ? { mode, displayPhoneNumber: form.displayPhoneNumber || undefined } : { mode, wabaId: form.wabaId, phoneNumberId: form.phoneNumberId, accessToken: form.accessToken }),
    onSuccess: async () => { setForm({ wabaId: '', phoneNumberId: '', accessToken: '', displayPhoneNumber: '' }); setFieldErrors({}); await refresh(); toast.success('WhatsApp connected'); },
    onError: (e: unknown) => { const f = (e as { fields?: Record<string, string> }).fields; if (f && Object.keys(f).length) setFieldErrors(f); else handleFormError(e); },
  });
  const disconnect = useMutation({
    mutationFn: () => del(`/v1/businesses/${b.id}/channels/whatsapp`),
    onSuccess: async () => { setConfirmDisconnect(false); await refresh(); toast.success('Disconnected'); },
    onError: (e) => { setConfirmDisconnect(false); handleFormError(e); },
  });

  if (q.isLoading) return <Skeleton className="h-64" />;
  const ch = q.data?.data;
  const mockAllowed = q.data?.meta.mockAllowed;

  return (
    <>
      <PageHeader title="WhatsApp Connection" description="Connect your WhatsApp Business Account through Meta's official WhatsApp Cloud API." />
      {ch ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader className="flex-row items-start justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <MessageCircle className="size-5 text-success" /> {ch.name}
                </CardTitle>
                <CardDescription>Connected {formatDateTime(ch.connectedAt, b.timezone)}</CardDescription>
              </div>
              <div className="flex gap-2">
                {ch.mode === 'mock' && <Badge tone="amber"><FlaskConical className="size-3" /> Mock / test mode</Badge>}
                <Badge tone={ch.status === 'connected' ? 'green' : 'red'}>{ch.status}</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {ch.mode === 'mock' && (
                <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  This is a simulated connection for testing. No real WhatsApp messages are sent, and delivery receipts are simulated.
                  Test numbers ending in <code>0000</code> fail permanently, <code>9999</code> hit rate limits until retries run out, <code>5050</code> fail after sending, and <code>1050</code> simulate a customer who blocked marketing.
                </p>
              )}
              {ch.status === 'error' && ch.lastError && (
                <p className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {ch.lastError}. Reconnect with a fresh access token.
                </p>
              )}
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div><dt className="text-muted-foreground">WhatsApp Business Account ID</dt><dd className="font-mono">{ch.wabaId}</dd></div>
                <div><dt className="text-muted-foreground">Access token</dt><dd>{ch.tokenLastFour ? <span className="font-mono">••••{ch.tokenLastFour}</span> : ch.mode === 'mock' ? 'Not needed (mock)' : '—'}</dd></div>
              </dl>
              <div>
                <h3 className="mb-2 text-sm font-semibold">Phone numbers</h3>
                <ul className="divide-y rounded-md border">
                  {ch.phoneNumbers.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                      <span className="font-medium">{p.displayPhoneNumber}</span>
                      <span className="text-muted-foreground">{p.verifiedName}</span>
                      <span className="ml-auto flex gap-2">
                        {p.qualityRating && <Badge tone={p.qualityRating === 'GREEN' ? 'green' : p.qualityRating === 'YELLOW' ? 'amber' : 'red'}>Quality {p.qualityRating.toLowerCase()}</Badge>}
                        {p.messagingLimitTier && <Badge tone="blue">{p.messagingLimitTier.replace('TIER_', '')} / 24h</Badge>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              {canManage && (
                <Button variant="outline" onClick={() => setConfirmDisconnect(true)}><Unplug /> Disconnect</Button>
              )}
            </CardContent>
          </Card>
          {ch.mode === 'meta' && <WebhookCard ch={ch} />}
        </div>
      ) : !canManage ? (
        <EmptyState icon={<Plug />} title="WhatsApp is not connected" description="Ask the business owner to connect the WhatsApp Business number." />
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Connect a number</CardTitle>
              <div className="mt-2 inline-flex w-fit rounded-md border bg-background p-1 text-sm" role="radiogroup" aria-label="Connection type">
                <button role="radio" aria-checked={mode === 'meta'} onClick={() => setMode('meta')} className={cn('rounded px-3 py-1.5', mode === 'meta' && 'bg-primary text-primary-foreground')}>Meta Cloud API</button>
                {mockAllowed && <button role="radio" aria-checked={mode === 'mock'} onClick={() => setMode('mock')} className={cn('rounded px-3 py-1.5', mode === 'mock' && 'bg-primary text-primary-foreground')}>Mock (testing)</button>}
              </div>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); connect.mutate(); }} noValidate>
                {mode === 'meta' ? (
                  <>
                    <Field id="wabaId" label="WhatsApp Business Account ID" error={fieldErrors.wabaId} hint="Meta Business Suite → WhatsApp Accounts, or the API Setup page of your Meta app.">
                      <Input id="wabaId" inputMode="numeric" value={form.wabaId} onChange={(e) => setForm({ ...form, wabaId: e.target.value })} />
                    </Field>
                    <Field id="phoneNumberId" label="Phone number ID" error={fieldErrors.phoneNumberId} hint="Not the phone number itself — the numeric ID shown next to it on the API Setup page.">
                      <Input id="phoneNumberId" inputMode="numeric" value={form.phoneNumberId} onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })} />
                    </Field>
                    <Field id="accessToken" label="Permanent access token (system user)" error={fieldErrors.accessToken} hint="Create a system user in Business Settings with whatsapp_business_messaging and whatsapp_business_management. Stored encrypted; never shown again.">
                      <Input id="accessToken" type="password" autoComplete="off" value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} />
                    </Field>
                  </>
                ) : (
                  <Field id="displayPhoneNumber" label="Display number (optional)" hint="Shown in the UI only. Nothing is sent to WhatsApp.">
                    <Input id="displayPhoneNumber" type="tel" placeholder={b.phone ?? '+91 98765 43210'} value={form.displayPhoneNumber} onChange={(e) => setForm({ ...form, displayPhoneNumber: e.target.value })} />
                  </Field>
                )}
                <Button type="submit" variant="brand" loading={connect.isPending}><Plug /> {mode === 'mock' ? 'Create mock connection' : 'Verify & connect'}</Button>
              </form>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5 text-primary" /> Before you connect</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> Verified Meta Business Portfolio</p>
              <p className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> A Meta app with the WhatsApp product</p>
              <p className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> A registered phone number on the WhatsApp Business Account</p>
              <p className="pt-2">We use only Meta's official Cloud API. Self-serve onboarding (Embedded Signup) will be added once DigiMithra's Tech Provider review is approved.</p>
            </CardContent>
          </Card>
        </div>
      )}
      <ConfirmDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect} destructive title="Disconnect WhatsApp?" confirmLabel="Disconnect"
        description="Sending stops immediately and the stored access token is deleted. Contacts, templates and history are kept." loading={disconnect.isPending} onConfirm={() => disconnect.mutate()} />
    </>
  );
}

function WebhookCard({ ch }: { ch: ChannelDto }) {
  const copy = (v: string) => { void navigator.clipboard.writeText(v); toast.success('Copied'); };
  return (
    <Card>
      <CardHeader><CardTitle>Webhook setup</CardTitle><CardDescription>In your Meta app → WhatsApp → Configuration</CardDescription></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <p className="text-muted-foreground">Callback URL</p>
          <div className="mt-1 flex gap-2"><Input readOnly value={ch.webhook.callbackUrl} aria-label="Callback URL" /><Button variant="outline" size="icon" onClick={() => copy(ch.webhook.callbackUrl)} aria-label="Copy callback URL"><Copy /></Button></div>
        </div>
        <p>Verify token: {ch.webhook.verifyTokenConfigured ? <Badge tone="green">configured on server</Badge> : <Badge tone="red">not configured</Badge>}</p>
        <p>App secret (signature check): {ch.webhook.appSecretConfigured ? <Badge tone="green">configured</Badge> : <Badge tone="red">not configured</Badge>}</p>
        <p className="text-muted-foreground">Subscribe to the <code>messages</code> and <code>message_template_status_update</code> fields.</p>
      </CardContent>
    </Card>
  );
}
