import { z } from 'zod';

// ---------------------------------------------------------------------------
// Workflow definition: Trigger → steps (actions, waits, branches)
// ---------------------------------------------------------------------------
export const TRIGGER_TYPES = [
  'enquiry_submitted', 'website_form_submitted', 'contact_created', 'tag_added', 'customer_replied',
  'lead_stage_changed', 'membership_expiring', 'payment_due', 'birthday', 'scheduled',
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const TRIGGER_LABELS: Record<TriggerType, { label: string; description: string; kind: 'event' | 'date' | 'schedule' }> = {
  enquiry_submitted: { label: 'New enquiry submitted', description: 'A gym enquiry arrives from your enquiry form (Integrations API, Phase 7) or a test run.', kind: 'event' },
  website_form_submitted: { label: 'Website form submitted', description: 'A website form posts a lead (Integrations API, Phase 7) or a test run.', kind: 'event' },
  contact_created: { label: 'Contact created', description: 'A contact is added manually, imported or messages you for the first time.', kind: 'event' },
  tag_added: { label: 'Tag added', description: 'A specific tag is added to a contact.', kind: 'event' },
  customer_replied: { label: 'Customer sends a message', description: 'An incoming WhatsApp message, optionally containing keywords.', kind: 'event' },
  lead_stage_changed: { label: 'Lead stage changed', description: 'A lead is created in or moved to a stage.', kind: 'event' },
  membership_expiring: { label: 'Membership approaching expiry', description: 'N days before the date in a contact field (e.g. membership_expiry).', kind: 'date' },
  payment_due: { label: 'Payment due', description: 'N days before the date in a contact field (e.g. payment_due).', kind: 'date' },
  birthday: { label: 'Birthday', description: "On the contact's birthday.", kind: 'date' },
  scheduled: { label: 'Scheduled date / time', description: 'Once at a date and time, or every day, for all contacts or tagged contacts.', kind: 'schedule' },
};

const hour = z.coerce.number().int().min(0).max(23);
const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, 'Use a custom field key like membership_expiry');

export const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('enquiry_submitted'), config: z.object({ formKey: z.string().max(60).optional() }).default({}) }),
  z.object({ type: z.literal('website_form_submitted'), config: z.object({ formKey: z.string().max(60).optional() }).default({}) }),
  z.object({ type: z.literal('contact_created'), config: z.object({ source: z.string().max(40).optional() }).default({}) }),
  z.object({ type: z.literal('tag_added'), config: z.object({ tagId: z.string().uuid({ message: 'Choose a tag' }) }) }),
  z.object({ type: z.literal('customer_replied'), config: z.object({ keywords: z.array(z.string().trim().min(1).max(40)).max(20).default([]) }).default({ keywords: [] }) }),
  z.object({ type: z.literal('lead_stage_changed'), config: z.object({ stageId: z.string().uuid().optional() }).default({}) }),
  z.object({ type: z.literal('membership_expiring'), config: z.object({ field: fieldKey.default('membership_expiry'), daysBefore: z.coerce.number().int().min(0).max(90).default(7), hour: hour.default(9) }) }),
  z.object({ type: z.literal('payment_due'), config: z.object({ field: fieldKey.default('payment_due'), daysBefore: z.coerce.number().int().min(0).max(90).default(1), hour: hour.default(9) }) }),
  z.object({ type: z.literal('birthday'), config: z.object({ hour: hour.default(9) }).default({ hour: 9 }) }),
  z.object({
    type: z.literal('scheduled'),
    config: z.object({
      mode: z.enum(['once', 'daily']),
      at: z.string().datetime({ offset: true }).optional(),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM').optional(),
      audience: z.object({ type: z.enum(['all', 'tags']), tagIds: z.array(z.string().uuid()).max(20).default([]) }),
    }).refine((c) => (c.mode === 'once' ? !!c.at : !!c.time), { message: 'Choose when it should run', path: ['at'] }),
  }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

export const conditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('has_tag'), tagId: z.string().uuid() }),
  z.object({ kind: z.literal('marketing_consent') }),
  z.object({ kind: z.literal('field_equals'), field: fieldKey, value: z.string().max(200) }),
  z.object({ kind: z.literal('field_present'), field: fieldKey }),
  z.object({ kind: z.literal('message_contains'), keywords: z.array(z.string().trim().min(1).max(40)).min(1).max(20) }),
  z.object({ kind: z.literal('replied_since_start') }),
  z.object({ kind: z.literal('language_is'), language: z.enum(['en', 'kn']) }),
]);
export type Condition = z.infer<typeof conditionSchema>;

