-- ============================================================================
-- DigiMithra Social Pilot — 0009 Phase 6: Razorpay subscriptions
-- A plan change is only applied when Razorpay confirms the first charge
-- (webhook). Until then the workspace keeps its current plan and the new
-- one is held here as the pending plan.
-- ============================================================================
alter table public.subscriptions
  add column pending_plan_id uuid references public.subscription_plans(id),
  add column pending_billing_cycle text check (pending_billing_cycle in ('monthly', 'annual'));

-- invoices.razorpay_invoice_id and payments.provider_payment_id are unique already (0003).
