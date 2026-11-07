import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import { Check, Minus, ShieldCheck, KeyRound, ScrollText } from 'lucide-react';
import { BUSINESS_ROLES, PERMISSIONS, ROLE_LABELS, ROLE_PERMISSIONS, can, type AuditLogDto, type BillingDto, type CheckoutDto, type PlanDto, type SessionDto } from '@socialpilot/shared';
import { get, getPage, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { handleFormError } from '@/lib/forms';
import { formatDate, formatDateTime, formatPaise, daysUntil, cn } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Badge, EmptyState, PageHeader, Skeleton, Table, Td, Th } from '@/components/ui/misc';

const PERMISSION_LABELS: Record<string, string> = {
  'business.read': 'View workspace', 'business.update': 'Edit business profile', 'members.read': 'View team', 'members.manage': 'Manage all staff',
  'members.invite_agent': 'Invite agents', 'billing.read': 'View subscription', 'billing.manage': 'Manage billing', 'channels.manage': 'Connect channels',
  'contacts.read': 'View contacts', 'contacts.write': 'Edit & import contacts', 'contacts.export': 'Export contacts', 'campaigns.read': 'View campaigns',
  'campaigns.manage': 'Create & send campaigns', 'templates.manage': 'Manage templates', 'conversations.read_all': 'See all conversations',
  'conversations.read_assigned': 'See assigned conversations', 'conversations.reply': 'Reply to customers', 'conversations.assign': 'Assign conversations',
  'leads.update': 'Update leads', 'automation.manage': 'Manage automation', 'ai.manage': 'Configure AI', 'analytics.read': 'View analytics',
  'audit.read': 'View activity log', 'api_keys.manage': 'Manage API keys', 'privacy.manage': 'Data export & deletion',
};

