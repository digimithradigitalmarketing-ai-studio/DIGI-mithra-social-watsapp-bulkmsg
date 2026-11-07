import { z } from 'zod';
import type { SubscriptionDto } from './types';

export const checkoutSchema = z.object({
  planCode: z.string().trim().min(1).max(40),
  billingCycle: z.enum(['monthly', 'annual']),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

export interface CheckoutDto {
  mode: 'mock' | 'live';
  /** Public Razorpay key id for the checkout widget. Never the key secret. */
  keyId: string | null;
  subscriptionId: string;
  shortUrl: string | null;
  planCode: string;
  billingCycle: 'monthly' | 'annual';
}

export interface InvoiceDto {
  number: string;
  status: 'draft' | 'issued' | 'paid' | 'void' | 'failed';
  currency: string;
  totalPaise: number;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface PaymentDto {
  status: 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';
  amountPaise: number;
  currency: string;
  method: string | null;
  failureReason: string | null;
  capturedAt: string | null;
  createdAt: string;
}

export interface BillingDto {
  mode: 'mock' | 'live';
  subscription: SubscriptionDto | null;
  pendingPlanCode: string | null;
  pendingBillingCycle: 'monthly' | 'annual' | null;
  cancelAtPeriodEnd: boolean;
  invoices: InvoiceDto[];
  payments: PaymentDto[];
}
