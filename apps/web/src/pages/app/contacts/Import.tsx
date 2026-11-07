import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileUp, Upload } from 'lucide-react';
import type { ImportResultDto, TagDto } from '@socialpilot/shared';
import { get, post } from '@/lib/api';
import { handleFormError } from '@/lib/forms';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { PageHeader, Table, Td, Th } from '@/components/ui/misc';
import { TagPill } from './shared';

/** Lightweight preview parser (the server re-parses authoritatively). */
function previewCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  for (let i = 0; i < text.length && rows.length < 6; i++) {
    const ch = text[i]!;
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.some((c) => c.trim())) rows.push(row); row = []; }
    else field += ch;
  }
  if (rows.length < 6) { row.push(field); if (row.some((c) => c.trim())) rows.push(row); }
  return rows;
}

const guess = (h: string) => {
  const s = h.toLowerCase();
  if (/(phone|mobile|whatsapp|number|contact no)/.test(s)) return 'phone';
  if (/name/.test(s)) return 'name';
  if (/mail/.test(s)) return 'email';
  if (/(birth|dob)/.test(s)) return 'birthday';
  if (/(lang)/.test(s)) return 'language';
  if (/(tag|group|batch)/.test(s)) return 'tags';
  if (/expir/.test(s)) return 'custom:membership_expiry';
  if (/(due|balance)/.test(s)) return 'custom:payment_due';
  return 'ignore';
};

