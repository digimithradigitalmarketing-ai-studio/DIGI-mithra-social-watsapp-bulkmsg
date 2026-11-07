import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CheckCircle2, Circle, Eye, MailX, Megaphone, MessageCircle, Send, Target, Users, CheckCheck, Inbox } from 'lucide-react';
import type { DashboardDto } from '@socialpilot/shared';
import { get } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { formatNumber, cn } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, PageHeader, Skeleton } from '@/components/ui/misc';

function Stat({ label, value, icon: Icon, tone = 'blue', hint }: { label: string; value: number; icon: typeof Send; tone?: 'blue' | 'teal' | 'green' | 'red' | 'navy'; hint?: string }) {
  const tones = {
    blue: 'bg-accent text-accent-foreground',
    teal: 'bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300',
    green: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
    red: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
    navy: 'bg-navy text-white dark:bg-muted',
  };
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-2 p-4 sm:p-5">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{formatNumber(value)}</p>
          {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
        </div>
        <span className={cn('hidden size-10 shrink-0 items-center justify-center rounded-lg sm:flex', tones[tone])}><Icon className="size-5" /></span>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const b = useWorkspace();
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['dashboard', b.id], queryFn: () => get<DashboardDto>(`/v1/businesses/${b.id}/dashboard`) });
  const d = q.data;
  const hour = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: b.timezone }).format(new Date()));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <PageHeader title={`${greeting} 👋`} description={`Here's what's happening at ${b.name} in the last 30 days.`} />
      {!d ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <Stat label={t('Messages sent')} value={d.messages30d.sent} icon={Send} />
            <Stat label={t('Delivered')} value={d.messages30d.delivered} icon={CheckCheck} tone="teal" />
            <Stat label={t('Read')} value={d.messages30d.read} icon={Eye} tone="green" />
            <Stat label={t('Failed')} value={d.messages30d.failed} icon={MailX} tone="red" />
            <Stat label="Contacts" value={d.totals.contacts} icon={Users} tone="navy" hint={`${formatNumber(d.totals.contactsWithMarketingConsent)} opted in to marketing`} />
            <Stat label="Active campaigns" value={d.totals.activeCampaigns} icon={Megaphone} />
            <Stat label="Open conversations" value={d.totals.openConversations} icon={Inbox} tone="teal" />
            <Stat label="Leads this month" value={d.totals.leadsThisMonth} icon={Target} tone="green" hint={`${d.totals.leadsWonThisMonth} won`} />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Message activity</CardTitle>
                <CardDescription>Outbound vs. inbound messages, last 14 days</CardDescription>
              </CardHeader>
              <CardContent>
                {d.dailyMessages.every((x) => x.inbound + x.outbound === 0) && (
                  <p className="mb-2 text-xs text-muted-foreground">No messages yet — activity appears here once you send your first campaign.</p>
                )}
                <div className="h-64" role="img" aria-label="Message activity chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={d.dailyMessages} margin={{ left: -20, right: 8, top: 8 }}>
                      <defs>
                        <linearGradient id="out" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2f6bff" stopOpacity={0.35} /><stop offset="1" stopColor="#2f6bff" stopOpacity={0} /></linearGradient>
                        <linearGradient id="in" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#14b8a6" stopOpacity={0.35} /><stop offset="1" stopColor="#14b8a6" stopOpacity={0} /></linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="date" tickFormatter={(v: string) => v.slice(8)} tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                      <Area type="monotone" dataKey="outbound" name="Outbound" stroke="#2f6bff" fill="url(#out)" strokeWidth={2} />
                      <Area type="monotone" dataKey="inbound" name="Inbound" stroke="#14b8a6" fill="url(#in)" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Getting started</CardTitle>
                <CardDescription>{d.setupChecklist.filter((s) => s.done).length} of {d.setupChecklist.length} complete</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1">
                  {d.setupChecklist.map((s) => {
                    const link = ({ profile: 'settings/profile', team: 'settings/team', whatsapp: 'whatsapp/connection', contacts: 'contacts/import', campaign: 'campaigns/new' } as Record<string, string>)[s.key] ?? null;
                    const content = (
                      <>
                        {s.done ? <CheckCircle2 className="size-5 text-success" /> : <Circle className="size-5 text-muted-foreground/50" />}
                        <span className={cn('flex-1 text-sm', s.done && 'text-muted-foreground line-through')}>{s.label}</span>
                        {s.phase > 3 && !s.done && <Badge>Phase {s.phase}</Badge>}
                      </>
                    );
                    return (
                      <li key={s.key}>
                        {link && !s.done ? (
                          <Link to={`/w/${b.id}/${link}`} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted">{content}</Link>
                        ) : (
                          <div className="flex items-center gap-3 px-2 py-2">{content}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-4 rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">
                  <MessageCircle className="mb-1 size-4 text-primary" />
                  WhatsApp: {d.channels.whatsappConnected ? `connected · ${d.channels.phoneNumbers} number(s)` : 'not connected yet'}
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