export function RolesPage() {
  return (
    <>
      <PageHeader title="Roles & Permissions" description="Every request is checked on the server and again by database row-level security." />
      <Card>
        <Table>
          <thead><tr><Th>Permission</Th>{BUSINESS_ROLES.map((r) => <Th key={r} className="text-center">{ROLE_LABELS[r]}</Th>)}</tr></thead>
          <tbody>
            {PERMISSIONS.map((p) => (
              <tr key={p}>
                <Td>{PERMISSION_LABELS[p] ?? p}<span className="ml-2 hidden text-xs text-muted-foreground lg:inline">{p}</span></Td>
                {BUSINESS_ROLES.map((r) => (
                  <Td key={r} className="text-center">
                    {ROLE_PERMISSIONS[r].includes(p) ? <Check className="mx-auto size-4 text-success" aria-label="Allowed" /> : <Minus className="mx-auto size-4 text-muted-foreground/40" aria-label="Not allowed" />}
                  </Td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <p className="mt-4 text-xs text-muted-foreground">Custom roles are planned; the database already supports per-workspace role definitions.</p>
    </>
  );
}

export function SubscriptionPage() {
  const b = useWorkspace();
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => get<PlanDto[]>('/v1/plans') });
  const billing = useQuery({ queryKey: ['billing', b.id], queryFn: () => get<BillingDto>(`/v1/businesses/${b.id}/billing`) });
  const [cycle, setCycle] = useState<'monthly' | 'annual'>('monthly');
  const [mockCheckout, setMockCheckout] = useState<CheckoutDto | null>(null);
  const canManage = b.myRole === 'owner';
  const sub = billing.data?.subscription ?? b.subscription;
  const limitLabels: Record<string, string> = { contacts: 'Contacts', staff_seats: 'Team seats', workflows: 'Automation workflows', broadcasts_monthly: 'Broadcasts / month', ai_tokens_monthly: 'AI tokens / month', storage_mb: 'Storage (MB)' };
  const refresh = () => { qc.invalidateQueries({ queryKey: ['billing', b.id] }); qc.invalidateQueries({ queryKey: ['business', b.id] }); };

  const checkout = useMutation({
    mutationFn: (planCode: string) => post<CheckoutDto>(`/v1/businesses/${b.id}/billing/checkout`, { planCode, billingCycle: cycle }),
    onSuccess: (c) => {
      if (c.mode === 'live' && c.keyId) return openRazorpayCheckout(c, b.name, refresh);
      setMockCheckout(c);
      toast.success('Mock checkout created. No payment is taken in mock mode.');
    },
    onError: (e) => handleFormError(e),
  });
  const simulate = useMutation({
    mutationFn: () => post(`/v1/businesses/${b.id}/billing/mock/complete`, {}),
    onSuccess: () => { setMockCheckout(null); toast.success('Mock payment simulated'); setTimeout(refresh, 1500); },
    onError: (e) => handleFormError(e),
  });
  const cancel = useMutation({
    mutationFn: () => post(`/v1/businesses/${b.id}/billing/cancel`, {}),
    onSuccess: () => { toast.success('Cancellation scheduled for the end of the billing period'); refresh(); },
    onError: (e) => handleFormError(e),
  });
  const pendingPlan = billing.data?.pendingPlanCode;
  const isMock = billing.data?.mode === 'mock';

  return (
    <>
      <PageHeader title="Subscription" description="Your DigiMithra software plan. WhatsApp message charges from Meta are billed separately." />
      {isMock && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Mock billing mode.</strong> No real payment is taken and no Razorpay account is connected. Checkout and activation are simulated for testing.
        </div>
      )}
      {sub && (
        <Card className="mb-6">
          <CardContent className="flex flex-wrap items-center gap-4 pt-5">
            <div className="flex-1">
              <p className="text-sm text-muted-foreground">Current plan</p>
              <p className="text-xl font-semibold">{sub.plan.name} <Badge tone={sub.status === 'active' ? 'green' : sub.status === 'trialing' ? 'blue' : 'amber'} className="ml-2 align-middle">{sub.status}</Badge></p>
              {billing.data?.cancelAtPeriodEnd && <p className="mt-1 text-sm text-amber-700">Cancellation scheduled. Access continues until {formatDate(sub.currentPeriodEnd, b.timezone)}.</p>}
              {pendingPlan && <p className="mt-1 text-sm text-muted-foreground">Payment pending for the {pendingPlan} plan. It starts once Razorpay confirms the first charge.</p>}
            </div>
            {sub.status === 'trialing' && <p className="text-sm">Trial ends <strong>{formatDate(sub.trialEndsAt, b.timezone)}</strong> ({Math.max(daysUntil(sub.trialEndsAt) ?? 0, 0)} days)</p>}
            {canManage && sub.status === 'active' && !billing.data?.cancelAtPeriodEnd && (
              <Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Cancel at period end</Button>
            )}
          </CardContent>
        </Card>
      )}
      {mockCheckout && isMock && (
        <Card className="mb-6 border-dashed">
          <CardContent className="flex flex-wrap items-center gap-4 pt-5">
            <p className="flex-1 text-sm">Mock checkout for <strong>{mockCheckout.planCode}</strong> ({mockCheckout.billingCycle}) is waiting for payment.</p>
            <Button onClick={() => simulate.mutate()} disabled={simulate.isPending}>Simulate successful payment</Button>
          </CardContent>
        </Card>
      )}
      <div className="mb-4 inline-flex rounded-md border bg-card p-1 text-sm" role="radiogroup" aria-label="Billing cycle">
        {(['monthly', 'annual'] as const).map((c) => (
          <button key={c} role="radio" aria-checked={cycle === c} onClick={() => setCycle(c)} className={cn('rounded px-3 py-1.5 capitalize', cycle === c && 'bg-primary text-primary-foreground')}>{c}</button>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {plans.isLoading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-80" />)}
        {plans.data?.map((p) => {
          const current = sub?.plan.code === p.code && sub?.status === 'active';
          return (
            <Card key={p.id} className={cn(current && 'border-primary ring-2 ring-primary/20')}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">{p.name}{current && <Badge tone="blue">Current</Badge>}</CardTitle>
                <CardDescription>{p.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold">{formatPaise(cycle === 'monthly' ? p.monthlyPricePaise : p.annualPricePaise)}<span className="text-sm font-normal text-muted-foreground">/{cycle === 'monthly' ? 'month' : 'year'}</span></p>
                <p className="text-xs text-muted-foreground">+ GST as applicable · excludes Meta message charges</p>
                <ul className="mt-4 space-y-1.5 text-sm">
                  {Object.entries(p.limits).map(([k, v]) => (
                    <li key={k} className="flex justify-between"><span className="text-muted-foreground">{limitLabels[k] ?? k}</span><span className="font-medium tabular-nums">{v === 0 ? '—' : v.toLocaleString('en-IN')}</span></li>
                  ))}
                </ul>
                {current ? (
                  <Button className="mt-5 w-full" variant="outline" disabled>Current plan</Button>
                ) : (
                  <Button className="mt-5 w-full" disabled={!canManage || checkout.isPending || !!sub && PAID_STATES.includes(sub.status) && !billing.data?.cancelAtPeriodEnd}
                    title={!canManage ? 'Only the workspace owner can change billing' : undefined}
                    onClick={() => checkout.mutate(p.code)}>
                    Choose {p.name}
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">Upgrades and downgrades while a paid plan is active are handled by DigiMithra for now. Cancel first, then choose a plan once the period ends.</p>

      {billing.data && (billing.data.invoices.length > 0 || billing.data.payments.length > 0) && (
        <Card className="mt-6">
          <CardHeader><CardTitle>Invoices and payments</CardTitle></CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {billing.data.invoices.map((i) => (
                <li key={i.number} className="flex justify-between py-2"><span>{i.number} · {formatDate(i.createdAt, b.timezone)}</span><span className="tabular-nums">{formatPaise(i.totalPaise)} · {i.status}</span></li>
              ))}
              {billing.data.payments.filter((p) => p.status !== 'captured').map((p) => (
                <li key={p.createdAt} className="flex justify-between py-2 text-red-700"><span>Failed payment · {formatDate(p.createdAt, b.timezone)}</span><span>{p.failureReason ?? 'failed'}</span></li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}

const PAID_STATES = ['active', 'past_due'];

/** Loads Razorpay Checkout (checkout.razorpay.com) and opens it for a subscription. Only the public key id is used in the browser. */
function openRazorpayCheckout(c: CheckoutDto, businessName: string, done: () => void) {
  type RzpCtor = new (opts: Record<string, unknown>) => { open(): void };
  const run = () => {
    const Rzp = (window as unknown as { Razorpay?: RzpCtor }).Razorpay;
    if (!Rzp) return toast.error('Could not open Razorpay Checkout');
    new Rzp({
      key: c.keyId, subscription_id: c.subscriptionId, name: 'DigiMithra', description: `${businessName}: ${c.planCode} (${c.billingCycle})`,
      handler: () => { toast.success('Payment received. Your plan updates once Razorpay confirms it.'); setTimeout(done, 1500); },
    }).open();
  };
  if ((window as unknown as { Razorpay?: unknown }).Razorpay) return run();
  const script = document.createElement('script');
  script.src = 'https://checkout.razorpay.com/v1/checkout.js';
  script.onload = run;
  script.onerror = () => toast.error('Could not load Razorpay Checkout. Check your connection and try again.');
  document.body.appendChild(script);
}

export function ActivityPage() {
  const b = useWorkspace();
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['audit', b.id, page], queryFn: () => getPage<AuditLogDto[]>(`/v1/businesses/${b.id}/audit-logs?page=${page}&pageSize=20`) });
  const total = q.data?.meta.total ?? 0;
  return (
    <>
      <PageHeader title="Activity Log" description="An append-only record of important actions in this workspace." />
      <Card>
        {q.isLoading ? <CardContent className="pt-5"><Skeleton className="h-48" /></CardContent> : q.data?.data.length === 0 ? (
          <CardContent className="pt-5"><EmptyState icon={<ScrollText />} title="No activity yet" description="Actions like invitations and profile changes appear here." /></CardContent>
        ) : (
          <Table>
            <thead><tr><Th>When</Th><Th>Action</Th><Th>By</Th><Th className="hidden md:table-cell">Details</Th></tr></thead>
            <tbody>
              {q.data?.data.map((a) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap text-muted-foreground">{formatDateTime(a.createdAt, b.timezone)}</Td>
                  <Td><code className="rounded bg-muted px-1.5 py-0.5 text-xs">{a.action}</code></Td>
                  <Td>{a.actorEmail ?? <span className="text-muted-foreground">{a.actorType}</span>}</Td>
                  <Td className="hidden max-w-sm truncate text-xs text-muted-foreground md:table-cell">{Object.keys(a.metadata).length ? JSON.stringify(a.metadata) : '—'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {total > 20 && (
          <div className="flex items-center justify-between border-t px-5 py-3 text-sm">
            <span className="text-muted-foreground">Page {page} of {Math.ceil(total / 20)}</span>
            <div className="flex gap-2"><Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</Button><Button variant="outline" size="sm" disabled={page * 20 >= total} onClick={() => setPage((p) => p + 1)}>Next</Button></div>
          </div>
        )}
      </Card>
    </>
  );
}

export function AccountPage() {
  const { me, refetchMe } = useAuth();
  const { setLang } = useI18n();
  const form = useForm<{ fullName: string; preferredLanguage: 'en' | 'kn' }>({ values: { fullName: me?.fullName ?? '', preferredLanguage: me?.preferredLanguage ?? 'en' } });
  const save = form.handleSubmit(async (v) => {
    try { await patch('/v1/me', v); setLang(v.preferredLanguage); await refetchMe(); toast.success('Profile saved'); } catch (e) { handleFormError(e, form.setError); }
  });
  return (
    <>
      <PageHeader title="My account & security" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Profile</CardTitle><CardDescription>{me?.email}</CardDescription></CardHeader>
          <CardContent>
            <form onSubmit={save} className="space-y-4">
              <Field id="fullName" label="Full name"><Input id="fullName" {...form.register('fullName', { required: true, minLength: 2 })} /></Field>
              <Field id="preferredLanguage" label="Interface language">
                <NativeSelect id="preferredLanguage" {...form.register('preferredLanguage')}><option value="en">English</option><option value="kn">ಕನ್ನಡ (Kannada)</option></NativeSelect>
              </Field>
              <Button type="submit" loading={form.formState.isSubmitting}>Save</Button>
            </form>
          </CardContent>
        </Card>
        <MfaCard />
      </div>
    </>
  );
}

export function MfaCard({ onVerified }: { onVerified?: () => void }) {
  const { signIn } = useAuth();
  const qc = useQueryClient();
  const factors = useQuery({ queryKey: ['mfa-factors'], queryFn: () => get<Array<{ id: string; verified: boolean }>>('/v1/auth/mfa/factors') });
  const [enrollment, setEnrollment] = useState<{ factorId: string; secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const verified = factors.data?.find((f) => f.verified);

  const start = async () => {
    setBusy(true);
    try { setEnrollment(await post('/v1/auth/mfa/enroll')); } catch (e) { handleFormError(e); } finally { setBusy(false); }
  };
  const verify = async (factorId: string) => {
    setBusy(true);
    try {
      const s = await post<SessionDto>('/v1/auth/mfa/verify', { factorId, code });
      signIn(s);
      setEnrollment(null); setCode('');
      await qc.invalidateQueries({ queryKey: ['mfa-factors'] });
      toast.success('Two-factor authentication verified');
      onVerified?.();
    } catch (e) { handleFormError(e); } finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5 text-primary" /> Two-factor authentication</CardTitle>
        <CardDescription>Use an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…). Required for DigiMithra Super Admins.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {factors.isLoading ? <Skeleton className="h-10" /> : verified && !enrollment ? (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm"><Badge tone="green">Enabled</Badge> Your account is protected with an authenticator app.</p>
            <div className="flex gap-2">
              <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} aria-label="Authenticator code" />
              <Button onClick={() => verify(verified.id)} loading={busy} disabled={code.length !== 6}>Verify session</Button>
            </div>
            <p className="text-xs text-muted-foreground">Enter a code to upgrade this session (needed to open the Super Admin console).</p>
          </div>
        ) : enrollment ? (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-3 rounded-lg border bg-white p-4 sm:flex-row sm:items-start">
              <QRCodeSVG value={enrollment.otpauthUrl} size={144} aria-label="Authenticator QR code" />
              <div className="text-sm text-slate-700">
                <p className="font-medium text-slate-900">Scan with your authenticator app</p>
                <p className="mt-1">Or enter this key manually:</p>
                <code className="mt-1 block break-all rounded bg-slate-100 px-2 py-1 text-xs">{enrollment.secret}</code>
              </div>
            </div>
            <div className="flex gap-2">
              <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} aria-label="Authenticator code" />
              <Button onClick={() => verify(enrollment.factorId)} loading={busy} disabled={code.length !== 6}>Verify & enable</Button>
            </div>
          </div>
        ) : (
          <Button onClick={start} loading={busy}><KeyRound /> Set up authenticator</Button>
        )}
      </CardContent>
    </Card>
  );
}

export function useCan() {
  const b = useWorkspace();
  return (p: Parameters<typeof can>[1]) => can(b.myRole, p);
}
