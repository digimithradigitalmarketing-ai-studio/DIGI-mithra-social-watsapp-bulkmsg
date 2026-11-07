import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type LabelHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const fieldBase =
  'flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm placeholder:text-muted-foreground/70 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60 aria-[invalid=true]:border-destructive';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(fieldBase, className)} {...props} />
));
Input.displayName = 'Input';

export const NativeSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn(fieldBase, 'pr-8', className)} {...props}>{children}</select>
));
NativeSelect.displayName = 'NativeSelect';

export const Label = ({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) => (
  <label className={cn('text-sm font-medium leading-none', className)} {...props} />
);

/** Label + control + hint/error, wired for screen readers. */
export function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
