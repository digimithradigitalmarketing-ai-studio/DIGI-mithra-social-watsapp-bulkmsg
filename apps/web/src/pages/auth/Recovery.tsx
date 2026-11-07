import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { CheckCircle2, MailCheck, XCircle, Users } from 'lucide-react';
import { forgotPasswordSchema, passwordSchema, ROLE_LABELS } from '@socialpilot/shared';
import { ApiError, get, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { handleFormError } from '@/lib/forms';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { AuthLayout } from './AuthLayout';

export function ForgotPassword() {
  const [sent, setSent] = useState(false);
  const form = useForm<{ email: string }>({ resolver: zodResolver(forgotPasswordSchema), defaultValues: { email: '' } });
  const onSubmit = form.handleSubmit(async (v) => {
    try { await post('/v1/auth/forgot-password', v); setSent(true); } catch (err) { handleFormError(err, form.setError); }
  });
  if (sent)
    return (
      <AuthLayout title="Check your email" subtitle="If an account exists for that address, we have sent a password reset link. It expires in 1 hour."
        footer={<Link to="/login" className="font-medium text-primary hover:underline">Back to sign in</Link>}>
        <div className="flex justify-center text-primary"><MailCheck className="size-12" /></div>
      </AuthLayout>
    );
  return (
    <AuthLayout title="Reset your password" subtitle="Enter your account email and we'll send you a reset link."
      footer={<Link to="/login" className="font-medium text-primary hover:underline">Back to sign in</Link>}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field id="email" label="Email" error={form.formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" {...form.register('email')} />
        </Field>
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>Send reset link</Button>
      </form>
    </AuthLayout>
  );
}

const resetForm = z.object({ password: passwordSchema, confirm: z.string() }).refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });

export function ResetPassword() {
  const [params] = useSearchParams();
  // Local provider: ?token=…  ·  Supabase: #access_token=…&type=recovery
  const token = useMemo(() => params.get('token') ?? new URLSearchParams(window.location.hash.slice(1)).get('access_token'), [params]);
  const [done, setDone] = useState(false);
  const form = useForm<z.infer<typeof resetForm>>({ resolver: zodResolver(resetForm), defaultValues: { password: '', confirm: '' } });
  const onSubmit = form.handleSubmit(async (v) => {
    try { await post('/v1/auth/reset-password', { token, password: v.password }); setDone(true); } catch (err) { handleFormError(err, form.setError); }
  });
  if (!token)
    return <AuthLayout title="Invalid link" subtitle="This password reset link is missing or malformed." footer={<Link to="/forgot-password" className="text-primary hover:underline">Request a new link</Link>}><span /></AuthLayout>;
  if (done)
    return <AuthLayout title="Password updated" subtitle="You can now sign in with your new password. Other sessions were signed out." footer={<Link to="/login" className="font-medium text-primary hover:underline">Sign in</Link>}><span /></AuthLayout>;
  return (
    <AuthLayout title="Choose a new password">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field id="password" label="New password" error={form.formState.errors.password?.message} hint="At least 10 characters with upper and lower case letters and a number.">
          <Input id="password" type="password" autoComplete="new-password" {...form.register('password')} />
        </Field>
        <Field id="confirm" label="Confirm password" error={form.formState.errors.confirm?.message}>
          <Input id="confirm" type="password" autoComplete="new-password" {...form.register('confirm')} />
        </Field>
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>Update password</Button>
      </form>
    </AuthLayout>
  );
}

export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<'working' | 'ok' | 'error'>(token ? 'working' : 'ok');
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!token) return;
    post('/v1/auth/verify-email', { token })
      .then(() => setState('ok'))
      .catch((e: unknown) => { setState('error'); setMessage(e instanceof ApiError ? e.message : 'Verification failed'); });
  }, [token]);
  return (
    <AuthLayout title={state === 'working' ? 'Verifying…' : state === 'ok' ? 'Email verified' : 'Verification failed'}
      subtitle={state === 'ok' ? 'Your email address is confirmed. Sign in to continue.' : message}
      footer={<Link to="/login" className="font-medium text-primary hover:underline">Go to sign in</Link>}>
      <div className="flex justify-center">
        {state === 'ok' ? <CheckCircle2 className="size-12 text-success" /> : state === 'error' ? <XCircle className="size-12 text-destructive" /> : <Skeleton className="size-12 rounded-full" />}
      </div>
    </AuthLayout>
  );
}

export function AcceptInvite() {
  const { token = '' } = useParams();
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [accepting, setAccepting] = useState(false);
  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: () => get<{ businessName: string; role: 'manager' | 'agent'; email: string; emailMatches: boolean }>(`/v1/invitations/${token}`),
    retry: false,
  });
  const accept = async () => {
    setAccepting(true);
    try {
      const r = await post<{ businessId: string }>('/v1/invitations/accept', { token });
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate(`/w/${r.businessId}/dashboard`, { replace: true });
    } catch (err) { handleFormError(err); setAccepting(false); }
  };
  if (preview.isLoading) return <AuthLayout title="Loading invitation…"><Skeleton className="h-24" /></AuthLayout>;
  if (preview.error) return <AuthLayout title="Invitation unavailable" subtitle={(preview.error as ApiError).message} footer={<Link to="/" className="text-primary hover:underline">Go to your workspaces</Link>}><span /></AuthLayout>;
  const inv = preview.data!;
  return (
    <AuthLayout title={`Join ${inv.businessName}`} subtitle={`You've been invited as ${ROLE_LABELS[inv.role]}.`}>
      <div className="rounded-lg border bg-card p-5">
        <div className="flex items-center gap-3"><Users className="size-5 text-primary" /><div className="text-sm"><p className="font-medium">{inv.businessName}</p><p className="text-muted-foreground">Invitation for {inv.email}</p></div></div>
      </div>
      {inv.emailMatches ? (
        <Button variant="brand" className="mt-6 w-full" loading={accepting} onClick={accept}>Accept invitation</Button>
      ) : (
        <div className="mt-6 space-y-3 text-sm">
          <p className="text-destructive">You're signed in as {me?.email}. Sign in with {inv.email} to accept.</p>
          <Button variant="outline" className="w-full" onClick={async () => { await signOut(); navigate(`/login?next=/invite/${token}`); }}>Switch account</Button>
        </div>
      )}
    </AuthLayout>
  );
}
