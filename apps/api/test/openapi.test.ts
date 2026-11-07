import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('OpenAPI spec', () => {
  it('parses and documents every Phase 1 route', () => {
    const spec = parse(fs.readFileSync(path.join(__dirname, '..', 'openapi.yaml'), 'utf8'));
    expect(spec.openapi).toBe('3.1.0');
    const paths = Object.keys(spec.paths);
    for (const p of ['/v1/auth/signup', '/v1/auth/login', '/v1/auth/refresh', '/v1/auth/mfa/verify', '/v1/me', '/v1/businesses',
      '/v1/businesses/{businessId}/members/{memberId}', '/v1/businesses/{businessId}/invitations', '/v1/invitations/accept',
      '/v1/businesses/{businessId}/dashboard', '/v1/admin/overview', '/v1/admin/businesses/{businessId}/suspend', '/v1/admin/plans/{planId}',
      '/v1/businesses/{businessId}/channels/whatsapp', '/v1/businesses/{businessId}/contacts/import', '/v1/businesses/{businessId}/templates/{templateId}/submit',
      '/v1/businesses/{businessId}/campaigns/{campaignId}/schedule', '/v1/webhooks/meta', '/v1/admin/queue',
      '/v1/businesses/{businessId}/conversations/{conversationId}/messages', '/v1/businesses/{businessId}/leads/{leadId}', '/v1/businesses/{businessId}/tasks', '/v1/businesses/{businessId}/reports',
      '/v1/businesses/{businessId}/automations/{workflowId}/publish', '/v1/businesses/{businessId}/automation-executions/{executionId}/retry',
      '/v1/businesses/{businessId}/ai/settings', '/v1/businesses/{businessId}/conversations/{conversationId}/ai-suggest',
      '/v1/businesses/{businessId}/billing', '/v1/businesses/{businessId}/billing/checkout', '/v1/webhooks/razorpay',
      '/v1/businesses/{businessId}/integrations', '/v1/integrations/lead-intake'])
      expect(paths).toContain(p);
  });
});
