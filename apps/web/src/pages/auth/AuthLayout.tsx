import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { CheckCircle2 } from 'lucide-react';
import { Logo } from '@/components/Logo';

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden overflow-hidden bg-sidebar p-12 text-white lg:flex lg:flex-col">
        <div className="pointer-events-none absolute -right-32 -top-32 size-[28rem] rounded-full brand-gradient opacity-25 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 -left-24 size-[26rem] rounded-full bg-teal opacity-15 blur-3xl" />
        <Logo light />
        <div className="relative mt-auto max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">Every customer conversation, <span className="brand-text">one cockpit.</span></h2>
          <p className="mt-4 text-sidebar-foreground">WhatsApp broadcasts, a shared team inbox, CRM and automation — built for Indian businesses, on the official WhatsApp Business Platform.</p>
          <ul className="mt-8 space-y-3 text-sm text-sidebar-foreground">
            {['Consent-first campaigns with STOP handling', 'Workspace data isolated per business', 'English and ಕನ್ನಡ support'].map((f) => (
              <li key={f} className="flex items-center gap-2"><CheckCircle2 className="size-4 text-teal" /> {f}</li>
            ))}
          </ul>
        </div>
        <p className="relative mt-12 text-xs text-sidebar-foreground/60">© {new Date().getFullYear()} DigiMithra · digimithra.co.in</p>
      </section>
      <section className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 lg:hidden"><Logo /></div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div>}
          <p className="mt-10 text-center text-xs text-muted-foreground">
            <Link to="/legal/terms" className="hover:underline">Terms</Link> · <Link to="/legal/privacy" className="hover:underline">Privacy</Link>
          </p>
        </div>
      </section>
    </div>
  );
}
