import { DropdownMenu as M } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const DropdownMenu = M.Root;
export const DropdownTrigger = M.Trigger;
export function DropdownContent({ children, align = 'end', className }: { children: ReactNode; align?: 'start' | 'end'; className?: string }) {
  return (
    <M.Portal>
      <M.Content align={align} sideOffset={6} className={cn('z-50 min-w-52 rounded-lg border bg-card p-1 shadow-lg', className)}>{children}</M.Content>
    </M.Portal>
  );
}
export function DropdownItem({ children, onSelect, className }: { children: ReactNode; onSelect?: () => void; className?: string }) {
  return (
    <M.Item onSelect={onSelect} className={cn('flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-muted [&_svg]:size-4 [&_svg]:text-muted-foreground', className)}>
      {children}
    </M.Item>
  );
}
export const DropdownLabel = ({ children }: { children: ReactNode }) => <M.Label className="px-2.5 py-1.5 text-xs font-medium text-muted-foreground">{children}</M.Label>;
export const DropdownSeparator = () => <M.Separator className="my-1 h-px bg-border" />;
