import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Tags as TagsIcon, Trash2 } from 'lucide-react';
import { can, type TagDto } from '@socialpilot/shared';
import { del, get, post } from '@/lib/api';
import { handleFormError } from '@/lib/forms';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { EmptyState, PageHeader, Skeleton } from '@/components/ui/misc';

const COLORS = ['#2f6bff', '#14b8a6', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#475569'];

export default function Tags() {
  const b = useWorkspace();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[0]!);
  const [deleting, setDeleting] = useState<TagDto | null>(null);
  const canWrite = can(b.myRole, 'contacts.write');
  const q = useQuery({ queryKey: ['tags', b.id], queryFn: () => get<TagDto[]>(`/v1/businesses/${b.id}/tags`) });
  const create = useMutation({
    mutationFn: () => post(`/v1/businesses/${b.id}/tags`, { name, color }),
    onSuccess: async () => { setName(''); await qc.invalidateQueries({ queryKey: ['tags', b.id] }); toast.success('Tag created'); },
    onError: (e) => handleFormError(e),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/v1/businesses/${b.id}/tags/${id}`),
    onSuccess: async () => { setDeleting(null); await qc.invalidateQueries({ queryKey: ['tags', b.id] }); toast.success('Tag deleted'); },
    onError: (e) => handleFormError(e),
  });
  return (
    <>
      <PageHeader title="Tags" description="Group contacts (e.g. Morning batch, Personal training, Expiring this month) and target campaigns by tag." />
      {canWrite && (
        <Card className="mb-6"><CardContent className="flex flex-col gap-3 pt-5 sm:flex-row sm:items-center">
          <Input placeholder="New tag name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="Tag name" className="sm:max-w-xs" />
          <div className="flex gap-1.5" role="radiogroup" aria-label="Tag colour">
            {COLORS.map((c) => <button key={c} role="radio" aria-checked={c === color} aria-label={c} onClick={() => setColor(c)} className="size-7 rounded-full ring-offset-2 aria-checked:ring-2 aria-checked:ring-ring" style={{ background: c }} />)}
          </div>
          <Button onClick={() => create.mutate()} disabled={!name.trim()} loading={create.isPending}><Plus /> Add tag</Button>
        </CardContent></Card>
      )}
      {q.isLoading ? <Skeleton className="h-40" /> : !q.data?.length ? (
        <EmptyState icon={<TagsIcon />} title="No tags yet" description="Tags can also be created automatically from a 'Tags' column during CSV import." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {q.data.map((t) => (
            <Card key={t.id}><CardContent className="flex items-center gap-3 pt-5">
              <span className="size-3 rounded-full" style={{ background: t.color }} />
              <Link to={`/w/${b.id}/contacts?tagId=${t.id}`} className="flex-1 font-medium hover:underline">{t.name}</Link>
              <span className="text-sm text-muted-foreground">{t.contactCount} contact{t.contactCount === 1 ? '' : 's'}</span>
              {canWrite && <Button variant="ghost" size="icon" aria-label={`Delete ${t.name}`} onClick={() => setDeleting(t)}><Trash2 /></Button>}
            </CardContent></Card>
          ))}
        </div>
      )}
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} destructive title={`Delete tag "${deleting?.name}"?`}
        description="Contacts are kept; only the tag is removed from them. Draft campaigns targeting this tag will need a new audience." confirmLabel="Delete" loading={remove.isPending} onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </>
  );
}
