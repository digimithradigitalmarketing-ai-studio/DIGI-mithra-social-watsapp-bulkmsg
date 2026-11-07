import { z } from 'zod';
import { emailSchema, normalizeIndianPhone } from './schemas';

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------
export const phoneInputSchema = z
  .string()
  .trim()
  .min(1, 'Enter a phone number')
  .transform((v, ctx) => {
    const n = normalizeIndianPhone(v);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number, e.g. +91 98765 43210' });
      return z.NEVER;
    }
    return n;
  });

// ---------------------------------------------------------------------------
// Personalisation variables
// ---------------------------------------------------------------------------
/** Built-in placeholders. Any other {{key}} is read from the contact's custom fields. */
export const BUILTIN_VARIABLES = {
  customer_name: 'Contact name',
  business_name: 'Your business name',
  customer_phone: 'Contact phone',
} as const;
export const SUGGESTED_CUSTOM_VARIABLES = ['membership_expiry', 'payment_due', 'offer_name'] as const;

const VAR_RE = /\{\{\s*([a-z][a-z0-9_]{0,40})\s*\}\}/g;

/** Extract {{named}} placeholders in order of first appearance. */
export function extractVariables(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(VAR_RE)) if (!seen.includes(m[1]!)) seen.push(m[1]!);
  return seen;
}

/** Convert `Hi {{customer_name}}` into Meta's positional `Hi {{1}}` and the mapping {"1": "customer_name"}. */
export function toPositional(text: string): { text: string; mapping: Record<string, string> } {
  const vars = extractVariables(text);
  const mapping: Record<string, string> = {};
  vars.forEach((v, i) => (mapping[String(i + 1)] = v));
  const out = text.replace(VAR_RE, (_m, name: string) => `{{${vars.indexOf(name) + 1}}}`);
  return { text: out, mapping };
}

/** Render positional body text with values (used for previews and message history). */
export function renderPositional(text: string, values: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => values[Number(n) - 1] ?? `{{${n}}}`);
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------
export const CONSENT_PURPOSES = ['marketing', 'utility'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const consentCaptureSchema = z.object({
  purpose: z.enum(CONSENT_PURPOSES),
  status: z.enum(['granted', 'revoked']),
  source: z.string().trim().min(3, 'Describe where consent was captured').max(120),
  note: z.string().trim().max(500).optional(),
});
export type ConsentCaptureInput = z.infer<typeof consentCaptureSchema>;

const customFieldsSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), z.string().max(500));

export const createContactSchema = z.object({
  name: z.string().trim().max(120).default(''),
  phone: phoneInputSchema,
  email: z.union([emailSchema, z.literal('')]).optional().transform((v) => v || undefined),
  language: z.enum(['en', 'kn']).default('en'),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('').transform(() => undefined)),
  tagIds: z.array(z.string().uuid()).max(50).default([]),
  customFields: customFieldsSchema.default({}),
  consent: z
    .object({
      marketing: z.boolean().default(false),
      utility: z.boolean().default(false),
      source: z.string().trim().max(120).default(''),
    })
    .refine((c) => !(c.marketing || c.utility) || c.source.length >= 3, { message: 'Describe where consent was captured', path: ['source'] })
    .optional(),
});
export type CreateContactInput = z.input<typeof createContactSchema>;

export const updateContactSchema = z
  .object({
    name: z.string().trim().max(120),
    email: z.union([emailSchema, z.literal('')]).nullable(),
    language: z.enum(['en', 'kn']),
    birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    customFields: customFieldsSchema,
    assignedTo: z.string().uuid().nullable(),
  })
  .partial();

export const contactListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  tagId: z.string().uuid().optional(),
  consent: z.enum(['marketing', 'none', 'opted_out']).optional(),
  archived: z.enum(['true', 'false']).default('false'),
});

export const tagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2f6bff'),
});

export const bulkTagSchema = z.object({
  contactIds: z.array(z.string().uuid()).min(1).max(1000),
  tagId: z.string().uuid(),
  action: z.enum(['add', 'remove']),
});

export const IMPORT_FIELDS = ['name', 'phone', 'email', 'language', 'birthday', 'tags'] as const;

