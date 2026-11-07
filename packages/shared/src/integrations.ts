import { z } from 'zod';

export const createIntegrationKeySchema = z.object({
  name: z.string().trim().min(1).max(60),
});
export type CreateIntegrationKeyInput = z.infer<typeof createIntegrationKeySchema>;

/** Body of a signed lead intake request. Phone is normalised server-side (Indian numbers). */
export const leadIntakeSchema = z.object({
  externalId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(6).max(20),
  email: z.string().trim().email().max(120).optional(),
  language: z.enum(['en', 'kn']).optional(),
  interest: z.string().trim().max(120).optional(),
  message: z.string().trim().max(500).optional(),
  formKey: z.string().trim().max(60).optional(),
  /** Marketing consent is only recorded when the form shows this exact text and the customer ticks it. */
  consentMarketing: z.boolean().optional(),
  consentText: z.string().trim().max(500).optional(),
});
export type LeadIntakeInput = z.infer<typeof leadIntakeSchema>;

export interface IntegrationKeyDto {
  id: string;
  name: string;
  kind: 'lead_intake';
  keyId: string;
  lastFour: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedIntegrationKeyDto extends IntegrationKeyDto {
  /** Shown once at creation. Store it in the form script; it cannot be retrieved later. */
  secret: string;
}

export interface IntegrationsDto {
  intakeUrl: string;
  keys: IntegrationKeyDto[];
}
