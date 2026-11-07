import type { Logger } from '../lib/logger';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Machine-readable link, used by tests and the dev console. */
  link?: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
  readonly outbox: MailMessage[];
}

/**
 * Development mailer: logs the message (including the action link) instead of
 * sending.  A real transactional email provider is NOT configured yet; in
 * production, Supabase Auth sends verification/reset emails itself and
 * invitation links are shown to the inviter to share.
 */
export function createConsoleMailer(logger: Logger): Mailer {
  const outbox: MailMessage[] = [];
  return {
    outbox,
    async send(msg) {
      outbox.push(msg);
      if (outbox.length > 200) outbox.shift();
      logger.info({ mail: { to: msg.to, subject: msg.subject, link: msg.link } }, `[dev-mailer] ${msg.subject}`);
    },
  };
}
