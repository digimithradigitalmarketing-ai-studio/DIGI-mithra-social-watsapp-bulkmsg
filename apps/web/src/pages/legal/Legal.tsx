import { Link } from 'react-router';
import { Logo } from '@/components/Logo';

function LegalLayout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-full bg-background">
      <header className="border-b bg-card"><div className="mx-auto flex h-16 max-w-3xl items-center px-6"><Link to="/"><Logo /></Link></div></header>
      <main className="mx-auto max-w-3xl px-6 py-10">
        <div className="mb-6 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Draft for review — this document must be reviewed by a qualified lawyer before public launch.
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <div className="mt-6 space-y-4 text-sm leading-relaxed text-muted-foreground [&_h2]:mt-8 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground">{children}</div>
      </main>
    </div>
  );
}

export function Privacy() {
  return (
    <LegalLayout title="Privacy Policy">
      <p>DigiMithra ("we") operates DigiMithra Social Pilot. This policy explains how we process personal data, including under India's Digital Personal Data Protection Act, 2023 (DPDP Act).</p>
      <h2>Roles</h2>
      <p>For your account details we are the Data Fiduciary. For the customer data a business uploads or receives through Social Pilot (contacts, messages), the business is the Data Fiduciary and DigiMithra processes that data on its behalf.</p>
      <h2>Data we process</h2>
      <p>Account data (name, email, hashed password), workspace data (business profile, team members), customer data supplied by businesses (names, phone numbers, consent records, conversations), and technical logs (IP address, device, audit events).</p>
      <h2>Purpose and consent</h2>
      <p>Businesses must obtain and record valid consent before sending marketing messages. Social Pilot stores consent source, purpose and timestamp, honours STOP/unsubscribe requests and maintains suppression lists.</p>
      <h2>WhatsApp and AI</h2>
      <p>Messages are sent through the official Meta WhatsApp Business Platform. When AI features are enabled, message content may be processed by our configured AI provider solely to provide the service; it is not used to train third-party models.</p>
      <h2>Security and retention</h2>
      <p>Data is isolated per workspace, encrypted in transit, and third-party credentials are encrypted at rest. Data is retained while the workspace is active and deleted or anonymised after closure according to the retention schedule.</p>
      <h2>Your rights</h2>
      <p>You may request access, correction, erasure and grievance redressal by writing to privacy@digimithra.co.in.</p>
    </LegalLayout>
  );
}

export function Terms() {
  return (
    <LegalLayout title="Terms of Service">
      <p>These terms govern use of DigiMithra Social Pilot ("Service") provided by DigiMithra.</p>
      <h2>Accounts and workspaces</h2>
      <p>You are responsible for your account credentials and for actions taken by staff you invite to your workspace.</p>
      <h2>Acceptable use</h2>
      <p>You must comply with the WhatsApp Business Terms of Service, WhatsApp Business Messaging Policy and Commerce Policy, and applicable law. You may only message people who have opted in, must honour opt-outs, and must not send spam or prohibited content. We may suspend workspaces that violate these rules.</p>
      <h2>Fees</h2>
      <p>Subscription fees cover DigiMithra software only. WhatsApp conversation/message charges from Meta are separate and are passed through or billed as described in your plan.</p>
      <h2>No guarantee of third-party approvals</h2>
      <p>Access to WhatsApp, Instagram and other third-party platforms depends on those providers' approvals, which DigiMithra does not control.</p>
      <h2>Contact</h2>
      <p>support@digimithra.co.in</p>
    </LegalLayout>
  );
}
