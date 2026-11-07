import { createContext, useContext, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Check, ChevronDown, ChevronsLeft, ChevronsRight, Languages, LogOut, Menu, Moon, Plus, Search, Shield, Sun, UserRound, X, AlertTriangle,
} from 'lucide-react';
import { can, ROLE_LABELS, type BusinessDto } from '@socialpilot/shared';
import { NAV } from '@/nav';
import { get, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import { cn, daysUntil } from '@/lib/utils';
import { Logo, LogoMark } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { Avatar, Badge, Skeleton } from '@/components/ui/misc';
import { DropdownContent, DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator, DropdownTrigger } from '@/components/ui/dropdown';
import { CommandPalette } from './CommandPalette';
import { NotificationBell } from './NotificationBell';

const WorkspaceContext = createContext<BusinessDto | null>(null);
export function useWorkspace(): BusinessDto {
  const w = useContext(WorkspaceContext);
  if (!w) throw new Error('useWorkspace outside workspace');
  return w;
}

function Sidebar({ business, collapsed, onNavigate }: { business: BusinessDto; collapsed: boolean; onNavigate?: () => void }) {
  const { t } = useI18n();
  return (
    <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pb-6">
      {NAV.map((section) => {
        const items = section.items.filter((i) => !i.permission || can(business.myRole, i.permission));
        if (!items.length) return null;
        return (
          <div key={section.label} className="mt-5 first:mt-2">
            {!collapsed && <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-sidebar-foreground/60">{t(section.label)}</p>}
            {collapsed && <div className="mx-2 mb-2 h-px bg-white/10" />}
            <ul className="space-y-0.5">
              {items.map((item) => (
                <li key={item.path}>
                  <NavLink to={`/w/${business.id}/${item.path}`} end onClick={onNavigate} title={collapsed ? t(item.label) : undefined}
                    className={({ isActive }) => cn(
                      'group flex items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors',
                      isActive ? 'bg-sidebar-active text-white' : 'text-sidebar-foreground hover:bg-white/5 hover:text-white',
                      collapsed && 'justify-center',
                    )}>
                    <item.icon className="size-4 shrink-0" />
                    {!collapsed && <span className="flex-1 truncate">{t(item.label)}</span>}
                    {!collapsed && item.phase > 5 && <span className="rounded bg-white/10 px-1.5 text-[10px] text-sidebar-foreground/80">P{item.phase}</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function AppShell() {
  const { businessId = '' } = useParams();
  const { me, signOut } = useAuth();
  const { t, lang, setLang } = useI18n();
  const { dark, toggle } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sp_sidebar') === 'collapsed');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const business = useQuery({ queryKey: ['business', businessId], queryFn: () => get<BusinessDto>(`/v1/businesses/${businessId}`), retry: false });

  useEffect(() => { localStorage.setItem('sp_sidebar', collapsed ? 'collapsed' : 'expanded'); }, [collapsed]);
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen((o) => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (business.error) {
    const err = business.error as ApiError;
    if (err.status === 423) return <SuspendedNotice reason={(err.details as { reason?: string })?.reason} />;
    return <Navigate to="/" replace />;
  }
  if (!business.data || !me) {
    return (
      <div className="flex h-full">
        <div className="hidden w-64 bg-sidebar lg:block" />
        <div className="flex-1 space-y-4 p-8"><Skeleton className="h-8 w-64" /><div className="grid gap-4 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}</div><Skeleton className="h-72" /></div>
      </div>
    );
  }
  const b = business.data;
  const trialDays = b.subscription?.status === 'trialing' ? daysUntil(b.subscription.trialEndsAt) : null;

  return (
    <WorkspaceContext.Provider value={b}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-card focus:px-3 focus:py-2">Skip to content</a>
      <div className="flex h-full">
        {/* Desktop sidebar */}
        <aside className={cn('hidden shrink-0 flex-col bg-sidebar transition-[width] duration-200 lg:flex', collapsed ? 'w-[72px]' : 'w-64')}>
          <div className={cn('flex h-16 items-center px-4', collapsed && 'justify-center px-0')}>
            <Link to={`/w/${b.id}/dashboard`} aria-label="Dashboard">{collapsed ? <LogoMark /> : <Logo light />}</Link>
          </div>
          <Sidebar business={b} collapsed={collapsed} />
          <button onClick={() => setCollapsed((c) => !c)} className="flex h-11 items-center justify-center gap-2 border-t border-white/10 text-xs text-sidebar-foreground hover:text-white" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {collapsed ? <ChevronsRight className="size-4" /> : <><ChevronsLeft className="size-4" /> Collapse</>}
          </button>
        </aside>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <div className="absolute inset-0 bg-navy/50" onClick={() => setMobileOpen(false)} />
            <aside className="relative flex h-full w-72 flex-col bg-sidebar">
              <div className="flex h-16 items-center justify-between px-4">
                <Logo light />
                <Button variant="ghost" size="icon" className="text-white hover:bg-white/10" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X /></Button>
              </div>
              <Sidebar business={b} collapsed={false} onNavigate={() => setMobileOpen(false)} />
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-16 shrink-0 items-center gap-2 border-b bg-card/80 px-3 backdrop-blur sm:px-6">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu"><Menu /></Button>

            <DropdownMenu>
              <DropdownTrigger asChild>
                <button className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-sm font-semibold text-accent-foreground">{b.name[0]}</span>
                  <span className="hidden min-w-0 sm:block">
                    <span className="block max-w-[220px] truncate text-sm font-semibold">{b.name}</span>
                    <span className="block text-xs text-muted-foreground">{ROLE_LABELS[b.myRole]}</span>
                  </span>
                  <ChevronDown className="size-4 text-muted-foreground" />
                </button>
              </DropdownTrigger>
              <DropdownContent align="start" className="w-72">
                <DropdownLabel>Workspaces</DropdownLabel>
                {me.memberships.map((m) => (
                  <DropdownItem key={m.businessId} onSelect={() => navigate(`/w/${m.businessId}/dashboard`)}>
                    <span className="flex-1 truncate">{m.businessName}</span>
                    {m.businessStatus === 'suspended' && <Badge tone="red">Suspended</Badge>}
                    {m.businessId === b.id && <Check className="!text-primary" />}
                  </DropdownItem>
                ))}
                <DropdownSeparator />
                <DropdownItem onSelect={() => navigate('/onboarding')}><Plus /> Create workspace</DropdownItem>
              </DropdownContent>
            </DropdownMenu>

            <button onClick={() => setSearchOpen(true)} className="ml-auto hidden h-9 w-64 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground hover:bg-muted md:flex">
              <Search className="size-4" /> {t('Search')}… <kbd className="ml-auto rounded border bg-card px-1.5 text-[10px]">⌘K</kbd>
            </button>
            <Button variant="ghost" size="icon" className="ml-auto md:hidden" onClick={() => setSearchOpen(true)} aria-label="Search"><Search /></Button>
            <Button variant="ghost" size="icon" onClick={() => setLang(lang === 'en' ? 'kn' : 'en')} aria-label={lang === 'en' ? 'Switch to Kannada' : 'Switch to English'} title={lang === 'en' ? 'ಕನ್ನಡ' : 'English'}>
              <Languages />
            </Button>
            <NotificationBell businessId={b.id} timezone={b.timezone} />
            <Button variant="ghost" size="icon" onClick={toggle} aria-label={dark ? 'Use light theme' : 'Use dark theme'}>{dark ? <Sun /> : <Moon />}</Button>

            <DropdownMenu>
              <DropdownTrigger asChild>
                <button className="rounded-full" aria-label="Account menu"><Avatar name={me.fullName || me.email} /></button>
              </DropdownTrigger>
              <DropdownContent>
                <div className="px-2.5 py-2">
                  <p className="text-sm font-medium">{me.fullName}</p>
                  <p className="truncate text-xs text-muted-foreground">{me.email}</p>
                </div>
                <DropdownSeparator />
                <DropdownItem onSelect={() => navigate(`/w/${b.id}/settings/account`)}><UserRound /> My account & security</DropdownItem>
                {me.isPlatformAdmin && <DropdownItem onSelect={() => navigate('/admin')}><Shield /> Super Admin console</DropdownItem>}
                <DropdownSeparator />
                <DropdownItem onSelect={async () => { await signOut(); navigate('/login'); }}><LogOut /> {t('Sign out')}</DropdownItem>
              </DropdownContent>
            </DropdownMenu>
          </header>

          {trialDays !== null && (
            <div className="flex items-center justify-center gap-2 border-b bg-accent px-4 py-2 text-center text-xs text-accent-foreground">
              <span>
                {trialDays > 0 ? `${trialDays} day${trialDays === 1 ? '' : 's'} left in your free ${b.subscription!.plan.name} trial.` : 'Your trial has ended.'}
              </span>
              {can(b.myRole, 'billing.read') && <Link to={`/w/${b.id}/settings/subscription`} className="font-semibold underline">View plans</Link>}
            </div>
          )}

          {/* The inbox is a full-bleed, full-height 3-panel layout; other pages use the padded container. */}
          <main id="main" className={cn('min-h-0 flex-1', /\/inbox(\/|$)/.test(location.pathname) ? 'overflow-hidden' : 'overflow-y-auto')}>
            {/\/inbox(\/|$)/.test(location.pathname)
              ? <Outlet />
              : <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8"><Outlet /></div>}
          </main>
        </div>
      </div>
      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} businessId={b.id} role={b.myRole} />
    </WorkspaceContext.Provider>
  );
}

function SuspendedNotice({ reason }: { reason?: string }) {
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  const others = me?.memberships.filter((m) => m.businessStatus === 'active') ?? [];
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="max-w-md rounded-lg border bg-card p-8 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-red-100 text-red-700"><AlertTriangle /></div>
        <h1 className="text-lg font-semibold">This workspace is suspended</h1>
        <p className="mt-2 text-sm text-muted-foreground">{reason ? `Reason: ${reason}. ` : ''}Contact DigiMithra support at support@digimithra.co.in to resolve this.</p>
        <div className="mt-6 flex justify-center gap-2">
          {others[0] && <Button onClick={() => navigate(`/w/${others[0]!.businessId}/dashboard`)}>Open {others[0].businessName}</Button>}
          <Button variant="outline" onClick={async () => { await signOut(); navigate('/login'); }}>Sign out</Button>
        </div>
      </div>
    </div>
  );
}