export const contactImportSchema = z.object({
  csv: z.string().min(1, 'The file is empty').max(5_000_000, 'Files up to 5 MB are supported'),
  /** CSV column header -> contact field ('name' | 'phone' | ... | 'custom:<key>' | 'ignore') */
  mapping: z.record(z.string(), z.string().regex(/^(name|phone|email|language|birthday|tags|ignore|custom:[a-z][a-z0-9_]{0,40})$/)),
  onDuplicate: z.enum(['update', 'skip']).default('update'),
  tagIds: z.array(z.string().uuid()).max(20).default([]),
  consent: z
    .object({
      marketing: z.boolean(),
      utility: z.boolean().default(false),
      source: z.string().trim().max(120),
      confirmed: z.boolean(),
    })
    .refine((c) => !(c.marketing || c.utility) || (c.confirmed && c.source.length >= 3), {
      message: 'Confirm consent and describe where it was collected',
      path: ['source'],
    }),
});
export type ContactImportInput = z.input<typeof contactImportSchema>;

// ---------------------------------------------------------------------------
// Channel connection
// ---------------------------------------------------------------------------
export const connectWhatsAppSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('mock'), displayPhoneNumber: z.string().trim().max(20).optional() }),
  z.object({
    mode: z.literal('meta'),
    wabaId: z.string().trim().regex(/^\d{5,25}$/, 'WABA ID is a number from Meta Business Manager'),
    phoneNumberId: z.string().trim().regex(/^\d{5,25}$/, 'Phone number ID is a number from the WhatsApp Manager / API setup page'),
    accessToken: z.string().trim().min(20, 'Paste the permanent system-user access token').max(1000),
  }),
]);
export type ConnectWhatsAppInput = z.infer<typeof connectWhatsAppSchema>;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
export const TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY'] as const;
export const TEMPLATE_LANGUAGES = { en: 'English', en_US: 'English (US)', kn: 'Kannada', hi: 'Hindi' } as const;

