import type { ContactDto } from '@socialpilot/shared';
import { Badge } from '@/components/ui/misc';

export function ConsentBadge({ c }: { c: Pick<ContactDto, 'marketingOptIn' | 'optedOutAt'> }) {
  if (c.optedOutAt) return <Badge tone="red">Opted out</Badge>;
  if (c.marketingOptIn) return <Badge tone="green">Opted in</Badge>;
  return <Badge>No consent</Badge>;
}

export function TagPill({ t }: { t: { name: string; color: string } }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
      <span className="size-2 rounded-full" style={{ background: t.color }} aria-hidden />
      {t.name}
    </span>
  );
}

export const formatPhone = (p: string) => (p.startsWith('+91') && p.length === 13 ? `+91 ${p.slice(3, 8)} ${p.slice(8)}` : p);
