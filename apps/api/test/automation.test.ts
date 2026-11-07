import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeTestApp, signup, createBusiness, addMember, bearer } from './helpers';
import { createWorker, type Worker } from '../src/jobs/worker';
import { daysBetween, localParts, parseFlexibleDate, scanSchedules, textMatches } from '../src/automation/engine';

describe('automation helpers', () => {
  const today = { year: 2026, month: 11, day: 10 };
  it('parses common date formats', () => {
    expect(parseFlexibleDate('2026-11-17', today)).toEqual({ y: 2026, m: 11, d: 17 });
    expect(parseFlexibleDate('17/11/2026', today)).toEqual({ y: 2026, m: 11, d: 17 });
    expect(parseFlexibleDate('17-11-26', today)).toEqual({ y: 2026, m: 11, d: 17 });
    expect(parseFlexibleDate('17 Nov', today)).toEqual({ y: 2026, m: 11, d: 17 });
    expect(parseFlexibleDate('17th November', today)).toEqual({ y: 2026, m: 11, d: 17 });
    expect(parseFlexibleDate('Jan 5', today)).toEqual({ y: 2027, m: 1, d: 5 }); // next occurrence
    expect(parseFlexibleDate('31 Feb', today)).toBeNull();
    expect(parseFlexibleDate('soon', today)).toBeNull();
    expect(daysBetween({ y: 2026, m: 11, d: 10 }, { y: 2026, m: 11, d: 17 })).toBe(7);
  });
  it('matches keywords on word boundaries', () => {
    expect(textMatches('I want Personal Training!', ['personal training'])).toBe(true);
    expect(textMatches('Is there a PT?', ['pt'])).toBe(true);
    expect(textMatches('optional', ['pt'])).toBe(false);
    expect(textMatches('anything', [])).toBe(true);
  });
  it('computes local time in the business timezone', () => {
    expect(localParts(new Date('2026-11-10T03:00:00Z'), 'Asia/Kolkata')).toMatchObject({ date: '2026-11-10', hour: 8, minute: 30 });
  });
});

