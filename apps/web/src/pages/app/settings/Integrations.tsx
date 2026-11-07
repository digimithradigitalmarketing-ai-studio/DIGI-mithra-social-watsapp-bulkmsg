import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CreatedIntegrationKeyDto, IntegrationsDto } from '@socialpilot/shared';
import { get, post } from '@/lib/api';
import { handleFormError } from '@/lib/forms';
import { formatDateTime } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge, PageHeader } from '@/components/ui/misc';

const APPS_SCRIPT = `// Google Sheets → Apps Script. Keep SECRET in Project Settings → Script properties, not in the sheet.
const INTAKE_URL = '{{INTAKE_URL}}';
const KEY_ID = '{{KEY_ID}}';

function onFormSubmit(e) {
  const r = e.namedValues;
  const body = JSON.stringify({
    externalId: e.range.getSheet().getName() + '-' + e.range.getRow(),
    name: r['Name'][0],
    phone: r['Phone'][0],
    interest: (r['Interested in'] || [''])[0],
    message: (r['Message'] || [''])[0],
    formKey: 'gym_enquiry',
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const secret = PropertiesService.getScriptProperties().getProperty('DM_SECRET');
  const sig = Utilities.computeHmacSha256Signature(ts + '.' + body, secret)
    .map(function (b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'); }).join('');
  UrlFetchApp.fetch(INTAKE_URL, {
    method: 'post', contentType: 'application/json', payload: body, muteHttpExceptions: true,
    headers: { 'X-DM-Key-Id': KEY_ID, 'X-DM-Timestamp': ts, 'X-DM-Signature': sig },
  });
}`;

export function IntegrationsPage() {
  const b = useWorkspace();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['integrations', b.id], queryFn: () => get<IntegrationsDto>(`/v1/businesses/${b.id}/integrations`), enabled: b.myRole === 'owner' });
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedIntegrationKeyDto | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['integrations', b.id] });

  const create = useMutation({
    mutationFn: () => post<CreatedIntegrationKeyDto>(`/v1/businesses/${b.id}/integrations/keys`, { name }),
    onSuccess: (k) => { setCreated(k); setName(''); refresh(); toast.success('Key created. Copy the secret now; it will not be shown again.'); },
    onError: (e) => handleFormError(e),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => post(`/v1/businesses/${b.id}/integrations/keys/${id}/revoke`, {}),
    onSuccess: () => { toast.success('Key revoked'); refresh(); },
    onError: (e) => handleFormError(e),
  });

  if (b.myRole !== 'owner') {
    return (<><PageHeader title="Webhooks & Integrations" description="Connect enquiry forms to DigiMithra." /><p className="text-sm text-muted-foreground">Only the workspace owner can manage integration keys.</p></>);
  }

  const script = q.data ? APPS_SCRIPT.replace('{{INTAKE_URL}}', q.data.intakeUrl).replace('{{KEY_ID}}', created?.keyId ?? '<create a key first>') : '';

  return (
    <>
      <PageHeader title="Webhooks & Integrations" description="Send enquiries from your Google Form into DigiMithra. Each request is signed with a secret that never leaves the server." />
      <Card className="mb-6">
        <CardHeader><CardTitle>Lead intake keys</CardTitle><CardDescription>Create one key per form. Revoke it to stop all requests from that form.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <Input aria-label="Key name" placeholder="e.g. Website enquiry form" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="max-w-sm" />
            <Button type="submit" disabled={!name.trim() || create.isPending}>Create key</Button>
          </form>
          {created && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm">
              <p className="font-medium">Secret for “{created.name}” — shown once</p>
              <code className="mt-2 block break-all rounded bg-white p-2 font-mono text-xs">{created.secret}</code>
              <p className="mt-2 text-xs">Put it in the script under Project Settings → Script properties as <code>DM_SECRET</code>. Key id: <code>{created.keyId}</code></p>
              <Button variant="outline" className="mt-3" onClick={() => setCreated(null)}>I've saved it</Button>
            </div>
          )}
          <ul className="divide-y text-sm">
            {q.data?.keys.length === 0 && <li className="py-2 text-muted-foreground">No keys yet.</li>}
            {q.data?.keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{k.name} <span className="font-mono text-xs text-muted-foreground">{k.keyId}</span> {k.revokedAt ? <Badge tone="amber">revoked</Badge> : <Badge tone="green">active</Badge>}</span>
                <span className="text-xs text-muted-foreground">{k.lastUsedAt ? `Last used ${formatDateTime(k.lastUsedAt, b.timezone)}` : 'Not used yet'}</span>
                {!k.revokedAt && <Button variant="outline" size="sm" onClick={() => revoke.mutate(k.id)} disabled={revoke.isPending}>Revoke</Button>}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {q.data && (
        <Card>
          <CardHeader><CardTitle>Google Form setup (Apps Script)</CardTitle><CardDescription>Intake URL: <code className="break-all">{q.data.intakeUrl}</code></CardDescription></CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">Add this script to the sheet linked to your form and create an installable “On form submit” trigger. Requests are signed with HMAC-SHA256 over <code>timestamp.body</code> and rejected after five minutes.</p>
            <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">{script}</pre>
          </CardContent>
        </Card>
      )}
    </>
  );
}
