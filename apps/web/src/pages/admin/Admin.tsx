import { useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { AlertTriangle, ArrowLeft, Building2, CreditCard, IndianRupee, LifeBuoy, LogOut, MessageCircle, Search, ShieldAlert, Users, Webhook } from 'lucide-react';
import type { AdminBusinessDto, AdminOverviewDto, AuditLogDto, PlanDto } from '@socialpilot/shared';
import { ApiError, get, getPage, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { handleFormError } from '@/lib/forms';
import { cn, formatDate, formatDateTime, formatNumber, formatPaise } from '@/lib/utils';
import { LogoMark } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Badge, PageHeader, Skeleton, Table, Td, Th } from '@/components/ui/misc';
import { MfaCard } from '../app/settings/Other';

const tabs = [
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/businesses', label: 'Businesses' },
  { to: '/admin/plans', label: 'Plans & pricing' },
  { to: '/admin/settings', label: 'System settings' },
  { to: '/admin/queue', label: 'Queue & webhooks' },
  { to: '/admin/audit', label: 'Audit log' },
];

export function AdminShell() {
  const { me, signOut, status } = useAuth();
  const navigate = useNavigate();
  // Probe access: 404 => not an admin; 403 mfa_required => step-up needed.
  const probe = useQuery({ queryKey: ['admin-overview'], queryFn: () => get<AdminOverviewDto>('/v1/admin/overview'), retry: false, enabled: status === 'authenticated' });
  if (me && !me.isPlatformAdmin) return <Navigate to="/" replace />;
  const err = probe.error as ApiError | null;

  return (
    <div className="min-h-full">
      <header className="border-b bg-sidebar text-white">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <LogoMark className="size-7" />
          <span className="font-semibold">Social Pilot</span>
          <Badge className="bg-red-500/20 text-red-200"><ShieldAlert className="size-3" /> Super Admin</Badge>
          <div className="ml-auto flex items-center gap-1">
            {me?.memberships[0] && <Button asChild variant="ghost" size="sm" className="text-sidebar-foreground hover:bg-white/10 hover:text-white"><Link to={`/w/${me.memberships[0].businessId}/dashboard`}><ArrowLeft /> Back to app</Link></Button>}
            <Button variant="ghost" size="sm" className="text-sidebar-foreground hover:bg-white/10 hover:text-white" onClick={async () => { await signOut(); navigate('/login'); }}><LogOut /> Sign out</Button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 sm:px-6" aria-label="Admin">
          {tabs.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => cn('whitespace-nowrap border-b-2 px-3 py-2.5 text-sm', isActive ? 'border-teal text-white' : 'border-transparent text-sidebar-foreground hover:text-white')}>{t.label}</NavLink>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        {err?.code === 'mfa_required' ? (
          <div className="mx-auto max-w-lg">
            <PageHeader title="Verify it's you" description="Super Admin access requires two-factor authentication for this session." />
            <MfaCard onVerified={() => probe.refetch()} />
          </div>
        ) : probe.isLoading || !me ? <Skeleton className="h-64" /> : err ? <p className="text-destructive">{err.message}</p> : <Outlet />}
      </main>
    </div>
  );
}

function Kpi({ label, value, icon: Icon, sub }: { label: string; value: string; icon: typeof Users; sub?: string }) {
  return (
    <Card><CardContent className="pt-5">
      <div className="flex items-center justify-between"><p className="text-sm text-muted-foreground">{label}</p><Icon className="size-4 text-muted-foreground" /></div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </CardContent></Card>
  );
}

const tooltipStyle = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 };