const id = z.string().min(1).max(40);
const actionSchemas = [
  z.object({ id, type: z.literal('send_template'), config: z.object({ templateId: z.string().uuid({ message: 'Choose an approved template' }), defaults: z.record(z.string(), z.string().max(200)).default({}) }) }),
  z.object({ id, type: z.literal('assign_conversation'), config: z.object({ userId: z.string().uuid({ message: 'Choose a team member' }) }) }),
  z.object({ id, type: z.literal('create_lead'), config: z.object({ title: z.string().trim().min(2).max(120), source: z.string().max(40).default('automation'), stageId: z.string().uuid().optional(), assignTo: z.string().uuid().optional() }) }),
  z.object({ id, type: z.literal('create_task'), config: z.object({ title: z.string().trim().min(2).max(160), dueInHours: z.coerce.number().int().min(0).max(24 * 90).default(24), assignTo: z.string().uuid().optional() }) }),
  z.object({ id, type: z.literal('add_tag'), config: z.object({ tagId: z.string().uuid({ message: 'Choose a tag' }) }) }),
  z.object({ id, type: z.literal('remove_tag'), config: z.object({ tagId: z.string().uuid({ message: 'Choose a tag' }) }) }),
  z.object({ id, type: z.literal('notify_staff'), config: z.object({ userIds: z.array(z.string().uuid()).min(1, 'Choose who to notify').max(20), message: z.string().trim().min(2).max(500) }) }),
  z.object({ id, type: z.literal('update_field'), config: z.object({ field: fieldKey, value: z.string().max(500) }) }),
  z.object({ id, type: z.literal('wait'), config: z.object({ amount: z.coerce.number().int().min(1).max(10_000), unit: z.enum(['minutes', 'hours', 'days']) })
    .refine((w) => w.amount * ({ minutes: 1, hours: 60, days: 1440 } as const)[w.unit] <= 90 * 1440, { message: 'Wait at most 90 days' }) }),
  z.object({ id, type: z.literal('ai_reply_suggestion'), config: z.object({}).default({}) }),
] as const;

export type ActionStep = z.infer<(typeof actionSchemas)[number]>;
export type BranchStep = { id: string; type: 'branch'; config: { condition: Condition }; yes: Step[]; no: Step[] };
export type Step = ActionStep | BranchStep;
export type StepType = Step['type'];

export const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.union([
    ...actionSchemas,
    z.object({ id, type: z.literal('branch'), config: z.object({ condition: conditionSchema }), yes: z.array(stepSchema).max(30), no: z.array(stepSchema).max(30) }),
  ]),
) as z.ZodType<Step>;

export const definitionSchema = z.object({
  trigger: triggerSchema,
  steps: z.array(stepSchema).max(50),
  /** How often the same contact may enter the workflow (event triggers). */
  reentry: z.enum(['once', 'daily', 'always']).default('daily'),
});
export type WorkflowDefinition = z.infer<typeof definitionSchema>;

export const STEP_LABELS: Record<StepType, string> = {
  send_template: 'Send WhatsApp template',
  assign_conversation: 'Assign conversation',
  create_lead: 'Create lead',
  create_task: 'Create follow-up task',
  add_tag: 'Add tag',
  remove_tag: 'Remove tag',
  notify_staff: 'Notify staff',
  update_field: 'Update contact field',
  wait: 'Wait',
  branch: 'If / else',
  ai_reply_suggestion: 'AI reply suggestion (Phase 5)',
};

/** Walk every step (depth-first), with nesting depth. */
export function walkSteps(steps: Step[], fn: (s: Step, depth: number) => void, depth = 0) {
  for (const s of steps) {
    fn(s, depth);
    if (s.type === 'branch') {
      walkSteps(s.yes, fn, depth + 1);
      walkSteps(s.no, fn, depth + 1);
    }
  }
}

export const createWorkflowSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).default(''),
  templateKey: z.string().max(60).optional(),
});

export const saveDraftSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  definition: z.unknown(),
});

