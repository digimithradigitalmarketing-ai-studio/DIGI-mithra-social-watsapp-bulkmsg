import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Dialog as D } from 'radix-ui';
import { Search } from 'lucide-react';
import { can, type BusinessRole } from '@socialpilot/shared';
import { ALL_ITEMS } from '@/nav';
import { Badge } from '@/components/ui/misc';
import { useI18n } from '@/lib/i18n';

/** Global search (⌘K / Ctrl+K). Phase 1 searches navigation; contacts and conversations are added in Phases 2–3. */
export function CommandPalette({ open, onOpenChange, businessId, role }: { open: boolean; onOpenChange: (o: boolean) => void; businessId: string; role: BusinessRole }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const { t } = useI18n();
  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    return ALL_ITEMS.filter((i) => !i.permission || can(role, i.permission)).filter(
      (i) => !term || i.label.toLowerCase().includes(term) || i.section.toLowerCase().includes(term) || t(i.label).includes(term),
    );
  }, [q, role, t]);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { if (!open) setQ(''); }, [open]);

  const go = (path: string) => { onOpenChange(false); navigate(`/w/${businessId}/${path}`); };

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-navy/40 backdrop-blur-[2px]" />
        <D.Content className="fixed left-1/2 top-[12vh] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border bg-card shadow-2xl">
          <D.Title className="sr-only">Search</D.Title>
          <D.Description className="sr-only">Jump to any page</D.Description>
          <div className="flex items-center gap-2 border-b px-4">
            <Search className="size-4 text-muted-foreground" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pages…" aria-label="Search pages"
              className="h-12 flex-1 bg-transparent text-sm outline-none"
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                if (e.key === 'Enter' && results[active]) go(results[active].path);
              }} />
          </div>
          <ul role="listbox" className="max-h-80 overflow-y-auto p-2">
            {results.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">No matches</li>}
            {results.map((r, i) => (
              <li key={r.path} role="option" aria-selected={i === active}>
                <button onMouseEnter={() => setActive(i)} onClick={() => go(r.path)}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm ${i === active ? 'bg-muted' : ''}`}>
                  <r.icon className="size-4 text-muted-foreground" />
                  <span className="flex-1">{t(r.label)} <span className="text-xs text-muted-foreground">· {t(r.section)}</span></span>
                  {r.phase > 5 && <Badge>Phase {r.phase}</Badge>}
                </button>
              </li>
            ))}
          </ul>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
