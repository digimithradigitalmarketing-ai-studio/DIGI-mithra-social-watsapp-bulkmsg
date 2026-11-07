import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { MailCheck } from 'lucide-react';
import { signupSchema, type SignupInput, type SignupResultDto } from '@socialpilot/shared';
import { post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { handleFormError } from '@/lib/forms';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { AuthLayout } from './AuthLayout';
import { safeNext } from './Login';

export default function Signup() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [checkEmail, setCheckEmail] = useState<string | null>(null);
  const form = useForm<SignupInput>({ resolver: zodResolver(signupSchema), defaultValues: { fullName: '', email: '', password: '' } as Partial<SignupInput> as SignupInput });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const r = await post<SignupResultDto>('/v1/auth/signup', values);
      if (r.session) {
        signIn(r.session);
        navigate(params.get('next') ? safeNext(params.get('next')) : '/onboarding', { replace: true });
      } else setCheckEmail(values.email);
    } catch (err) {
      handleFormError(err, form.setError);
    }
  });

  if (checkEmail)
    return (
      <AuthLayout title="Check your email" subtitle={`We sent a verification link to ${checkEmail}. Open it to activate your account.`}
        footer={<Link to="/login" className="font-medium text-primary hover:underline">Back to sign in</Link>}>
        <div className="flex justify-center text-primary"><MailCheck className="size-12" /></div>
      </AuthLayout>
    );

  return (
    <AuthLayout title="Create your account" subtitle="Start a 14-day free trial. No card required."
      footer={<>Already have an account? <Link to="/login" className="font-medium text-primary hover:underline">Sign in</Link></>}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field id="fullName" label="Your name" error={errors.fullName?.message}>
          <Input id="fullName" autoComplete="name" aria-invalid={!!errors.fullName} {...form.register('fullName')} />
        </Field>
        <Field id="email" label="Work email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...form.register('email')} />
        </Field>
        <Field id="password" label="Password" error={errors.password?.message} hint="At least 10 characters with upper and lower case letters and a number.">
          <Input id="password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...form.register('password')} />
        </Field>
        <div className="space-y-1">
          <label htmlFor="acceptTerms" className="flex items-start gap-2 text-sm">
            <input id="acceptTerms" type="checkbox" aria-invalid={!!errors.acceptTerms} className="mt-0.5 size-4 accent-[var(--primary)]" {...form.register('acceptTerms')} />
            <span>I agree to the <Link to="/legal/terms" target="_blank" className="text-primary hover:underline">Terms of Service</Link> and <Link to="/legal/privacy" target="_blank" className="text-primary hover:underline">Privacy Policy</Link>.</span>
          </label>
          {errors.acceptTerms && <p role="alert" className="text-xs text-destructive">{errors.acceptTerms.message}</p>}
        </div>
        <Button type="submit" variant="brand" className="w-full" loading={isSubmitting}>Create account</Button>
      </form>
    </AuthLayout>
  );
}
