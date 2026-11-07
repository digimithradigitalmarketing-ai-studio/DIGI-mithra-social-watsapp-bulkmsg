import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { z } from 'zod';
import { can, INDUSTRIES, updateBusinessSchema, type BusinessDto } from '@socialpilot/shared';
import { patch } from '@/lib/api';
import { handleFormError } from '@/lib/forms';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/misc';

type FormIn = z.input<typeof updateBusinessSchema>;

export default function BusinessProfile() {
  const b = useWorkspace();
  const qc = useQueryClient();
  const editable = can(b.myRole, 'business.update');
  const form = useForm<FormIn>({
    resolver: zodResolver(updateBusinessSchema),
    values: {
      name: b.name, industry: (b.industry as FormIn['industry']) ?? 'other', phone: b.phone ?? '', email: b.email ?? '', website: b.website ?? '',
      address: b.address ?? '', city: b.city ?? '', state: b.state ?? '', timezone: b.timezone, defaultLanguage: b.defaultLanguage,
    },
  });
  const { errors, isSubmitting, isDirty } = form.formState;
  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const updated = await patch<BusinessDto>(`/v1/businesses/${b.id}`, values);
      qc.setQueryData(['business', b.id], updated);
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast.success('Business profile saved');
    } catch (err) { handleFormError(err, form.setError); }
  });
  const f = (name: keyof FormIn, label: string, props: Record<string, unknown> = {}) => (
    <Field id={name} label={label} error={errors[name]?.message as string | undefined}>
      <Input id={name} disabled={!editable} aria-invalid={!!errors[name]} {...props} {...form.register(name)} />
    </Field>
  );
  return (
    <>
      <PageHeader title="Business Profile" description="Used in message personalisation ({{business_name}}), invoices and your customer-facing details." />
      <form onSubmit={onSubmit} noValidate>
        <Card>
          <CardHeader>
            <CardTitle>Business details</CardTitle>
            {!editable && <CardDescription>Only the business owner can edit these details.</CardDescription>}
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            <div className="sm:col-span-2">{f('name', 'Business name')}</div>
            <Field id="industry" label="Industry">
              <NativeSelect id="industry" disabled={!editable} {...form.register('industry')}>
                {INDUSTRIES.map((i) => <option key={i} value={i}>{i.replace('_', ' ')}</option>)}
              </NativeSelect>
            </Field>
            {f('phone', 'Phone', { type: 'tel' })}
            {f('email', 'Contact email', { type: 'email' })}
            {f('website', 'Website', { placeholder: 'https://' })}
            <div className="sm:col-span-2">{f('address', 'Address')}</div>
            {f('city', 'City')}
            {f('state', 'State')}
            <Field id="timezone" label="Timezone" hint="Campaign schedules and reports use this timezone.">
              <Input id="timezone" disabled={!editable} {...form.register('timezone')} />
            </Field>
            <Field id="defaultLanguage" label="Default customer language">
              <NativeSelect id="defaultLanguage" disabled={!editable} {...form.register('defaultLanguage')}>
                <option value="en">English</option>
                <option value="kn">ಕನ್ನಡ (Kannada)</option>
              </NativeSelect>
            </Field>
            <div className="grid gap-1 text-sm sm:col-span-2 sm:grid-cols-3">
              <p><span className="text-muted-foreground">Workspace ID:</span> <code className="text-xs">{b.id.slice(0, 8)}…</code></p>
              <p><span className="text-muted-foreground">Country:</span> {b.country}</p>
              <p><span className="text-muted-foreground">Currency:</span> {b.currency}</p>
            </div>
          </CardContent>
          {editable && (
            <div className="flex justify-end gap-2 border-t px-5 py-4">
              <Button type="button" variant="outline" disabled={!isDirty} onClick={() => form.reset()}>Discard</Button>
              <Button type="submit" loading={isSubmitting} disabled={!isDirty}>Save changes</Button>
            </div>
          )}
        </Card>
      </form>
    </>
  );
}