describe('Phase 4: automation workflows', () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let worker: Worker;
  let owner: { token: string; userId: string };
  let agent: { token: string; userId: string };
  let biz: string;
  let utilityTpl: string;
  let ptTag: string;
  const api = () => request(ctx.app);
  const b = (p: string) => `/v1/businesses/${biz}${p}`;
  const q = <T = any>(sql: string, p: unknown[] = []) => ctx.deps.db.query<T>(sql, p).then((r) => r.rows);
  const contact = async (name: string, phone: string, extra: Record<string, unknown> = {}) =>
    (await api().post(b('/contacts')).set(bearer(owner.token)).send({ name, phone, consent: { utility: true, marketing: false, source: 'Front desk form' }, ...extra })).body.data.id as string;
  const createWf = async (name: string, definition: unknown, templateKey?: string) => {
    const w = await api().post(b('/automations')).set(bearer(owner.token)).send({ name, templateKey });
    if (definition) await api().put(b(`/automations/${w.body.data.id}/draft`)).set(bearer(owner.token)).send({ definition });
    return w.body.data.id as string;
  };
  const publish = (id: string) => api().post(b(`/automations/${id}/publish`)).set(bearer(owner.token));

  beforeAll(async () => {
    ctx = await makeTestApp();
    worker = createWorker(ctx.deps);
    owner = await signup(ctx.app, 'owner@gold.in', 'Owner');
    biz = await createBusiness(ctx.app, owner.token, 'Gold Fitness Kengeri');
    await q(`update public.subscription_entitlements set limit_value = 10 where business_id = $1 and key = 'staff_seats'`, [biz]);
    agent = await addMember(ctx.app, owner.token, biz, 'trainer@gold.in', 'agent');
    await api().post(b('/channels/whatsapp')).set(bearer(owner.token)).send({ mode: 'mock' });
    const t = await api().post(b('/templates')).set(bearer(owner.token)).send({
      name: 'gym_reminder', language: 'en', category: 'UTILITY', body: 'Hi {{customer_name}}, a reminder from {{business_name}}. Reply for help.',
      examples: { customer_name: 'Ravi', business_name: 'Gold Fitness' } });
    utilityTpl = t.body.data.id;
    await api().post(b(`/templates/${utilityTpl}/submit`)).set(bearer(owner.token));
    ptTag = (await api().post(b('/tags')).set(bearer(owner.token)).send({ name: 'PT enquiry' })).body.data.id;
    await worker.drain();
  });
  afterAll(async () => { await ctx.deps.db.close(); });

  it('automation is a plan feature and owner/manager only', async () => {
    const res = await api().post(b('/automations')).set(bearer(owner.token)).send({ name: 'Trial workflow' });
    expect(res.status).toBe(402);
    expect(res.body.error.message).toMatch(/Growth plan/);
    await q(`update public.subscription_entitlements set limit_value = 20 where business_id = $1 and key = 'workflows'`, [biz]);
    expect((await api().get(b('/automations')).set(bearer(agent.token))).status).toBe(403);
    expect((await api().get(b('/automation-templates')).set(bearer(owner.token))).body.data).toHaveLength(7);
  });

  it('gym enquiry template: publish blocked until filled in, then a test run sends, opens a lead and a task', async () => {
    const id = await createWf('Enquiry ack', null, 'gym_enquiry_ack');
    const bad = await publish(id);
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.errors.some((e: { message: string }) => /template/i.test(e.message))).toBe(true);
    const wf = (await api().get(b(`/automations/${id}`)).set(bearer(owner.token))).body.data;
    const def = wf.draft;
    def.steps[0].config.templateId = utilityTpl;
    await api().put(b(`/automations/${id}/draft`)).set(bearer(owner.token)).send({ definition: def });
    const ok = await publish(id);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'published', published: { version: 1 }, hasUnpublishedChanges: false });

    const ravi = await contact('Ravi', '9876543210');
    const run = await api().post(b(`/automations/${id}/test`)).set(bearer(owner.token)).send({ contactId: ravi });
    expect(run.status).toBe(201);
    await worker.drain();
    const ex = await api().get(b(`/automation-executions/${run.body.data.executionId}`)).set(bearer(owner.token));
    expect(ex.body.data.status).toBe('completed');
    expect(ex.body.data.steps.map((s: { type: string; status: string }) => `${s.type}:${s.status}`)).toEqual(['send_template:completed', 'create_lead:completed', 'create_task:completed']);
    const msgs = await q(`select status, body from public.messages where contact_id = $1 and direction = 'outbound'`, [ravi]);
    expect(msgs[0]).toMatchObject({ body: 'Hi Ravi, a reminder from Gold Fitness Kengeri. Reply for help.' });
    expect(['sent', 'delivered', 'read']).toContain(msgs[0].status);
    expect(await q(`select title, source from public.leads where contact_id = $1`, [ravi])).toEqual([{ title: 'Gym membership enquiry', source: 'enquiry_form' }]);
    const task = await q(`select title, due_at > now() + interval '1 hour' as later from public.follow_up_tasks where contact_id = $1`, [ravi]);
    expect(task).toEqual([{ title: 'Call new enquiry', later: true }]);
  });

  it('skips sending (not failing) when the contact has no consent', async () => {
    const id = (await q<{ id: string }>(`select id from public.automation_workflows where name = 'Enquiry ack'`))[0]!.id;
    const nobody = (await api().post(b('/contacts')).set(bearer(owner.token)).send({ name: 'No consent', phone: '9876500077' })).body.data.id;
    const run = await api().post(b(`/automations/${id}/test`)).set(bearer(owner.token)).send({ contactId: nobody });
    await worker.drain();
    const ex = await api().get(b(`/automation-executions/${run.body.data.executionId}`)).set(bearer(owner.token));
    expect(ex.body.data.status).toBe('completed');
    expect(ex.body.data.steps[0]).toMatchObject({ type: 'send_template', status: 'skipped', output: { reason: 'no_consent' } });
  });

  it('customer message with keywords → tag, lead, assign and notify (once per day per contact)', async () => {
    const id = await createWf('PT follow-up', null, 'pt_followup');
    const def = (await api().get(b(`/automations/${id}`)).set(bearer(owner.token))).body.data.draft;
    def.steps[0].config.tagId = ptTag;
    def.steps[2].config.userId = agent.userId;
    def.steps[3].config.userIds = [owner.userId];
    await api().put(b(`/automations/${id}/draft`)).set(bearer(owner.token)).send({ definition: def });
    expect((await publish(id)).status).toBe(200);

    const send = (text: string) => api().post(b('/channels/whatsapp/mock/inbound')).set(bearer(owner.token)).send({ phone: '+919812300001', name: 'Asha', text });
    await send('Hello');
    await send('Do you have personal training?');
    await send('What does a PT cost?'); // same day: no second run
    await worker.drain();
    const execs = await q(`select status from public.automation_executions where workflow_id = $1`, [id]);
    expect(execs).toEqual([{ status: 'completed' }]);
    const asha = (await q<{ id: string }>(`select id from public.contacts where phone_e164 = '+919812300001'`))[0]!.id;
    expect(await q(`select tag_id from public.contact_tags where contact_id = $1`, [asha])).toEqual([{ tag_id: ptTag }]);
    expect((await q(`select assigned_to from public.conversations where contact_id = $1`, [asha]))[0].assigned_to).toBe(agent.userId);
    const notes = await api().get(b('/notifications')).set(bearer(owner.token));
    expect(notes.body.meta.unread).toBe(1);
    expect(notes.body.data[0]).toMatchObject({ title: 'PT follow-up', body: 'New personal training enquiry on WhatsApp' });
    expect(notes.body.data[0].link).toMatch(/^inbox\//);
    await api().post(b('/notifications/read-all')).set(bearer(owner.token));
    expect((await api().get(b('/notifications')).set(bearer(owner.token))).body.meta.unread).toBe(0);
  });

  it('date trigger + wait + branch: renewal reminder, call task only if the member did not reply', async () => {
    const def = {
      reentry: 'daily',
      trigger: { type: 'membership_expiring', config: { field: 'membership_expiry', daysBefore: 7, hour: 9 } },
      steps: [
        { id: 'send', type: 'send_template', config: { templateId: utilityTpl, defaults: {} } },
        { id: 'wait', type: 'wait', config: { amount: 3, unit: 'days' } },
        { id: 'if', type: 'branch', config: { condition: { kind: 'replied_since_start' } }, yes: [], no: [
          { id: 'task', type: 'create_task', config: { title: 'Call about renewal', dueInHours: 4 } },
        ] },
      ],
    };
    const id = await createWf('Renewal', def);
    expect((await publish(id)).status).toBe(200);
    const now = new Date();
    const local = localParts(now, 'Asia/Kolkata');
    const target = new Date(Date.UTC(local.year, local.month - 1, local.day + 7)).toISOString().slice(0, 10);
    const quiet = await contact('Quiet member', '9876511111', { customFields: { membership_expiry: target } });
    const chatty = await contact('Chatty member', '9876522222', { customFields: { membership_expiry: target } });
    await contact('Not due', '9876533333', { customFields: { membership_expiry: '2030-01-01' } });

    // Before 9am IST nothing happens; at/after 9am both due members start — once.
    const before = new Date(Date.UTC(local.year, local.month - 1, local.day, 3, 0)); // 08:30 IST
    const after = new Date(Date.UTC(local.year, local.month - 1, local.day, 4, 0)); // 09:30 IST
    expect(await scanSchedules(ctx.deps.db, before)).toBe(0);
    expect(await scanSchedules(ctx.deps.db, after)).toBe(2);
    expect(await scanSchedules(ctx.deps.db, after)).toBe(0);

    // Process until both executions are parked on the 3-day wait (without fast-forwarding time).
    for (let i = 0; i < 10; i++) await worker.tick();
    expect(await q(`select status from public.automation_executions where workflow_id = $1 order by started_at`, [id])).toEqual([{ status: 'waiting' }, { status: 'waiting' }]);
    await api().post(b('/channels/whatsapp/mock/inbound')).set(bearer(owner.token)).send({ phone: '+919876522222', text: 'Yes please renew' });
    await worker.drain(); // fast-forwards the wait
    expect(await q(`select status from public.automation_executions where workflow_id = $1`, [id])).toEqual([{ status: 'completed' }, { status: 'completed' }]);
    expect(await q(`select title from public.follow_up_tasks where contact_id = $1`, [quiet])).toEqual([{ title: 'Call about renewal' }]);
    expect(await q(`select title from public.follow_up_tasks where contact_id = $1`, [chatty])).toEqual([]);
  });

  it('birthday and one-time scheduled workflows run in the business timezone', async () => {
    const local = localParts(new Date(), 'Asia/Kolkata');
    const bday = `1990-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
    const birthdayPerson = await contact('Birthday', '9876544444', { birthday: bday });
    const id = await createWf('Birthday', { reentry: 'daily', trigger: { type: 'birthday', config: { hour: 0 } }, steps: [{ id: 's', type: 'send_template', config: { templateId: utilityTpl } }] });
    await publish(id);
    const holiday = await createWf('Holiday', { reentry: 'once', trigger: { type: 'scheduled', config: { mode: 'once', at: new Date(Date.now() + 120_000).toISOString(), audience: { type: 'tags', tagIds: [ptTag] } } },
      steps: [{ id: 's', type: 'create_task', config: { title: 'Holiday notice check', dueInHours: 1 } }] });
    expect((await publish(holiday)).status).toBe(200);
    await scanSchedules(ctx.deps.db, new Date());
    expect(await q(`select contact_id from public.automation_executions where workflow_id = $1`, [id])).toEqual([{ contact_id: birthdayPerson }]);
    expect(await q(`select 1 from public.automation_executions where workflow_id = $1`, [holiday])).toHaveLength(0); // not yet
    await scanSchedules(ctx.deps.db, new Date(Date.now() + 180_000));
    expect(await q(`select 1 from public.automation_executions where workflow_id = $1`, [holiday])).toHaveLength(1); // Asha has the PT tag
    await worker.drain();
  });

  it('loop prevention: mutually-triggering workflows stop at the depth limit', async () => {
    const tagA = (await api().post(b('/tags')).set(bearer(owner.token)).send({ name: 'Loop A' })).body.data.id;
    const tagB = (await api().post(b('/tags')).set(bearer(owner.token)).send({ name: 'Loop B' })).body.data.id;
    const self = await createWf('Self loop', { reentry: 'always', trigger: { type: 'tag_added', config: { tagId: tagA } }, steps: [{ id: 's', type: 'add_tag', config: { tagId: tagA } }] });
    const selfRes = await publish(self);
    expect(selfRes.status).toBe(422);
    expect(selfRes.body.error.message).toMatch(/re-trigger/);
    await api().post(b(`/automations/${self}/archive`)).set(bearer(owner.token));
    const w1 = await createWf('A→B', { reentry: 'always', trigger: { type: 'tag_added', config: { tagId: tagA } }, steps: [
      { id: 'r', type: 'remove_tag', config: { tagId: tagA } }, { id: 'a', type: 'add_tag', config: { tagId: tagB } }] });
    const w2 = await createWf('B→A', { reentry: 'always', trigger: { type: 'tag_added', config: { tagId: tagB } }, steps: [
      { id: 'r', type: 'remove_tag', config: { tagId: tagB } }, { id: 'a', type: 'add_tag', config: { tagId: tagA } }] });
    await publish(w1);
    await publish(w2);
    const c = await contact('Loopy', '9876555555');
    await api().post(b('/contacts/bulk-tag')).set(bearer(owner.token)).send({ contactIds: [c], tagId: tagA, action: 'add' });
    await worker.drain();
    const n = await q<{ n: number }>(`select count(*)::int as n from public.automation_executions where workflow_id in ($1, $2)`, [w1, w2]);
    expect(n[0]!.n).toBe(4); // depths 0..3, then stopped
    await api().post(b(`/automations/${w1}/pause`)).set(bearer(owner.token));
    await api().post(b(`/automations/${w2}/pause`)).set(bearer(owner.token));
  });

  it('failed executions are logged and can be retried after fixing the cause', async () => {
    const id = (await q<{ id: string }>(`select id from public.automation_workflows where name = 'Enquiry ack'`))[0]!.id;
    const c = await contact('Retry me', '9876566666');
    await q(`update public.message_templates set status = 'PAUSED' where id = $1`, [utilityTpl]);
    const run = await api().post(b(`/automations/${id}/test`)).set(bearer(owner.token)).send({ contactId: c });
    await worker.drain();
    const failed = await api().get(b('/automation-executions?status=failed')).set(bearer(owner.token));
    expect(failed.body.data.map((e: { id: string }) => e.id)).toContain(run.body.data.executionId);
    expect(failed.body.data.find((e: { id: string }) => e.id === run.body.data.executionId).error).toMatch(/no longer approved/);
    await q(`update public.message_templates set status = 'APPROVED' where id = $1`, [utilityTpl]);
    expect((await api().post(b(`/automation-executions/${run.body.data.executionId}/retry`)).set(bearer(owner.token))).status).toBe(200);
    await worker.drain();
    const ex = await api().get(b(`/automation-executions/${run.body.data.executionId}`)).set(bearer(owner.token));
    expect(ex.body.data.status).toBe('completed');
    expect(ex.body.data.steps.filter((s: { type: string }) => s.type === 'send_template').map((s: { status: string }) => s.status)).toEqual(['failed', 'completed']);
  });

  it('pausing stops new runs and cancels waiting ones; drafts do not affect the live version', async () => {
    const id = (await q<{ id: string }>(`select id from public.automation_workflows where name = 'Enquiry ack'`))[0]!.id;
    const wf = (await api().get(b(`/automations/${id}`)).set(bearer(owner.token))).body.data;
    const def = { ...wf.draft, steps: [{ id: 'w', type: 'wait', config: { amount: 1, unit: 'days' } }, ...wf.draft.steps] };
    await api().put(b(`/automations/${id}/draft`)).set(bearer(owner.token)).send({ definition: def });
    expect((await api().get(b(`/automations/${id}`)).set(bearer(owner.token))).body.data.hasUnpublishedChanges).toBe(true);
    await publish(id);
    const c = await contact('Waiter', '9876577777');
    await api().post(b(`/automations/${id}/test`)).set(bearer(owner.token)).send({ contactId: c });
    for (let i = 0; i < 5; i++) await worker.tick();
    expect((await q(`select e.status, v.version from public.automation_executions e join public.automation_versions v on v.id = e.version_id where e.contact_id = $1`, [c]))[0])
      .toEqual({ status: 'waiting', version: 2 });
    await api().post(b(`/automations/${id}/pause`)).set(bearer(owner.token));
    expect((await q(`select status from public.automation_executions where contact_id = $1`, [c]))[0].status).toBe('cancelled');
    expect((await api().post(b(`/automations/${id}/test`)).set(bearer(owner.token)).send({ contactId: c })).status).toBe(409);
  });

  it('tenant isolation', async () => {
    const other = await signup(ctx.app, 'other@x.in');
    for (const p of ['/automations', '/automation-executions', '/automation-templates', '/notifications'])
      expect((await api().get(b(p)).set(bearer(other.token))).status, p).toBe(404);
  });
});
