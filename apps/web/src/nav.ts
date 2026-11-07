import {
  BarChart3, Bot, Building2, CalendarClock, CreditCard, FileText, Gauge, GitBranch, Inbox, KeyRound, Layers, LayoutDashboard,
  ListChecks, Megaphone, MessageCircle, MessageSquareText, Plug, Receipt, Send, Settings, ShieldCheck, Sparkles, Tags, Users,
  UserPlus, Webhook, Workflow, BellRing, Download, BookOpen, Upload, History, HelpCircle, Hand, Brain, TrendingUp, Wallet, type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@socialpilot/shared';

export interface NavItem {
  label: string;
  path: string; // relative to /w/:businessId
  icon: LucideIcon;
  /** Phase in which the feature ships. Phases 1–5 are implemented. */
  phase: number;
  permission?: Permission;
  description?: string;
}
export interface NavSection {
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    label: 'Overview',
    icon: Gauge,
    items: [{ label: 'Dashboard', path: 'dashboard', icon: LayoutDashboard, phase: 1 }],
  },
  {
    label: 'WhatsApp Marketing',
    icon: Megaphone,
    items: [
      { label: 'WhatsApp Connection', path: 'whatsapp/connection', icon: Plug, phase: 2, description: 'Connect your WhatsApp Business Account (WABA ID, phone number ID and a system-user token) through the official Meta Cloud API.' },
      { label: 'Broadcast Campaigns', path: 'campaigns', icon: Send, phase: 2, permission: 'campaigns.read', description: 'Create template-based broadcasts to opted-in contacts with consent, opt-out and quota checks before every send.' },
      { label: 'Scheduled Campaigns', path: 'campaigns/scheduled', icon: CalendarClock, phase: 2, permission: 'campaigns.read', description: 'Timezone-aware scheduling with pause and cancel for pending campaigns.' },
      { label: 'Message Templates', path: 'templates', icon: FileText, phase: 2, permission: 'campaigns.read', description: 'Sync and manage Meta-approved templates, track approval status and map {{customer_name}}-style variables.' },
      { label: 'Campaign History', path: 'campaigns/history', icon: History, phase: 2, permission: 'campaigns.read' },
      { label: 'Delivery Reports', path: 'campaigns/reports', icon: BarChart3, phase: 2, permission: 'campaigns.read', description: 'Sent, delivered, read, failed and replied counts per campaign, driven by Meta webhooks.' },
    ],
  },
  {
    label: 'Inbox',
    icon: Inbox,
    items: [
      { label: 'Team Inbox', path: 'inbox', icon: MessageCircle, phase: 3, permission: 'conversations.reply' },
      { label: 'Canned Replies', path: 'canned-replies', icon: MessageSquareText, phase: 3, permission: 'conversations.reply' },
    ],
  },
  {
    label: 'CRM',
    icon: Users,
    items: [
      { label: 'Contacts', path: 'contacts', icon: Users, phase: 2, permission: 'contacts.read', description: 'E.164 contacts with consent records, tags, custom fields, CSV import, duplicate detection and export.' },
      { label: 'Tags', path: 'contacts/tags', icon: Tags, phase: 2, permission: 'contacts.read' },
      { label: 'Import Contacts', path: 'contacts/import', icon: Upload, phase: 2, permission: 'contacts.write' },
      { label: 'Lead Pipeline', path: 'leads', icon: TrendingUp, phase: 3, permission: 'contacts.read' },
      { label: 'Follow-Up Tasks', path: 'tasks', icon: ListChecks, phase: 3 },
    ],
  },
  {
    label: 'Automation',
    icon: Workflow,
    items: [
      { label: 'Workflows', path: 'automation', icon: GitBranch, phase: 4, permission: 'automation.manage' },
      { label: 'Execution History', path: 'automation/executions', icon: Layers, phase: 4, permission: 'automation.manage' },
    ],
  },
  {
    label: 'AI Center',
    icon: Sparkles,
    items: [
      { label: 'AI Customer Support', path: 'ai', icon: Bot, phase: 5, permission: 'ai.manage' },
      { label: 'Knowledge Base & FAQ', path: 'ai/knowledge', icon: BookOpen, phase: 5, permission: 'ai.manage' },
      { label: 'Human Handoff', path: 'ai/handoff', icon: Hand, phase: 5, permission: 'ai.manage' },
      { label: 'AI Usage', path: 'ai/usage', icon: Brain, phase: 5, permission: 'ai.manage' },
    ],
  },
  {
    label: 'Analytics',
    icon: BarChart3,
    items: [
      { label: 'Reports', path: 'analytics', icon: BarChart3, phase: 3, permission: 'analytics.read' },
      { label: 'Messaging Costs', path: 'analytics/costs', icon: Wallet, phase: 6, permission: 'analytics.read', description: 'Estimated Meta message charges (from configurable pricing), separate from your DigiMithra subscription.' },
    ],
  },
  {
    label: 'Settings',
    icon: Settings,
    items: [
      { label: 'Business Profile', path: 'settings/profile', icon: Building2, phase: 1 },
      { label: 'Team Members', path: 'settings/team', icon: UserPlus, phase: 1, permission: 'members.read' },
      { label: 'Roles & Permissions', path: 'settings/roles', icon: ShieldCheck, phase: 1 },
      { label: 'Subscription', path: 'settings/subscription', icon: CreditCard, phase: 1, permission: 'billing.read' },
      { label: 'Activity Log', path: 'settings/activity', icon: Receipt, phase: 1, permission: 'audit.read' },
      { label: 'API Keys', path: 'settings/api-keys', icon: KeyRound, phase: 7, permission: 'api_keys.manage', description: 'Scoped API keys for your website, Google Apps Script and ERP integrations.' },
      { label: 'Webhooks & Integrations', path: 'settings/integrations', icon: Webhook, phase: 7, permission: 'channels.manage', description: 'Google Forms / Apps Script enquiry form, Google Sheets, DGF ERP and Instagram (after Meta review).' },
      { label: 'Notifications', path: 'settings/notifications', icon: BellRing, phase: 6, description: 'Choose how you are notified about new conversations and failures.' },
      { label: 'Privacy & Data Export', path: 'settings/privacy', icon: HelpCircle, phase: 6, permission: 'privacy.manage', description: 'Export or delete workspace data and manage retention (India DPDP Act planning).' },
    ],
  },
];

export const ALL_ITEMS = NAV.flatMap((s) => s.items.map((i) => ({ ...i, section: s.label })));