export function AdminOverview() {
  const q = useQuery({ queryKey: ['admin-overview'], queryFn: () => get<AdminOverviewDto>('/v1/admin/overview') });
  const d = q.data;
  if (!d) return <Skeleton className="h-64" />;
  return (
    <>
      <PageHeader title="Platform overview" description="DigiMithra Social Pilot across all workspaces." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Monthly recurring revenue" value={formatPaise(d.mrrPaise)} icon={IndianRupee} sub="Paid subscriptions only (trials excluded)" />
        <Kpi label="Businesses" value={formatNumber(d.businesses.total)} icon={Building2} sub={`${d.businesses.active} active · ${d.businesses.suspended} suspended · +${d.businesses.newLast30d} in 30d`} />
        <Kpi label="Subscriptions" value={formatNumber(d.subscriptions.active)} icon={CreditCard} sub={`${d.subscriptions.trialing} trialing · ${d.subscriptions.pastDue} past due`} />
        <Kpi label="Users" value={formatNumber(d.users.total)} icon={Users} sub={`+${d.users.newLast30d} in 30d`} />
        <Kpi label="WhatsApp connections" value={formatNumber(d.whatsappConnections)} icon={MessageCircle} sub={`${d.campaigns.processing} campaigns sending`} />
        <Kpi label="Webhooks (24h)" value={formatNumber(d.webhooks.received24h)} icon={Webhook} sub={`${d.webhooks.failed24h} failed`} />
        <Kpi label="Failed payments (30d)" value={formatNumber(d.failedPayments30d)} icon={AlertTriangle} />
        <Kpi label="Open support tickets" value={formatNumber(d.openSupportTickets)} icon={LifeBuoy} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Subscriptions by plan</CardTitle><CardDescription>Active and trialing workspaces</CardDescription></CardHeader>
          <CardContent><div className="h-64"><ResponsiveContainer>
            <BarChart data={d.revenueByPlan} margin={{ left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="planName" tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="activeCount" name="Active" stackId="a" fill="#2f6bff" radius={[0, 0, 0, 0]} />
              <Bar dataKey="trialingCount" name="Trialing" stackId="a" fill="#14b8a6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer></div></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>New workspaces</CardTitle><CardDescription>Last 30 days</CardDescription></CardHeader>
          <CardContent><div className="h-64"><ResponsiveContainer>
            <LineChart data={d.signupsByDay} margin={{ left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="date" tickFormatter={(v: string) => v.slice(5)} tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} minTickGap={24} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} />
              <Line type="monotone" dataKey="count" name="Workspaces" stroke="#2f6bff" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer></div></CardContent>
        </Card>
      </div>
      
    </>
  );
}

export function AdminBusinesses() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<AdminBusinessDto | null>(null);
  const [reason, setReason] = useState('');
  const list = useQuery({
    queryKey: ['admin-businesses', q, status, page],
    queryFn: () => getPage<AdminBusinessDto[]>(`/v1/admin/businesses?page=${page}&pageSize=20&q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}`),
  });
  const action = useMutation({
    mutationFn: ({ b, suspend }: { b: AdminBusinessDto; suspend: boolean }) => post(`/v1/admin/businesses/${b.id}/${suspend ? 'suspend' : 'reactivate'}`, suspend ? { reason } : {}),
    onSuccess: async (_d, v) => { setTarget(null); setReason(''); await qc.invalidateQueries({ queryKey: ['admin-businesses'] }); await qc.invalidateQueries({ queryKey: ['admin-overview'] }); toast.success(v.suspend ? 'Workspace suspended' : 'Workspace reactivated'); },
    onError: (e) => handleFormError(e),
  });
  const total = list.data?.meta.total ?? 0;
  return (
    <>
      <PageHeader title="Businesses" description={`${total} workspace${total === 1 ? '' : 's'}`} />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input className="pl-9" placeholder="Search name, slug or city" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Search businesses" /></div>
        <NativeSelect className="sm:w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Filter by status">
          <option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="closed">Closed</option>
        </NativeSelect>
      </div>
      <Card>
        {list.isLoading ? <CardContent className="pt-5"><Skeleton className="h-40" /></CardContent> : (
          <Table>
            <thead><tr><Th>Business</Th><Th className="hidden md:table-cell">Owner</Th><Th>Plan</Th><Th className="hidden lg:table-cell">Team / contacts</Th><Th className="hidden lg:table-cell">Created</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>
              {list.data?.data.map((b) => (
                <tr key={b.id}>
                  <Td><p className="font-medium">{b.name}</p><p className="text-xs text-muted-foreground">{b.city ?? '—'} · {b.industry ?? '—'}</p></Td>
                  <Td className="hidden md:table-cell">{b.ownerEmail}</Td>
                  <Td>{b.planName ?? '—'}<p className="text-xs text-muted-foreground">{b.subscriptionStatus}{b.subscriptionStatus === 'trialing' && b.trialEndsAt ? ` until ${formatDate(b.trialEndsAt)}` : ''}</p></Td>
                  <Td className="hidden tabular-nums lg:table-cell">{b.memberCount} / {formatNumber(b.contactCount)}</Td>
                  <Td className="hidden text-muted-foreground lg:table-cell">{formatDate(b.createdAt)}</Td>
                  <Td><Badge tone={b.status === 'active' ? 'green' : 'red'} title={b.suspendedReason ?? undefined}>{b.status}</Badge></Td>
                  <Td className="text-right">
                    {b.status === 'active' && <Button variant="outline" size="sm" onClick={() => setTarget(b)}>Suspend</Button>}
                    {b.status === 'suspended' && <Button variant="outline" size="sm" loading={action.isPending} onClick={() => action.mutate({ b, suspend: false })}>Reactivate</Button>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {total > 20 && (
          <div className="flex justify-end gap-2 border-t px-5 py-3">
            <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page * 20 >= total} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        )}
      </Card>
      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)} title={`Suspend ${target?.name}?`}
        description="All members lose access immediately and scheduled sending stops. The reason is shown to the business and recorded in the audit log."
        footer={<><Button variant="outline" onClick={() => setTarget(null)}>Cancel</Button><Button variant="destructive" loading={action.isPending} disabled={reason.trim().length < 5} onClick={() => target && action.mutate({ b: target, suspend: true })}>Suspend workspace</Button></>}>
        <Field id="reason" label="Reason"><Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Repeated spam complaints" /></Field>
      </Dialog>
    </>
  );
}

function PlanEditor({ plan }: { plan: PlanDto }) {
  const qc = useQueryClient();
  const [monthly, setMonthly] = useState(String(plan.monthlyPricePaise / 100));
  const [annual, setAnnual] = useState(String(plan.annualPricePaise / 100));
  const [trial, setTrial] = useState(String(plan.trialDays));
  const [limits, setLimits] = useState<Record<string, string>>(Object.fromEntries(Object.entries(plan.limits).map(([k, v]) => [k, String(v)])));
  const save = useMutation({
    mutationFn: () => patch<PlanDto>(`/v1/admin/plans/${plan.id}`, {
      monthlyPricePaise: Math.round(Number(monthly) * 100), annualPricePaise: Math.round(Number(annual) * 100), trialDays: Number(trial),
      limits: Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, Number(v)])),
    }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['admin-plans'] }); toast.success(`${plan.name} plan saved`); },
    onError: (e) => handleFormError(e),
  });
  return (
    <Card>
      <CardHeader><CardTitle>{plan.name} <code className="ml-1 text-xs font-normal text-muted-foreground">{plan.code}</code></CardTitle><CardDescription>{plan.description}</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Field id={`${plan.id}-m`} label="₹ / month"><Input id={`${plan.id}-m`} type="number" min={0} value={monthly} onChange={(e) => setMonthly(e.target.value)} /></Field>
          <Field id={`${plan.id}-a`} label="₹ / year"><Input id={`${plan.id}-a`} type="number" min={0} value={annual} onChange={(e) => setAnnual(e.target.value)} /></Field>
          <Field id={`${plan.id}-t`} label="Trial days"><Input id={`${plan.id}-t`} type="number" min={0} max={90} value={trial} onChange={(e) => setTrial(e.target.value)} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {Object.keys(limits).map((k) => (
            <Field key={k} id={`${plan.id}-${k}`} label={k.replace(/_/g, ' ')}><Input id={`${plan.id}-${k}`} type="number" min={0} value={limits[k]} onChange={(e) => setLimits((l) => ({ ...l, [k]: e.target.value }))} /></Field>
          ))}
        </div>
        <Button onClick={() => save.mutate()} loading={save.isPending}>Save {plan.name}</Button>
      </CardContent>
    </Card>
  );
}

