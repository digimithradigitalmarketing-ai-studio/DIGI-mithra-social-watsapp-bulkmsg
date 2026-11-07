import { z } from 'zod';

export const AI_TONES = ['friendly', 'professional', 'concise'] as const;

export const aiSettingsSchema = z.object({
  enabled: z.boolean(),
  autoReplyEnabled: z.boolean(),
  languages: z.array(z.enum(['en', 'kn'])).min(1, 'Choose at least one language'),
  tone: z.enum(AI_TONES),
  systemInstructions: z.string().trim().max(2000),
  handoffConfidenceThreshold: z.coerce.number().min(0.3).max(0.99),
  monthlyTokenLimit: z.coerce.number().int().min(0).max(100_000_000),
  monthlySpendLimitPaise: z.coerce.number().int().min(0).max(100_000_000),
  handoffKeywords: z.array(z.string().trim().min(1).max(40)).max(30),
  handoffNotifyUserIds: z.array(z.string().uuid()).max(20),
  maxAiRepliesPerConversation: z.coerce.number().int().min(1).max(50),
  onlyWhenUnassigned: z.boolean(),
}).partial();
export type AiSettingsInput = z.infer<typeof aiSettingsSchema>;

export const knowledgeSourceSchema = z.discriminatedUnion('sourceType', [
  z.object({ sourceType: z.literal('faq'), question: z.string().trim().min(3).max(300), answer: z.string().trim().min(1).max(2000), language: z.enum(['en', 'kn']).default('en') }),
  z.object({ sourceType: z.literal('text'), title: z.string().trim().min(2).max(120), content: z.string().trim().min(10).max(20_000), language: z.enum(['en', 'kn']).default('en') }),
]);
export type KnowledgeSourceInput = z.infer<typeof knowledgeSourceSchema>;

export const aiTestSchema = z.object({ question: z.string().trim().min(1).max(1000) });

export const aiContentSchema = z.object({
  kind: z.enum(['template_body', 'campaign_idea', 'rewrite']),
  prompt: z.string().trim().min(3).max(1000),
  language: z.enum(['en', 'kn']).default('en'),
  category: z.enum(['MARKETING', 'UTILITY']).default('MARKETING'),
});
export type AiContentInput = z.infer<typeof aiContentSchema>;

export interface AiSettingsDto {
  enabled: boolean;
  autoReplyEnabled: boolean;
  languages: Array<'en' | 'kn'>;
  tone: (typeof AI_TONES)[number];
  systemInstructions: string;
  handoffConfidenceThreshold: number;
  monthlyTokenLimit: number;
  monthlySpendLimitPaise: number;
  handoffKeywords: string[];
  handoffNotifyUserIds: string[];
  maxAiRepliesPerConversation: number;
  onlyWhenUnassigned: boolean;
  provider: 'gemini' | 'mock' | 'disabled';
  model: string;
  planTokenLimit: number;
}

export interface KnowledgeSourceDto { id: string; sourceType: 'faq' | 'text'; title: string; question: string | null; answer: string | null; content: string | null; language: string; status: 'active' | 'disabled'; updatedAt: string }

export interface AiAnswerDto {
  outcome: 'answered' | 'handoff' | 'blocked' | 'limit_reached' | 'error';
  answer: string | null;
  confidence: number;
  language: 'en' | 'kn';
  handoffReason: string | null;
  guards: string[];
  sources: Array<{ id: string; title: string }>;
  usage: { inputTokens: number; outputTokens: number; costPaise: number };
}

export interface AiUsageDto {
  month: { tokens: number; costPaise: number; tokenLimit: number | null; spendLimitPaise: number | null };
  outcomes: Record<string, number>;
  byFeature: Record<string, number>;
  daily: Array<{ date: string; tokens: number; answered: number; handoff: number }>;
}

export interface AiAuditDto { id: string; feature: string; outcome: string; confidence: number | null; model: string; question: string | null; answer: string | null; guards: string[]; handoffReason: string | null; contactName: string | null; conversationId: string | null; inputTokens: number; outputTokens: number; createdAt: string }
