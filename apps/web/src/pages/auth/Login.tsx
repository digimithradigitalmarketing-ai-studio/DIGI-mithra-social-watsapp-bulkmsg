import { Link, useNavigate, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput, type SessionDto } from '@socialpilot/shared';
import { post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { handleFormError } from '@/lib/forms';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { AuthLayout } from './AuthLayout';

export function safeNext(next: string | null) {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export default function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const form = useForm<LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const session = await post<SessionDto>('/v1/auth/login', values);
      signIn(session);
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (err) {
      handleFormError(err, form.setError);
    }
  });

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to your Social Pilot workspace."
      footer={<>New to Social Pilot? <Link to={`/signup${params.get('next') ? `?next=${encodeURIComponent(params.get('next')!)}` : ''}`} className="font-medium text-primary hover:underline">Create an account</Link></>}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field id="email" label="Work email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...form.register('email')} />
        </Field>
        <Field id="password" label="Password" error={errors.password?.message}>
          <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!errors.password} {...form.register('password')} />
        </Field>
        <div className="flex justify-end"><Link to="/forgot-password" className="text-sm text-primary hover:underline">Forgot password?</Link></div>
        <Button type="submit" variant="brand" className="w-full" loading={isSubmitting}>Sign in</Button>
      </form>
    </AuthLayout>
  );
}
