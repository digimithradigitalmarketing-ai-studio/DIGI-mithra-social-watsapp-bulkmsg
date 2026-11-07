import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Download, Plus, Search, Tag as TagIcon, Upload, Users } from 'lucide-react';
import { can, createContactSchema, type ContactDto, type TagDto } from '@socialpilot/shared';
import { downloadFile, get, getPage, post } from '@/lib/api';
import { handleFormError } from '@/lib/forms';
import { formatDate } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { DropdownContent, DropdownItem, DropdownLabel, DropdownMenu, DropdownTrigger } from '@/components/ui/dropdown';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { EmptyState, PageHeader, Skeleton, Table, Td, Th } from '@/components/ui/misc';
import { ConsentBadge, TagPill, formatPhone } from './shared';

type Page = { data: ContactDto[]; meta: { total: number; page: number; pageSize: number; contactLimit: number | null; contactsUsed: number } };

export default function Contacts() {
  const b = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [search] = useSearchParams();
  const [tagId, setTagId] = useState(search.get('tagId') ?? '');
  const [consent, setConsent] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const canWrite = can(b.myRole, 'contacts.write');

  const params = new URLSearchParams({ page: String(page), pageSize: '25', ...(q && { q }), ...(tagId && { tagId }), ...(consent && { consent }) });
  const list = useQuery({ queryKey: ['contacts', b.id, params.toString()], queryFn: () => getPage<ContactDto[]>(`/v1/businesses/${b.id}/contacts?${params}`) as Promise<Page> });
  const tags = useQuery({ queryKey: ['tags', b.id], queryFn: () => get<TagDto[]>(`/v1/businesses/${b.id}/tags`) });
  const bulk = useMutation({
    mutationFn: (v: { tagId: string; action: 'add' | 'remove' }) => post<{ changed: number }>(`/v1/businesses/${b.id}/contacts/bulk-tag`, { ...v, contactIds: [...selected] }),
    onSuccess: async (r) => { toast.success(`Updated ${r.changed} contact(s)`); setSelected(new Set()); await qc.invalidateQueries({ queryKey: ['contacts', b.id] }); await qc.invalidateQueries({ queryKey: ['tags', b.id] }); },
    onError: (e) => handleFormError(e),
  });

  const meta = list.data?.meta;
  const rows = list.data?.data ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <>
      <PageHeader title="Contacts" description={meta ? `${meta.contactsUsed.toLocaleString('en-IN')}${meta.contactLimit ? ` of ${meta.contactLimit.toLocaleString('en-IN')}` : ''} contacts on your plan` : undefined}
        actions={<>
          {can(b.myRole, 'contacts.export') && <Button variant="outline" onClick={() => downloadFile(`/v1/businesses/${b.id}/contacts-export.csv`, 'contacts.csv').catch(handleFormError)}><Download /> Export</Button>}
          {canWrite && <Button variant="outline" asChild><Link to={`/w/${b.id}/contacts/import`}><Upload /> Import CSV</Link></Button>}
          {canWrite && <Button onClick={() => setAdding(true)}><Plus /> Add contact</Button>}
        </>} />

      <div className="mb-4 flex flex-col gap-2 md:flex-row">
        <div className="relative flex-1"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search name, phone or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Search contacts" /></div>
        <NativeSelect className="md:w-48" value={tagId} onChange={(e) => { setTagId(e.target.value); setPage(1); }} aria-label="Filter by tag">
          <option value="">All tags</option>{tags.data?.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.contactCount})</option>)}
        </NativeSelect>
        <NativeSelect className="md:w-48" value={consent} onChange={(e) => { setConsent(e.target.value); setPage(1); }} aria-label="Filter by consent">
          <option value="">Any consent</option><option value="marketing">Opted in (marketing)</option><option value="none">No consent</option><option value="opted_out">Opted out</option>
        </NativeSelect>
      </div>

      {selected.size > 0 && canWrite && (
        <div className="mb-3 flex items-center gap-3 rounded-md border bg-accent px-4 py-2 text-sm text-accent-foreground">
          <span className="font-medium">{selected.size} selected</span>
          <DropdownMenu>
            <DropdownTrigger asChild><Button size="sm" variant="outline"><TagIcon /> Tag</Button></DropdownTrigger>
            <DropdownContent align="start">
              <DropdownLabel>Add tag</DropdownLabel>
              {tags.data?.map((t) => <DropdownItem key={`a${t.id}`} onSelect={() => bulk.mutate({ tagId: t.id, action: 'add' })}><TagPill t={t} /></DropdownItem>)}
              <DropdownLabel>Remove tag</DropdownLabel>
              {tags.data?.map((t) => <DropdownItem key={`r${t.id}`} onSelect={() => bulk.mutate({ tagId: t.id, action: 'remove' })}><TagPill t={t} /></DropdownItem>)}
            </DropdownContent>
          </DropdownMenu>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      <Card>
        {list.isLoading ? <CardContent className="pt-5"><Skeleton className="h-64" /></CardContent> : rows.length === 0 ? (
          <CardContent className="pt-5">
            <EmptyState icon={<Users />} title={q || tagId || consent ? 'No matching contacts' : 'No contacts yet'}
              description="Import opted-in customers from a CSV file or add them one by one. Record where each customer gave consent."
              action={canWrite && <Button asChild><Link to={`/w/${b.id}/contacts/import`}><Upload /> Import CSV</Link></Button>} />
          </CardContent>
        ) : (
          <Table>
            <thead><tr>
              {canWrite && <Th className="w-10"><input type="checkbox" aria-label="Select all on page" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} /></Th>}
              <Th>Name</Th><Th>Phone</Th><Th className="hidden lg:table-cell">Tags</Th><Th>Consent</Th><Th className="hidden md:table-cell">Added</Th>
            </tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-muted/50" onClick={() => navigate(`/w/${b.id}/contacts/${c.id}`)}>
                  {canWrite && <Td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${c.name || c.phone}`} checked={selected.has(c.id)}
                    onChange={() => { const s = new Set(selected); if (s.has(c.id)) s.delete(c.id); else s.add(c.id); setSelected(s); }} /></Td>}
                  <Td className="font-medium">{c.name || <span className="text-muted-foreground">Unnamed</span>}</Td>
                  <Td className="whitespace-nowrap tabular-nums">{formatPhone(c.phone)}</Td>
                  <Td className="hidden lg:table-cell"><div className="flex flex-wrap gap-1">{c.tags.slice(0, 3).map((t) => <TagPill key={t.id} t={t} />)}{c.tags.length > 3 && <span className="text-xs text-muted-foreground">+{c.tags.length - 3}</span>}</div></Td>
                  <Td><ConsentBadge c={c} /></Td>
                  <Td className="hidden text-muted-foreground md:table-cell">{formatDate(c.createdAt, b.timezone)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {meta && meta.total > 25 && (
          <div className="flex items-center justify-between border-t px-5 py-3 text-sm">
            <span className="text-muted-foreground">{meta.total.toLocaleString('en-IN')} contacts</span>
            <div className="flex gap-2"><Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <Button variant="outline" size="sm" disabled={page * 25 >= meta.total} onClick={() => setPage((p) => p + 1)}>Next</Button></div>
          </div>
        )}
      </Card>
      <AddContactDialog open={adding} onOpenChange={setAdding} tags={tags.data ?? []} />
    </>
  );
}

type FormIn = z.input<typeof createContactSchema>;
type FormOut = z.output<typeof createContactSchema>;

function AddContactDialog({ open, onOpenChange, tags }: { open: boolean; onOpenChange: (o: boolean) => void; tags: TagDto[] }) {
  const b = useWorkspace();
  const qc = useQueryClient();
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(createContactSchema),
    defaultValues: { name: '', phone: '', email: '', language: 'en', tagIds: [], customFields: {}, consent: { marketing: false, utility: false, source: '' } },
  });
  const { errors, isSubmitting } = form.formState;
  const marketing = form.watch('consent.marketing');
  const submit = form.handleSubmit(async (v) => {
    try {
      await post(`/v1/businesses/${b.id}/contacts`, v);
      toast.success('Contact added');
      form.reset();
      onOpenChange(false);
      await qc.invalidateQueries({ queryKey: ['contacts', b.id] });
      await qc.invalidateQueries({ queryKey: ['tags', b.id] });
    } catch (e) { handleFormError(e, form.setError); }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add contact">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="c-name" label="Name" error={errors.name?.message}><Input id="c-name" {...form.register('name')} /></Field>
          <Field id="c-phone" label="WhatsApp number" error={errors.phone?.message}><Input id="c-phone" type="tel" placeholder="98765 43210" {...form.register('phone')} /></Field>
          <Field id="c-email" label="Email (optional)" error={errors.email?.message}><Input id="c-email" type="email" {...form.register('email')} /></Field>
          <Field id="c-lang" label="Language"><NativeSelect id="c-lang" {...form.register('language')}><option value="en">English</option><option value="kn">ಕನ್ನಡ</option></NativeSelect></Field>
        </div>
        {tags.length > 0 && (
          <fieldset><legend className="mb-1.5 text-sm font-medium">Tags</legend>
            <div className="flex flex-wrap gap-2">{tags.map((t) => (
              <label key={t.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" value={t.id} {...form.register('tagIds')} /> <TagPill t={t} /></label>
            ))}</div>
          </fieldset>
        )}
        <fieldset className="space-y-2 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">Consent</legend>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" {...form.register('consent.marketing')} /> Customer agreed to receive offers and updates on WhatsApp (marketing)</label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" {...form.register('consent.utility')} /> Customer agreed to receive service messages (reminders, payment due)</label>
          {(marketing || form.watch('consent.utility')) && (
            <Field id="c-source" label="Where was consent given?" error={errors.consent?.source?.message}>
              <Input id="c-source" placeholder="e.g. Reception sign-up form, 6 Nov" {...form.register('consent.source')} />
            </Field>
          )}
        </fieldset>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" loading={isSubmitting}>Add contact</Button></div>
      </form>
    </Dialog>
  );
}
