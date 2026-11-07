import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { useAuth } from '@/lib/auth';
import { Skeleton } from '@/components/ui/misc';
import { AppShell } from '@/components/layout/AppShell';
import Login from '@/pages/auth/Login';
import Signup from '@/pages/auth/Signup';
import { AcceptInvite, ForgotPassword, ResetPassword, VerifyEmail } from '@/pages/auth/Recovery';
import Onboarding from '@/pages/Onboarding';
import Dashboard from '@/pages/app/Dashboard';
import ComingSoon from '@/pages/app/ComingSoon';
import BusinessProfile from '@/pages/app/settings/BusinessProfile';
import Team from '@/pages/app/settings/Team';
import { AccountPage, ActivityPage, RolesPage, SubscriptionPage } from '@/pages/app/settings/Other';
import { AdminAudit, AdminBusinesses, AdminOverview, AdminPlans, AdminSettings, AdminShell } from '@/pages/admin/Admin';
import { Privacy, Terms } from '@/pages/legal/Legal';
import Connection from '@/pages/app/whatsapp/Connection';
import Contacts from '@/pages/app/contacts/Contacts';
import ContactDetail from '@/pages/app/contacts/ContactDetail';
import ImportContacts from '@/pages/app/contacts/Import';
import Tags from '@/pages/app/contacts/Tags';
import Templates, { NewTemplate } from '@/pages/app/templates/Templates';
import CampaignList, { CampaignDetail, NewCampaign } from '@/pages/app/campaigns/Campaigns';
import { AdminQueue } from '@/pages/admin/Queue';
import Inbox from '@/pages/app/inbox/Inbox';
import { CannedReplies, Pipeline, Reports, Tasks } from '@/pages/app/crm/Crm';
import Automations, { Executions } from '@/pages/app/automation/Automations';
import Builder from '@/pages/app/automation/Builder';
import { AiSupport, AiUsage, Handoff, Knowledge } from '@/pages/app/ai/Ai';

function FullPageLoader() {
  return <div className="flex h-full items-center justify-center" aria-busy="true"><Skeleton className="size-12 rounded-full" /></div>;
}

function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullPageLoader />;
  if (status === 'anonymous') return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <Outlet />;
}

function GuestOnly() {
  const { status } = useAuth();
  if (status === 'loading') return <FullPageLoader />;
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return <Outlet />;
}

function Home() {
  const { me } = useAuth();
  if (!me) return <FullPageLoader />;
  const active = me.memberships.find((m) => m.businessStatus === 'active') ?? me.memberships[0];
  if (active) return <Navigate to={`/w/${active.businessId}/dashboard`} replace />;
  return <Navigate to="/onboarding" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route element={<GuestOnly />}>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
      </Route>
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/legal/privacy" element={<Privacy />} />
      <Route path="/legal/terms" element={<Terms />} />

      <Route element={<RequireAuth />}>
        <Route path="/" element={<Home />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/invite/:token" element={<AcceptInvite />} />
        <Route path="/w/:businessId" element={<AppShell />}>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="whatsapp/connection" element={<Connection />} />
          <Route path="contacts" element={<Contacts />} />
          <Route path="contacts/import" element={<ImportContacts />} />
          <Route path="contacts/tags" element={<Tags />} />
          <Route path="contacts/:contactId" element={<ContactDetail />} />
          <Route path="templates" element={<Templates />} />
          <Route path="templates/new" element={<NewTemplate />} />
          <Route path="campaigns" element={<CampaignList />} />
          <Route path="campaigns/scheduled" element={<CampaignList />} />
          <Route path="campaigns/history" element={<CampaignList />} />
          <Route path="campaigns/reports" element={<CampaignList />} />
          <Route path="campaigns/new" element={<NewCampaign />} />
          <Route path="campaigns/:campaignId" element={<CampaignDetail />} />
          <Route path="inbox" element={<Inbox />} />
          <Route path="inbox/:conversationId" element={<Inbox />} />
          <Route path="canned-replies" element={<CannedReplies />} />
          <Route path="leads" element={<Pipeline />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="analytics" element={<Reports />} />
          <Route path="ai" element={<AiSupport />} />
          <Route path="ai/knowledge" element={<Knowledge />} />
          <Route path="ai/handoff" element={<Handoff />} />
          <Route path="ai/usage" element={<AiUsage />} />
          <Route path="automation" element={<Automations />} />
          <Route path="automation/executions" element={<Executions />} />
          <Route path="automation/:workflowId" element={<Builder />} />
          <Route path="settings/profile" element={<BusinessProfile />} />
          <Route path="settings/team" element={<Team />} />
          <Route path="settings/roles" element={<RolesPage />} />
          <Route path="settings/subscription" element={<SubscriptionPage />} />
          <Route path="settings/activity" element={<ActivityPage />} />
          <Route path="settings/account" element={<AccountPage />} />
          <Route path="*" element={<ComingSoon />} />
        </Route>
        <Route path="/admin" element={<AdminShell />}>
          <Route index element={<AdminOverview />} />
          <Route path="businesses" element={<AdminBusinesses />} />
          <Route path="plans" element={<AdminPlans />} />
          <Route path="settings" element={<AdminSettings />} />
          <Route path="audit" element={<AdminAudit />} />
          <Route path="queue" element={<AdminQueue />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
