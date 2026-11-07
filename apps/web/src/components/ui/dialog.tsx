import type { ReactNode } from 'react';
import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import { Button } from './button';

export function Dialog({ open, onOpenChange, title, description, children, footer }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children?: ReactNode; footer?: ReactNode;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-navy/50 backdrop-blur-[2px]" />
        <D.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-card p-6 shadow-xl focus:outline-none">
          <div className="mb-4 pr-8">
            <D.Title className="text-lg font-semibold">{title}</D.Title>
            {description ? <D.Description className="mt-1 text-sm text-muted-foreground">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
          </div>
          {children}
          {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
          <D.Close asChild>
            <Button variant="ghost" size="icon" className="absolute right-3 top-3" aria-label="Close"><X /></Button>
          </D.Close>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, destructive, loading, onConfirm, children }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string; confirmLabel: string;
  destructive?: boolean; loading?: boolean; onConfirm: () => void; children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description}
      footer={<>
        <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant={destructive ? 'destructive' : 'default'} loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
      </>}>
      {children}
    </Dialog>
  );
}
