import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import type { NotificationDto } from '@socialpilot/shared';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DropdownContent, DropdownItem, DropdownLabel, DropdownMenu, DropdownTrigger } from '@/components/ui/dropdown';

/** In-app notifications created by automation "Notify staff" steps. */
export function NotificationBell({ businessId, timezone }: { businessId: string; timezone: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['notifications', businessId],
    queryFn: () => api<{ data: NotificationDto[]; meta: { unread: number } }>(`/v1/businesses/${businessId}/notifications`),
    refetchInterval: 30_000,
  });
  const unread = q.data?.meta.unread ?? 0;
  const markRead = async () => {
    if (!unread) return;
    await api(`/v1/businesses/${businessId}/notifications/read-all`, { method: 'POST' }).catch(() => undefined);
    await qc.invalidateQueries({ queryKey: ['notifications', businessId] });
  };
  return (
    <DropdownMenu onOpenChange={(o) => { if (!o) void markRead(); }}>
      <DropdownTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={unread ? `${unread} unread notifications` : 'Notifications'}>
          <Bell />
          {unread > 0 && <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-destructive text-[9px] font-semibold text-white">{unread > 9 ? '9+' : unread}</span>}
        </Button>
      </DropdownTrigger>
      <DropdownContent className="w-80">
        <DropdownLabel>Notifications</DropdownLabel>
        {!q.data?.data.length && <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing yet</p>}
        {q.data?.data.slice(0, 10).map((n) => (
          <DropdownItem key={n.id} onSelect={() => n.link && navigate(`/w/${businessId}/${n.link}`)} className="items-start">
            <span className={`mt-1.5 size-2 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-primary'}`} />
            <span className="min-w-0"><span className="block text-sm font-medium">{n.body}</span>
              <span className="block text-xs text-muted-foreground">{n.title} · {formatDateTime(n.createdAt, timezone)}</span></span>
          </DropdownItem>
        ))}
      </DropdownContent>
    </DropdownMenu>
  );
}
