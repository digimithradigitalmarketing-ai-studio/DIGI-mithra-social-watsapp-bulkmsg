import { z } from 'zod';
import { BUSINESS_ROLES } from './roles';

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128, 'Use at most 128 characters')
  .regex(/[a-z]/, 'Include a lowercase letter')
  .regex(/[A-Z]/, 'Include an uppercase letter')
  .regex(/[0-9]/, 'Include a number');

export const signupSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter your name').max(100),
  email: emailSchema,
  password: passwordSchema,
  acceptTerms: z.literal(true, { message: 'You must accept the Terms and Privacy Policy' }),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(10).max(4096),
  password: passwordSchema,
});

export const mfaVerifySchema = z.object({
  factorId: z.string().min(1).max(100),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

/** E.164 phone: + followed by 7–15 digits, no leading zero. */
export const phoneE164Schema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Use international format, e.g. +919876543210');

/** Normalise common Indian inputs (98765 43210, 098765..., 91...) to E.164. Returns null if invalid. */
export function normalizeIndianPhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, '');
  let d = digits.startsWith('+') ? digits.slice(1) : digits;
  if (/^0\d{10}$/.test(d)) d = d.slice(1);
  if (/^[6-9]\d{9}$/.test(d)) d = `91${d}`;
  const e164 = `+${d}`;
  return /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : null;
}

export const INDUSTRIES = [
  'fitness',
  'education',
  'healthcare',
  'retail',
  'restaurant',
  'real_estate',
  'salon_spa',
  'services',
  'other',
] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v));

export const createBusinessSchema = z.object({
  name: z.string().trim().min(2, 'Enter the business name').max(120),
  industry: z.enum(INDUSTRIES).default('other'),
  phone: z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      const n = normalizeIndianPhone(v);
      if (!n) {
        ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number' });
        return z.NEVER;
      }
      return n;
    }),
  city: optionalText(80),
  timezone: z.string().trim().min(1).max(64).default('Asia/Kolkata'),
  defaultLanguage: z.enum(['en', 'kn']).default('en'),
});
export type CreateBusinessInput = z.input<typeof createBusinessSchema>;

export const updateBusinessSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    industry: z.enum(INDUSTRIES),
    phone: z.string().trim().max(20).nullable(),
    email: z.union([emailSchema, z.literal('')]).nullable(),
    website: z.union([z.string().trim().url('Enter a full URL, e.g. https://example.com').max(200), z.literal('')]).nullable(),
    address: z.string().trim().max(300).nullable(),
    city: z.string().trim().max(80).nullable(),
    state: z.string().trim().max(80).nullable(),
    timezone: z.string().trim().min(1).max(64),
    defaultLanguage: z.enum(['en', 'kn']),
  })
  .partial();
export type UpdateBusinessInput = z.infer<typeof updateBusinessSchema>;

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(['manager', 'agent']),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberSchema = z
  .object({
    role: z.enum(BUSINESS_ROLES),
    status: z.enum(['active', 'disabled']),
  })
  .partial()
  .refine((v) => v.role !== undefined || v.status !== undefined, 'Nothing to update');

export const acceptInvitationSchema = z.object({ token: z.string().min(20).max(200) });

export const updateProfileSchema = z
  .object({
    fullName: z.string().trim().min(2).max(100),
    phone: z.string().trim().max(20).nullable(),
    preferredLanguage: z.enum(['en', 'kn']),
  })
  .partial();

export const suspendBusinessSchema = z.object({ reason: z.string().trim().min(5, 'Give a reason').max(500) });

export const updatePlanSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(300),
    monthlyPricePaise: z.number().int().min(0).max(100_000_00),
    annualPricePaise: z.number().int().min(0).max(1_000_000_00),
    trialDays: z.number().int().min(0).max(90),
    isActive: z.boolean(),
    limits: z.record(z.string(), z.number().int().min(0)),
    /** Razorpay plan ids (plan_...) created in the Razorpay dashboard. Empty string clears. */
    razorpayPlanIdMonthly: z.string().trim().max(64).regex(/^(plan_[A-Za-z0-9]+)?$/),
    razorpayPlanIdAnnual: z.string().trim().max(64).regex(/^(plan_[A-Za-z0-9]+)?$/),
  })
  .partial();

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
});
