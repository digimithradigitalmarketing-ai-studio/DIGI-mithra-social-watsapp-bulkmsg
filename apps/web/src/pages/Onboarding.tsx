import { useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { createBusinessSchema, INDUSTRIES, type BusinessDto } from '@socialpilot/shared';
import { post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { handleFormError } from '@/lib/forms';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';

const industryLabel = (i: string) => i.replace('_', ' ').replace(/^\w/, (c) => c.toUpperCase()).replace('Salon spa', 'Salon & spa');

type FormIn = z.input<typeof createBusinessSchema>;
type FormOut = z.output<typeof createBusinessSchema>;

export default function Onboarding() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { me, signOut } = useAuth();
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(createBusinessSchema),
    defaultValues: { name: '', industry: 'fitness', phone: '', city: 'Bengaluru', timezone: 'Asia/Kolkata', defaultLanguage: 'en' },
  });
  const { errors, isSubmitting } = form.formState;
  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const b = await post<BusinessDto>('/v1/businesses', values);
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate(`/w/${b.id}/dashboard`, { replace: true });
    } catch (err) { handleFormError(err, form.setError); }
  });

  return (
    <div className="min-h-full bg-background">
      <header className="flex h-16 items-center justify-between border-b bg-card px-6">
        <Logo />
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="hidden sm:inline">{me?.email}</span>
          {!!me?.memberships.length && <Button variant="ghost" size="sm" onClick={() => navigate(`/w/${me.memberships[0]!.businessId}/dashboard`)}>Back to workspace</Button>}
          <Button variant="outline" size="sm" onClick={async () => { await signOut(); navigate('/login'); }}>Sign out</Button>
        </div>
      </header>
      <main className="mx-auto max-w-xl px-6 py-12">
        <p className="text-sm font-medium text-primary">Step 1 of 1 · Workspace</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Set up your business workspace</h1>
        <p className="mt-2 text-sm text-muted-foreground">Each business gets its own isolated workspace for contacts, conversations, campaigns and billing. You'll start on a 14-day free trial.</p>
        <Card className="mt-8">
          <CardContent className="pt-6">
            <form onSubmit={onSubmit} className="space-y-5" noValidate>
              <Field id="name" label="Business name" error={errors.name?.message}>
                <Input id="name" placeholder="e.g. Gold Fitness Kengeri" aria-invalid={!!errors.name} {...form.register('name')} />
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field id="industry" label="Industry" error={errors.industry?.message}>
                  <NativeSelect id="industry" {...form.register('industry')}>
                    {INDUSTRIES.map((i) => <option key={i} value={i}>{industryLabel(i)}</option>)}
                  </NativeSelect>
                </Field>
                <Field id="city" label="City" error={errors.city?.message}>
                  <Input id="city" {...form.register('city')} />
                </Field>
              </div>
              <Field id="phone" label="Business phone (optional)" error={errors.phone?.message} hint="Indian numbers are converted to +91 format.">
                <Input id="phone" type="tel" placeholder="98765 43210" aria-invalid={!!errors.phone} {...form.register('phone')} />
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field id="defaultLanguage" label="Default customer language">
                  <NativeSelect id="defaultLanguage" {...form.register('defaultLanguage')}>
                    <option value="en">English</option>
                    <option value="kn">ಕನ್ನಡ (Kannada)</option>
                  </NativeSelect>
                </Field>
                <Field id="timezone" label="Timezone">
                  <NativeSelect id="timezone" {...form.register('timezone')}>
                    <option value="Asia/Kolkata">Asia/Kolkata (IST)</option>
                    <option value="Asia/Dubai">Asia/Dubai</option>
                    <option value="Asia/Singapore">Asia/Singapore</option>
                    <option value="Europe/London">Europe/London</option>
                    <option value="America/New_York">America/New_York</option>
                  </NativeSelect>
                </Field>
              </div>
              <Button type="submit" variant="brand" className="w-full" loading={isSubmitting}>Create workspace</Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
