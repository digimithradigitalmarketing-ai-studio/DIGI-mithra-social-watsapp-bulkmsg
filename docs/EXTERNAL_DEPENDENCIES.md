# What needs external accounts, credentials or approvals

Nothing below has been connected or approved yet. Everything in Phase 1 runs locally without any of it.

| Item | Needed for | Who/what | Status |
|---|---|---|---|
| Supabase project (Pro recommended for daily backups/PITR) | Staging & production DB + Auth | DigiMithra creates project, region **ap-south-1 (Mumbai)** | Not created. Supabase auth provider is implemented but **untested against a live project**. |
| Supabase Auth settings | Email verification, reset, TOTP MFA | Enable "Confirm email", enable TOTP MFA, set Site URL + redirect URLs | Pending |
| Custom SMTP for Supabase Auth (e.g. ZeptoMail, SES, Resend) | Reliable verification/reset emails | DigiMithra account + DNS (SPF/DKIM) | Pending; Supabase's built-in mailer is rate-limited and for testing only |
| Transactional email provider for invitations | Automatic invite emails | Same provider as above | Pending — today the inviter copies the one-time link |
| Render account (web static site, API web service, worker, Redis/Key Value) | Hosting | DigiMithra | Pending — `render.yaml` provided |
| GoDaddy DNS records | `socialpilot.` and `api.socialpilot.` subdomains | DigiMithra | Pending — see DEPLOYMENT.md |
| **Meta Business Portfolio** (business verification) | WhatsApp Cloud API | Gold Fitness first, then each customer | Required by Meta |
| **Meta developer app** with WhatsApp product | Cloud API access, webhooks | DigiMithra | Phase 2 |
| WABA + phone number + permanent **system-user token** (`whatsapp_business_messaging`, `whatsapp_business_management`) | Sending/receiving for the first test business (manual connection) | Gold Fitness' own WABA | Phase 2 |
| Message templates approved by Meta | Campaigns / outside the 24-hour window | Each business submits | Phase 2 |
| **Meta App Review + Tech Provider onboarding + Embedded Signup** | Self-serve onboarding of other businesses' WABAs | DigiMithra | **Not granted.** Architecture is prepared; do not market self-serve onboarding until approved. |
| Instagram Messaging (`instagram_manage_messages` via App Review) | Instagram inbox | DigiMithra | Phase 7, after approval |
| Google AI Studio / Vertex **Gemini API key** + billing | AI assistant | DigiMithra | Phase 5 |
| **Razorpay** account, KYC, Subscriptions enabled, plan IDs, webhook secret | Paid subscriptions | DigiMithra | Phase 6 |
| Google Cloud project (Sheets API, OAuth consent) | Sheets sync | DigiMithra | Phase 7 |
| Apps Script on Gold Fitness enquiry form | Lead capture | Gold Fitness | Phase 7 — will call a signed DigiMithra endpoint |
| Legal review of Terms/Privacy, DPDP Act consent notices, grievance officer | Launch | Lawyer | Draft pages exist and are marked as drafts |
| Native Kannada review | UI strings | Reviewer | Initial strings are drafts |
