import { describe, expect, it } from 'vitest';
import { can, invitableRoles, manageableRoles, normalizeIndianPhone, ROLE_PERMISSIONS } from '@socialpilot/shared';
import { decryptSecret, encryptSecret } from '../src/lib/crypto';
import { loadConfig } from '../src/config';

describe('shared helpers', () => {
  it('normalises Indian phone numbers to E.164', () => {
    expect(normalizeIndianPhone('98765 43210')).toBe('+919876543210');
    expect(normalizeIndianPhone('098765-43210')).toBe('+919876543210');
    expect(normalizeIndianPhone('+91 98765 43210')).toBe('+919876543210');
    expect(normalizeIndianPhone('919876543210')).toBe('+919876543210');
    expect(normalizeIndianPhone('12345')).toBeNull();
  });
  it('role matrix', () => {
    expect(can('agent', 'conversations.reply')).toBe(true);
    expect(can('agent', 'campaigns.manage')).toBe(false);
    expect(can('manager', 'billing.manage')).toBe(false);
    expect(can('owner', 'billing.manage')).toBe(true);
    expect(manageableRoles('manager')).toEqual(['agent']);
    expect(invitableRoles('agent')).toEqual([]);
    for (const p of ROLE_PERMISSIONS.manager) expect(ROLE_PERMISSIONS.owner).toContain(p);
    for (const p of ROLE_PERMISSIONS.agent) expect(ROLE_PERMISSIONS.manager).toContain(p);
  });
});

describe('credential encryption', () => {
  it('round-trips and detects tampering', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const box = encryptSecret('EAAG-meta-token-1234', key);
    expect(box.ciphertext).not.toContain('meta');
    expect(box.lastFour).toBe('1234');
    expect(decryptSecret(box, key)).toBe('EAAG-meta-token-1234');
    expect(() => decryptSecret({ ...box, ciphertext: Buffer.from('tampered').toString('base64') }, key)).toThrow();
  });
});

describe('production config guards', () => {
  it('refuses local auth, PGlite or disabled admin MFA in production', () => {
    expect(() => loadConfig({ APP_ENV: 'production', LOCAL_JWT_SECRET: 'x'.repeat(40) })).toThrow(/AUTH_PROVIDER/);
    expect(() =>
      loadConfig({ APP_ENV: 'production', AUTH_PROVIDER: 'supabase', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'k', DATABASE_DRIVER: 'pg', DATABASE_URL: 'postgres://x', ADMIN_REQUIRE_MFA: 'false', INTEGRATION_ENCRYPTION_KEY: 'k' }),
    ).toThrow(/ADMIN_REQUIRE_MFA/);
    expect(() =>
      loadConfig({ APP_ENV: 'production', AUTH_PROVIDER: 'supabase', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'k', DATABASE_DRIVER: 'pg', DATABASE_URL: 'postgres://x', INTEGRATION_ENCRYPTION_KEY: 'k', WORKER_IN_PROCESS: 'false', ALLOW_MOCK_WHATSAPP: 'false', AI_PROVIDER: 'disabled', BILLING_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'rzp_live_id', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' }),
    ).not.toThrow();
    // Billing must be live in production; mock billing would take no money.
    expect(() =>
      loadConfig({ APP_ENV: 'production', AUTH_PROVIDER: 'supabase', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'k', DATABASE_DRIVER: 'pg', DATABASE_URL: 'postgres://x', INTEGRATION_ENCRYPTION_KEY: 'k', WORKER_IN_PROCESS: 'false', ALLOW_MOCK_WHATSAPP: 'false', AI_PROVIDER: 'disabled' }),
    ).toThrow(/BILLING_PROVIDER/);
    expect(() =>
      loadConfig({ APP_ENV: 'production', AUTH_PROVIDER: 'supabase', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'k', DATABASE_DRIVER: 'pg', DATABASE_URL: 'postgres://x', INTEGRATION_ENCRYPTION_KEY: 'k', WORKER_IN_PROCESS: 'false' }),
    ).toThrow(/ALLOW_MOCK_WHATSAPP/);
  });
});