export const createTemplateSchema = z
  .object({
    name: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, 'Use lowercase letters, numbers and underscores'),
    language: z.enum(Object.keys(TEMPLATE_LANGUAGES) as [keyof typeof TEMPLATE_LANGUAGES]),
    category: z.enum(TEMPLATE_CATEGORIES),
    headerText: z.string().trim().max(60).optional().transform((v) => v || undefined),
    body: z.string().trim().min(1, 'Write the message body').max(1024),
    footerText: z.string().trim().max(60).optional().transform((v) => v || undefined),
    /** Example value for every {{variable}} (Meta requires samples for review). */
    examples: z.record(z.string(), z.string().trim().min(1).max(200)).default({}),
  })
  .superRefine((t, ctx) => {
    if (t.headerText && /\{\{/.test(t.headerText))
      ctx.addIssue({ code: 'custom', path: ['headerText'], message: 'Variables are only supported in the body for now' });
    for (const v of extractVariables(t.body))
      if (!t.examples[v]) ctx.addIssue({ code: 'custom', path: ['examples', v], message: `Add an example for {{${v}}}` });
    if (/^\s*\{\{|\}\}\s*$/.test(t.body))
      ctx.addIssue({ code: 'custom', path: ['body'], message: 'Meta does not allow the body to start or end with a variable' });
  });
export type CreateTemplateInput = z.input<typeof createTemplateSchema>;

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------
export const campaignAudienceSchema = z.object({
  type: z.enum(['all', 'tags']),
  tagIds: z.array(z.string().uuid()).max(20).default([]),
});

export const createCampaignSchema = z.object({
  name: z.string().trim().min(2).max(120),
  templateId: z.string().uuid(),
  audience: campaignAudienceSchema.refine((a) => a.type === 'all' || a.tagIds.length > 0, { message: 'Choose at least one tag', path: ['tagIds'] }),
  /** Fallback/static values for template variables, e.g. {"offer_name": "Diwali 20% off"} */
  variableDefaults: z.record(z.string(), z.string().trim().max(200)).default({}),
});
export type CreateCampaignInput = z.input<typeof createCampaignSchema>;

export const scheduleCampaignSchema = z.object({
  /** ISO timestamp; omit to send now */
  scheduledAt: z.string().datetime({ offset: true }).optional(),
});

export const SKIP_REASONS: Record<string, string> = {
  no_consent: 'No consent for this message category',
  opted_out: 'Contact opted out',
  suppressed: 'On suppression list',
  missing_variable: 'Missing personalisation value',
  messaging_limit: 'Over WhatsApp messaging limit',
  archived: 'Contact archived',
  cancelled: 'Campaign cancelled',
};

export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'processing', 'paused', 'completed', 'partially_completed', 'failed', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------
export interface TagDto { id: string; name: string; color: string; contactCount: number }

export interface ContactDto {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  language: 'en' | 'kn';
  birthday: string | null;
  source: string;
  customFields: Record<string, string>;
  tags: Array<{ id: string; name: string; color: string }>;
  marketingOptIn: boolean;
  marketingConsentAt: string | null;
  marketingConsentSource: string | null;
  utilityOptIn: boolean;
  optedOutAt: string | null;
  lastContactedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface ConsentRecordDto { id: string; purpose: string; status: string; source: string; evidence: Record<string, unknown>; capturedBy: string | null; occurredAt: string }
export interface TimelineMessageDto { id: string; direction: 'inbound' | 'outbound'; type: string; body: string | null; status: string; campaignName: string | null; errorCode: string | null; createdAt: string }

export interface ImportResultDto { totalRows: number; created: number; updated: number; skipped: number; errors: Array<{ row: number; message: string }> }

export interface ChannelDto {
  id: string;
  mode: 'mock' | 'meta';
  status: 'pending' | 'connected' | 'error' | 'disconnected';
  name: string;
  wabaId: string;
  lastError: string | null;
  connectedAt: string | null;
  tokenLastFour: string | null;
  phoneNumbers: Array<{ id: string; phoneNumberId: string; displayPhoneNumber: string; verifiedName: string | null; qualityRating: string | null; messagingLimitTier: string | null; status: string }>;
  webhook: { callbackUrl: string; verifyTokenConfigured: boolean; appSecretConfigured: boolean };
}

export interface TemplateDto {
  id: string;
  name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  status: 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED';
  provider: 'meta_cloud' | 'mock';
  headerText: string | null;
  body: string; // with named placeholders, e.g. Hi {{customer_name}}
  footerText: string | null;
  variables: string[];
  examples: Record<string, string>;
  rejectionReason: string | null;
  submittedAt: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
}

export interface CampaignStatsDto { total: number; skipped: number; pending: number; queued: number; sent: number; delivered: number; read: number; replied: number; failed: number }

export interface CampaignDto {
  id: string;
  name: string;
  status: CampaignStatus;
  template: { id: string; name: string; category: string; language: string; status: string } | null;
  audience: { type: 'all' | 'tags'; tagIds: string[] };
  variableDefaults: Record<string, string>;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  createdByName: string | null;
  stats: CampaignStatsDto;
}

export interface CampaignPreviewDto {
  audienceSize: number;
  eligible: number;
  skipped: Record<string, number>;
  sample: Array<{ contactName: string; phone: string; rendered: string }>;
  blockers: string[];
  warnings: string[];
  limits: { messagingTier: string | null; tierCapacity: number | null; usedLast24h: number; broadcastsThisMonth: number; broadcastsLimit: number | null };
}

export interface CampaignRecipientDto { id: string; contactId: string; contactName: string; phone: string; status: string; skipReason: string | null; errorCode: string | null; errorMessage: string | null; attempts: number; sentAt: string | null; deliveredAt: string | null; readAt: string | null; repliedAt: string | null }

// ---------------------------------------------------------------------------
// Phase 3: inbox & CRM DTOs
// ---------------------------------------------------------------------------
export interface ConversationDto {
  id: string;
  status: 'open' | 'pending' | 'closed';
  contact: { id: string; name: string; phone: string; optedOut: boolean };
  assignedTo: { id: string; name: string } | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastInboundAt: string | null;
  windowExpiresAt: string | null;
  windowOpen: boolean;
  unreadCount: number;
  tags: string[];
  /** Set when the AI assistant handed this conversation to the team */
  aiHandoffReason: string | null;
  createdAt: string;
}
export interface InboxMessageDto { id: string; direction: 'inbound' | 'outbound'; type: string; body: string | null; status: string; errorCode: string | null; errorMessage: string | null; sentByName: string | null; campaignName: string | null; createdAt: string }
export interface ConversationDetailDto { conversation: ConversationDto; contact: ContactDto; messages: InboxMessageDto[]; notes: Array<{ id: string; body: string; authorName: string | null; createdAt: string }> }
export interface InboxCountsDto { all: number; mine: number; unassigned: number; unread: number }
export interface CannedReplyDto { id: string; shortcut: string; title: string; body: string }

export interface PipelineDto { id: string; name: string; isDefault: boolean; stages: Array<{ id: string; name: string; position: number; isWon: boolean; isLost: boolean }> }
export interface LeadDto {
  id: string;
  title: string;
  contact: { id: string; name: string; phone: string };
  pipelineId: string | null;
  stageId: string | null;
  status: 'open' | 'won' | 'lost';
  source: string;
  valuePaise: number | null;
  assignedTo: { id: string; name: string } | null;
  expectedCloseDate: string | null;
  lostReason: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}
export const LEAD_SOURCES = ['walk_in', 'phone_call', 'whatsapp', 'website', 'enquiry_form', 'instagram', 'referral', 'campaign', 'manual', 'other'] as const;

export const createLeadSchema = z.object({
  contactId: z.string().uuid(),
  title: z.string().trim().min(2).max(120),
  source: z.string().trim().max(40).default('manual'),
  stageId: z.string().uuid().optional(),
  valueRupees: z.coerce.number().min(0).max(10_000_000).optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  expectedCloseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('').transform(() => undefined)),
  notes: z.string().trim().max(2000).default(''),
});
export type CreateLeadInput = z.input<typeof createLeadSchema>;

export const updateLeadSchema = z.object({
  title: z.string().trim().min(2).max(120),
  stageId: z.string().uuid(),
  source: z.string().trim().max(40),
  valueRupees: z.coerce.number().min(0).max(10_000_000).nullable(),
  assignedTo: z.string().uuid().nullable(),
  expectedCloseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  lostReason: z.string().trim().max(300).nullable(),
  notes: z.string().trim().max(2000),
}).partial();

export interface TaskDto {
  id: string;
  title: string;
  description: string;
  dueAt: string | null;
  status: 'open' | 'done' | 'cancelled';
  overdue: boolean;
  contact: { id: string; name: string; phone: string } | null;
  leadId: string | null;
  conversationId: string | null;
  assignedTo: { id: string; name: string } | null;
  completedAt: string | null;
  createdAt: string;
}
export const createTaskSchema = z.object({
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(2000).default(''),
  dueAt: z.string().datetime({ offset: true }).optional(),
  contactId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  assignedTo: z.string().uuid().nullable().optional(),
});
export type CreateTaskInput = z.input<typeof createTaskSchema>;
export const updateTaskSchema = z.object({
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(2000),
  dueAt: z.string().datetime({ offset: true }).nullable(),
  status: z.enum(['open', 'done', 'cancelled']),
  assignedTo: z.string().uuid().nullable(),
}).partial();

export interface ReportsDto {
  range: { from: string; to: string };
  conversations: { started: number; closed: number; inbound: number; outbound: number; medianFirstResponseMinutes: number | null; openNow: number; unassignedNow: number };
  leads: { created: number; won: number; lost: number; wonValuePaise: number; byStage: Array<{ stage: string; count: number }>; bySource: Array<{ source: string; count: number; won: number }> };
  campaigns: { count: number; sent: number; delivered: number; read: number; replied: number; failed: number };
  team: Array<{ userId: string; name: string; role: string; replies: number; conversationsAssigned: number; medianFirstResponseMinutes: number | null; tasksDone: number; leadsWon: number }>;
  daily: Array<{ date: string; inbound: number; outbound: number; leads: number }>;
}
