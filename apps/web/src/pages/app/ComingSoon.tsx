import { useLocation } from 'react-router';
import { Rocket } from 'lucide-react';
import { ALL_ITEMS } from '@/nav';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/components/layout/AppShell';
import { Badge, EmptyState, PageHeader } from '@/components/ui/misc';

/** Honest placeholder for modules scheduled in later phases — no non-functional buttons. */
export default function ComingSoon() {
  const b = useWorkspace();
  const { t } = useI18n();
  const { pathname } = useLocation();
  const rel = pathname.replace(`/w/${b.id}/`, '');
  const item = ALL_ITEMS.find((i) => i.path === rel);
  return (
    <>
      <PageHeader title={item ? t(item.label) : 'Not found'} description={item ? t(item.section) : undefined} />
      <EmptyState
        icon={<Rocket />}
        title={item ? `${t('Coming soon')} · Phase ${item.phase}` : 'Page not found'}
        description={item?.description ?? 'This page does not exist.'}
        action={item && <Badge tone="blue">Database tables for this module are already in place</Badge>}
      />
    </>
  );
}
