import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('size-8', className)} aria-hidden>
      <defs><linearGradient id="spg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2f6bff" /><stop offset="1" stopColor="#14b8a6" /></linearGradient></defs>
      <rect width="64" height="64" rx="16" fill="#0b1b3f" />
      <path d="M14 40 L32 14 L50 40 L38 36 L32 50 L26 36 Z" fill="url(#spg)" />
    </svg>
  );
}

export function Logo({ className, light }: { className?: string; light?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className="leading-tight">
        <span className={cn('block text-[15px] font-semibold tracking-tight', light ? 'text-white' : 'text-foreground')}>Social Pilot</span>
        <span className={cn('block text-[11px] font-medium uppercase tracking-[0.12em]', light ? 'text-sidebar-foreground' : 'text-muted-foreground')}>by DigiMithra</span>
      </span>
    </span>
  );
}