// ---------------------------------------------------------------------------
// Ready-made workflows for gyms (Gold Fitness Kengeri). Template / tag / user
// pickers are left empty; publishing validates that they are filled in.
// ---------------------------------------------------------------------------
export interface WorkflowTemplate { key: string; name: string; description: string; definition: Omit<WorkflowDefinition, 'steps'> & { steps: unknown[] } }

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    key: 'gym_enquiry_ack',
    name: 'New gym enquiry acknowledgement',
    description: 'Thank the enquirer on WhatsApp, open a lead and remind reception to call within 2 hours.',
    definition: { reentry: 'once', trigger: { type: 'enquiry_submitted', config: {} }, steps: [
      { id: 's1', type: 'send_template', config: { templateId: '', defaults: {} } },
      { id: 's2', type: 'create_lead', config: { title: 'Gym membership enquiry', source: 'enquiry_form' } },
      { id: 's3', type: 'create_task', config: { title: 'Call new enquiry', dueInHours: 2 } },
    ] },
  },
  {
    key: 'membership_renewal',
    name: 'Membership renewal reminder',
    description: '7 days before membership_expiry: send a renewal reminder; if they have not replied in 3 days, create a call task.',
    definition: { reentry: 'daily', trigger: { type: 'membership_expiring', config: { field: 'membership_expiry', daysBefore: 7, hour: 9 } }, steps: [
      { id: 's1', type: 'send_template', config: { templateId: '', defaults: {} } },
      { id: 's2', type: 'wait', config: { amount: 3, unit: 'days' } },
      { id: 's3', type: 'branch', config: { condition: { kind: 'replied_since_start' } }, yes: [], no: [
        { id: 's4', type: 'create_task', config: { title: 'Call about membership renewal', dueInHours: 4 } },
      ] },
    ] },
  },
  {
    key: 'payment_due',
    name: 'Payment due notification',
    description: '1 day before payment_due: send a utility reminder.',
    definition: { reentry: 'daily', trigger: { type: 'payment_due', config: { field: 'payment_due', daysBefore: 1, hour: 10 } }, steps: [
      { id: 's1', type: 'send_template', config: { templateId: '', defaults: {} } },
    ] },
  },
  {
    key: 'birthday',
    name: 'Birthday greeting',
    description: 'Send a birthday wish at 8am on the member’s birthday.',
    definition: { reentry: 'daily', trigger: { type: 'birthday', config: { hour: 8 } }, steps: [
      { id: 's1', type: 'send_template', config: { templateId: '', defaults: {} } },
    ] },
  },
  {
    key: 'holiday',
    name: 'Gym holiday announcement',
    description: 'Send a holiday notice once, to members with a tag (marketing consent required).',
    definition: { reentry: 'once', trigger: { type: 'scheduled', config: { mode: 'once', audience: { type: 'tags', tagIds: [] } } }, steps: [
      { id: 's1', type: 'send_template', config: { templateId: '', defaults: {} } },
    ] },
  },
  {
    key: 'pt_followup',
    name: 'Personal training enquiry follow-up',
    description: 'When a customer mentions PT or personal training: tag them, open a lead and assign a trainer.',
    definition: { reentry: 'daily', trigger: { type: 'customer_replied', config: { keywords: ['personal training', 'pt', 'trainer'] } }, steps: [
      { id: 's1', type: 'add_tag', config: { tagId: '' } },
      { id: 's2', type: 'create_lead', config: { title: 'Personal training enquiry', source: 'whatsapp' } },
      { id: 's3', type: 'assign_conversation', config: { userId: '' } },
      { id: 's4', type: 'notify_staff', config: { userIds: [], message: 'New personal training enquiry on WhatsApp' } },
    ] },
  },
  {
    key: 'satisfaction_survey',
    name: 'Customer satisfaction survey',
    description: '7 days after a lead is won, ask how their first week went.',
    definition: { reentry: 'once', trigger: { type: 'lead_stage_changed', config: {} }, steps: [
      { id: 's1', type: 'wait', config: { amount: 7, unit: 'days' } },
      { id: 's2', type: 'send_template', config: { templateId: '', defaults: {} } },
    ] },
  },
];

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------
export interface WorkflowDto {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'published' | 'paused' | 'archived';
  triggerType: TriggerType;
  draft: WorkflowDefinition | null;
  published: { versionId: string; version: number; definition: WorkflowDefinition; publishedAt: string | null } | null;
  hasUnpublishedChanges: boolean;
  stats: { running: number; waiting: number; completed: number; failed: number };
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionDto {
  id: string;
  workflowId: string;
  workflowName: string;
  version: number;
  contact: { id: string; name: string; phone: string } | null;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  error: string | null;
  trigger: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
  nextRunAt: string | null;
  steps?: Array<{ id: string; nodeId: string; type: string; status: string; output: unknown; error: string | null; attempts: number; startedAt: string | null; finishedAt: string | null }>;
}

export interface NotificationDto { id: string; title: string; body: string; link: string | null; readAt: string | null; createdAt: string }
