import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { RotateCcw } from 'lucide-react';
import { get, post } from '@/lib/api';
import { handleFormError } from '@/lib/forms';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, PageHeader, Skeleton, Table, Td, Th } from '@/components/ui/misc';

interface QueueDto {
  counts: Array<{ kind: string; status: string; n: number }>;
  deadLetter: Array<{ id: string; kind: string; attempts: number; lastError: string | null; businessName: string | null; failedAt: string | null }>;
  webhooks24h: Record<string, number>;
  oldestDueSeconds: number;
}

export function AdminQueue() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-queue'], queryFn: () => get<QueueDto>('/v1/admin/queue'), refetchInterval: 5000 });
  const retry = useMutation({
    mutationFn: (id: string) => post(`/v1/admin/queue/${id}/retry`),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['admin-queue'] }); toast.success('Job re-queued'); },
    onError: (e) => handleFormError(e),
  });
  if (!q.data) return <Skeleton className="h-64" />;
  const d = q.data;
  const kinds = [...new Set(d.counts.map((c) => c.kind))];
  const n = (k: string, s: string) => d.counts.find((c) => c.kind === k && c.status === s)?.n ?? 0;
  return (
    <>
      <PageHeader title="Queue & webhooks" description="Background jobs (last 7 days), dead-letter queue and Meta webhook health." />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card><CardContent className="pt-5"><p className="text-sm text-muted-foreground">Oldest due job waiting</p><p className="mt-1 text-2xl font-semibold">{d.oldestDueSeconds}s</p>
          {d.oldestDueSeconds > 60 && <p className="text-xs text-destructive">Worker may be down or overloaded</p>}</CardContent></Card>
        <Card><CardContent className="pt-5"><p className="text-sm text-muted-foreground">Webhooks (24h)</p><p className="mt-1 text-2xl font-semibold">{Object.values(d.webhooks24h).reduce((a, x) => a + x, 0)}</p>
          <p className="text-xs text-muted-foreground">{Object.entries(d.webhooks24h).map(([k, v]) => `${v} ${k}`).join(' · ') || 'none'}</p></CardContent></Card>
        <Card><CardContent className="pt-5"><p className="text-sm text-muted-foreground">Dead-letter jobs</p><p className="mt-1 text-2xl font-semibold">{d.deadLetter.length}</p></CardContent></Card>
      </div>
      <Card className="mb-6">
        <CardHeader><CardTitle>Jobs by type</CardTitle></CardHeader>
        <Table>
          <thead><tr><Th>Kind</Th>{['pending', 'running', 'done', 'failed', 'cancelled'].map((s) => <Th key={s} className="text-right">{s}</Th>)}</tr></thead>
          <tbody>{kinds.map((k) => <tr key={k}><Td className="font-mono text-xs">{k}</Td>{['pending', 'running', 'done', 'failed', 'cancelled'].map((s) => <Td key={s} className="text-right tabular-nums">{n(k, s)}</Td>)}</tr>)}</tbody>
        </Table>
        {!kinds.length && <p className="p-6 text-center text-sm text-muted-foreground">No jobs in the last 7 days</p>}
      </Card>
      <Card>
        <CardHeader><CardTitle>Dead-letter queue</CardTitle><CardDescription>Jobs that exhausted their retries. Fix the cause, then retry.</CardDescription></CardHeader>
        <Table>
          <thead><tr><Th>Job</Th><Th>Business</Th><Th className="hidden md:table-cell">Last error</Th><Th>Failed</Th><Th /></tr></thead>
          <tbody>{d.deadLetter.map((j) => (
            <tr key={j.id}>
              <Td><Badge tone="red">{j.kind}</Badge><p className="mt-1 text-xs text-muted-foreground">{j.attempts} attempts</p></Td>
              <Td>{j.businessName ?? '—'}</Td>
              <Td className="hidden max-w-md truncate text-xs text-muted-foreground md:table-cell">{j.lastError}</Td>
              <Td className="whitespace-nowrap text-xs">{formatDateTime(j.failedAt)}</Td>
              <Td><Button size="sm" variant="outline" loading={retry.isPending && retry.variables === j.id} onClick={() => retry.mutate(j.id)}><RotateCcw /> Retry</Button></Td>
            </tr>
          ))}</tbody>
        </Table>
        {!d.deadLetter.length && <p className="p-6 text-center text-sm text-muted-foreground">Nothing in the dead-letter queue</p>}
      </Card>
    </>
  );
}