export default function ImportContacts() {
  const b = useWorkspace();
  const qc = useQueryClient();
  const [fileName, setFileName] = useState('');
  const [csv, setCsv] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [customKeys, setCustomKeys] = useState<Record<string, string>>({});
  const [onDuplicate, setOnDuplicate] = useState<'update' | 'skip'>('update');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [consent, setConsent] = useState({ marketing: true, utility: false, source: '', confirmed: false });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResultDto | null>(null);
  const tags = useQuery({ queryKey: ['tags', b.id], queryFn: () => get<TagDto[]>(`/v1/businesses/${b.id}/tags`) });
  const preview = useMemo(() => (csv ? previewCsv(csv) : []), [csv]);
  const header = preview[0] ?? [];

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 5_000_000) { handleFormError(new Error('Files up to 5 MB')); return; }
    const text = await f.text();
    setFileName(f.name); setCsv(text); setResult(null);
    const h = previewCsv(text)[0] ?? [];
    setMapping(Object.fromEntries(h.map((x) => [x.trim(), guess(x)])));
  };
  const finalMapping = Object.fromEntries(Object.entries(mapping).map(([h, f]) => [h, f === 'custom' ? `custom:${(customKeys[h] || h).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 40) || 'field'}` : f]));
  const hasPhone = Object.values(finalMapping).includes('phone');
  const needsConsentDetails = consent.marketing || consent.utility;
  const ready = csv && hasPhone && (!needsConsentDetails || (consent.confirmed && consent.source.trim().length >= 3));

  const submit = async () => {
    setBusy(true);
    try {
      const r = await post<ImportResultDto>(`/v1/businesses/${b.id}/contacts/import`, { csv, mapping: finalMapping, onDuplicate, tagIds, consent });
      setResult(r);
      await qc.invalidateQueries({ queryKey: ['contacts', b.id] });
      await qc.invalidateQueries({ queryKey: ['tags', b.id] });
    } catch (e) { handleFormError(e); } finally { setBusy(false); }
  };

  if (result)
    return (
      <>
        <PageHeader title="Import complete" />
        <Card><CardContent className="space-y-4 pt-6">
          <p className="flex items-center gap-2 text-lg font-medium"><CheckCircle2 className="text-success" /> {result.created} created · {result.updated} updated · {result.skipped} skipped</p>
          {result.errors.length > 0 && (
            <div><p className="mb-2 text-sm font-medium">Rows that need attention</p>
              <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-3 text-sm">{result.errors.map((e, i) => <li key={i}><span className="text-muted-foreground">Row {e.row}:</span> {e.message}</li>)}</ul></div>
          )}
          <div className="flex gap-2"><Button asChild><Link to={`/w/${b.id}/contacts`}>View contacts</Link></Button><Button variant="outline" onClick={() => { setResult(null); setCsv(''); setFileName(''); }}>Import another file</Button></div>
        </CardContent></Card>
      </>
    );

  return (
    <>
      <PageHeader title="Import contacts" description="Upload a CSV exported from Excel, Google Sheets or your gym software. Up to 10,000 rows per file." />
      <div className="space-y-6">
        <Card>
          <CardHeader><CardTitle>1. Choose a file</CardTitle></CardHeader>
          <CardContent>
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed p-8 text-center hover:bg-muted/50">
              <FileUp className="size-8 text-primary" />
              <span className="font-medium">{fileName || 'Click to choose a .csv file'}</span>
              <span className="text-xs text-muted-foreground">Indian numbers like 98765 43210 are converted to +91 automatically</span>
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
          </CardContent>
        </Card>

        {header.length > 0 && (
          <Card>
            <CardHeader><CardTitle>2. Match columns</CardTitle><CardDescription>Unknown columns can be stored as custom fields (e.g. membership_expiry) for message personalisation.</CardDescription></CardHeader>
            <Table>
              <thead><tr><Th>Column in file</Th><Th>Sample</Th><Th>Save as</Th></tr></thead>
              <tbody>
                {header.map((h, i) => {
                  const key = h.trim();
                  const v = mapping[key] ?? 'ignore';
                  const isCustom = v === 'custom' || v.startsWith('custom:');
                  return (
                    <tr key={i}>
                      <Td className="font-medium">{key || <em>(blank)</em>}</Td>
                      <Td className="max-w-48 truncate text-muted-foreground">{preview.slice(1, 3).map((r) => r[i]).filter(Boolean).join(', ')}</Td>
                      <Td>
                        <div className="flex gap-2">
                          <NativeSelect aria-label={`Field for ${key}`} value={isCustom ? 'custom' : v} onChange={(e) => setMapping({ ...mapping, [key]: e.target.value === 'custom' ? `custom:${key.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '')}` : e.target.value })}>
                            <option value="ignore">Don't import</option><option value="name">Name</option><option value="phone">Phone (required)</option><option value="email">Email</option>
                            <option value="language">Language (en/kn)</option><option value="birthday">Birthday (YYYY-MM-DD)</option><option value="tags">Tags (separated by ;)</option><option value="custom">Custom field…</option>
                          </NativeSelect>
                          {isCustom && <Input aria-label="Custom field key" className="w-44" value={customKeys[key] ?? v.slice(7)} onChange={(e) => { setCustomKeys({ ...customKeys, [key]: e.target.value }); setMapping({ ...mapping, [key]: 'custom' }); }} />}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            {!hasPhone && <p className="px-5 py-3 text-sm text-destructive">Map one column to Phone.</p>}
          </Card>
        )}

        {header.length > 0 && (
          <Card>
            <CardHeader><CardTitle>3. Options & consent</CardTitle></CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="dup" label="If a phone number already exists"><NativeSelect id="dup" value={onDuplicate} onChange={(e) => setOnDuplicate(e.target.value as 'update' | 'skip')}><option value="update">Update the existing contact</option><option value="skip">Skip the row</option></NativeSelect></Field>
                <fieldset><legend className="mb-1.5 text-sm font-medium">Add tags to every imported contact</legend>
                  <div className="flex flex-wrap gap-2">{tags.data?.map((t) => (
                    <label key={t.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={tagIds.includes(t.id)} onChange={(e) => setTagIds(e.target.checked ? [...tagIds, t.id] : tagIds.filter((x) => x !== t.id))} /> <TagPill t={t} /></label>
                  ))}{!tags.data?.length && <span className="text-sm text-muted-foreground">No tags yet</span>}</div>
                </fieldset>
              </div>
              <fieldset className="space-y-3 rounded-md border p-4">
                <legend className="px-1 text-sm font-semibold">WhatsApp consent</legend>
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={consent.marketing} onChange={(e) => setConsent({ ...consent, marketing: e.target.checked })} /> These customers agreed to receive marketing messages (offers, announcements) on WhatsApp</label>
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={consent.utility} onChange={(e) => setConsent({ ...consent, utility: e.target.checked })} /> These customers agreed to receive service messages (renewal and payment reminders)</label>
                {needsConsentDetails && (
                  <>
                    <Field id="consent-src" label="Where and how was consent collected?"><Input id="consent-src" placeholder="e.g. Gym enquiry form with WhatsApp opt-in checkbox" value={consent.source} onChange={(e) => setConsent({ ...consent, source: e.target.value })} /></Field>
                    <label className="flex items-start gap-2 rounded-md bg-muted p-3 text-sm"><input type="checkbox" className="mt-0.5" checked={consent.confirmed} onChange={(e) => setConsent({ ...consent, confirmed: e.target.checked })} />
                      I confirm every person in this file gave this consent, and I can provide evidence if asked. Customers who previously opted out will not be re-subscribed.</label>
                  </>
                )}
                {!needsConsentDetails && <p className="text-sm text-muted-foreground">Contacts without consent are stored but excluded from campaigns.</p>}
              </fieldset>
              <Button variant="brand" disabled={!ready} loading={busy} onClick={submit}><Upload /> Import contacts</Button>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
