import type { HTMLAttributes, ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn, initials } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', {
  variants: {
    tone: {
      neutral: 'bg-muted text-muted-foreground',
      blue: 'bg-accent text-accent-foreground',
      green: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
      amber: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
      red: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
      teal: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300',
    },
  },
  defaultVariants: { tone: 'neutral' },
});
export const Badge = ({ className, tone, ...p }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) => (
  <span className={cn(badgeVariants({ tone }), className)} {...p} />
);

export const Skeleton = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => (
  <div aria-hidden className={cn('animate-pulse rounded-md bg-muted', className)} {...p} />
);

export const Avatar = ({ name, className }: { name: string; className?: string }) => (
  <span aria-hidden className={cn('inline-flex size-8 shrink-0 items-center justify-center rounded-full brand-gradient text-xs font-semibold text-white', className)}>
    {initials(name)}
  </span>
);

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center">
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground [&_svg]:size-6">{icon}</div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export const Table = ({ className, ...p }: HTMLAttributes<HTMLTableElement>) => (
  <div className="w-full overflow-x-auto"><table className={cn('w-full text-sm', className)} {...p} /></div>
);
export const Th = ({ className, ...p }: HTMLAttributes<HTMLTableCellElement>) => (
  <th className={cn('border-b px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground', className)} {...p} />
);
export const Td = ({ className, ...p }: HTMLAttributes<HTMLTableCellElement>) => <td className={cn('border-b px-4 py-3 align-middle', className)} {...p} />;