export function AdminPlans() {
  const q = useQuery({ queryKey: ['admin-plans'], queryFn: () => get<PlanDto[]>('/v1/admin/plans') });
  return (
    <>
      <PageHeader title="Plans & pricing" description="DigiMithra software subscription prices (not Meta message charges). Changes apply to new checkouts; existing workspace limits are snapshotted at creation." />
      <div className="grid gap-6 lg:grid-cols-3">{q.data?.map((p) => <PlanEditor key={p.id} plan={p} />) ?? <Skeleton className="h-96" />}</div>
    </>
  );
}

export function AdminSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-settings'], queryFn: () => get<Array<{ key: string; value: unknown; description: string; editable: boolean; updatedAt: string }>>('/v1/admin/settings') });
  const save = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) => patch(`/v1/admin/settings/${key}`, { value }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['admin-settings'] }); toast.success('Setting saved'); },
    onError: (e) => handleFormError(e),
  });
  return (
    <>
      <PageHeader title="System settings" description="Platform-wide configuration. Every change is audit-logged." />
      <Card>
        <ul className="divide-y">
          {q.data?.map((s) => (
            <li key={s.key} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center">
              <div className="flex-1"><p className="font-medium"><code>{s.key}</code></p><p className="text-sm text-muted-foreground">{s.description}</p></div>
              {typeof s.value === 'boolean' ? (
                <Button variant={s.value ? 'default' : 'outline'} onClick={() => save.mutate({ key: s.key, value: !s.value })}>{s.value ? 'Enabled' : 'Disabled'}</Button>
              ) : (
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const v = new FormData(e.currentTarget).get('v') as string; save.mutate({ key: s.key, value: typeof s.value === 'number' ? Number(v) : v }); }}>
                  <Input name="v" defaultValue={String(s.value)} className="w-40" aria-label={s.key} />
                  <Button type="submit" variant="outline">Save</Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

export function AdminAudit() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['admin-audit', page, q], queryFn: () => getPage<AuditLogDto[]>(`/v1/admin/audit-logs?page=${page}&pageSize=25&q=${encodeURIComponent(q)}`) });
  const total = list.data?.meta.total ?? 0;
  return (
    <>
      <PageHeader title="Audit log" description="Append-only log across all workspaces." />
      <Input className="mb-4 max-w-sm" placeholder="Filter by action, email or business" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Filter audit log" />
      <Card>
        <Table>
          <thead><tr><Th>When (IST)</Th><Th>Action</Th><Th>Actor</Th><Th className="hidden md:table-cell">Business</Th><Th className="hidden lg:table-cell">Details</Th></tr></thead>
          <tbody>
            {list.data?.data.map((a) => (
              <tr key={a.id}>
                <Td className="whitespace-nowrap text-muted-foreground">{formatDateTime(a.createdAt)}</Td>
                <Td><code className="rounded bg-muted px-1.5 py-0.5 text-xs">{a.action}</code></Td>
                <Td>{a.actorEmail ?? <span className="text-muted-foreground">{a.actorType}</span>}</Td>
                <Td className="hidden md:table-cell">{a.businessName ?? '—'}</Td>
                <Td className="hidden max-w-xs truncate text-xs text-muted-foreground lg:table-cell">{JSON.stringify(a.metadata)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <div className="flex items-center justify-between border-t px-5 py-3 text-sm">
          <span className="text-muted-foreground">{total} entries</span>
          <div className="flex gap-2"><Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</Button><Button variant="outline" size="sm" disabled={page * 25 >= total} onClick={() => setPage((p) => p + 1)}>Next</Button></div>
        </div>
      </Card>
    </>
  );
}
