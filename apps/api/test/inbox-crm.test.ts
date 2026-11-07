import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeTestApp, signup, createBusiness, addMember, bearer } from './helpers';
import { createWorker, type Worker } from '../src/jobs/worker';

describe('Phase 3: team inbox and CRM', () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let worker: Worker;
  let owner: { token: string; userId: string };
  let agentA: { token: string; userId: string };
  let agentB: { token: string; userId: string };
  let biz: string;
  let convRavi: string;
  let convAsha: string;
  let templateId: string;
  const api = () => request(ctx.app);
  const b = (p: string) => `/v1/businesses/${biz}${p}`;
  const inbound = (phone: string, text: string, name = '') =>
    api().post(b('/channels/whatsapp/mock/inbound')).set(bearer(owner.token)).send({ phone, text, name });
  const reply = (token: string, conv: string, body: object) =>
    api().post(b(`/conversations/${conv}/messages`)).set(bearer(token)).send({ clientId: crypto.randomUUID(), ...body });

  beforeAll(async () => {
    ctx = await makeTestApp();
    worker = createWorker(ctx.deps);
    owner = await signup(ctx.app, 'owner@gold.in', 'Owner');
    biz = await createBusiness(ctx.app, owner.token, 'Gold Fitness Kengeri');
    await ctx.deps.db.query(`update public.subscription_entitlements set limit_value = 10 where business_id = $1 and key = 'staff_seats'`, [biz]);
    agentA = await addMember(ctx.app, owner.token, biz, 'reception@gold.in', 'agent');
    agentB = await addMember(ctx.app, owner.token, biz, 'trainer@gold.in', 'agent');
    await api().post(b('/channels/whatsapp')).set(bearer(owner.token)).send({ mode: 'mock' });
    await inbound('+919876543210', 'Hi, what are the gym timings?', 'Ravi');
    await inbound('+919876500012', 'Do you have personal training?', 'Asha');
    const list = await api().get(b('/conversations')).set(bearer(owner.token));
    convRavi = list.body.data.find((c: { contact: { name: string } }) => c.contact.name === 'Ravi').id;
    convAsha = list.body.data.find((c: { contact: { name: string } }) => c.contact.name === 'Asha').id;
    const t = await api().post(b('/templates')).set(bearer(owner.token)).send({
      name: 'follow_up', language: 'en', category: 'UTILITY', body: 'Hi {{customer_name}}, following up on your enquiry at {{business_name}}. Reply to continue.',
      examples: { customer_name: 'Ravi', business_name: 'Gold Fitness' },
    });
    templateId = t.body.data.id;
    await api().post(b(`/templates/${templateId}/submit`)).set(bearer(owner.token));
    await worker.drain();
  });
  afterAll(async () => { await ctx.deps.db.close(); });

  it('lists inbound conversations with preview, unread count and an open 24h window', async () => {
    const res = await api().get(b('/conversations')).set(bearer(owner.token));
    expect(res.status).toBe(200);
    const ravi = res.body.data.find((c: { id: string }) => c.id === convRavi);
    expect(ravi).toMatchObject({ status: 'open', unreadCount: 1, windowOpen: true, lastMessagePreview: 'Hi, what are the gym timings?', assignedTo: null });
    const counts = await api().get(b('/inbox/counts')).set(bearer(owner.token));
    expect(counts.body.data).toEqual({ all: 2, mine: 0, unassigned: 2, unread: 2 });
  });

  it('agent replies to an unassigned conversation: claims it, message is sent and receipts arrive', async () => {
    const res = await reply(agentA.token, convRavi, { type: 'text', body: 'We are open 5am–10pm, Monday to Saturday.' });
    expect(res.status).toBe(201);
    await worker.drain();
    const thread = await api().get(b(`/conversations/${convRavi}`)).set(bearer(agentA.token));
    expect(thread.body.data.conversation.assignedTo.id).toBe(agentA.userId);
    const out = thread.body.data.messages.filter((m: { direction: string }) => m.direction === 'outbound');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'text', status: 'read', sentByName: 'Agent Person' });
    // service conversations are not billed as marketing
    const usage = await ctx.deps.db.query<{ metric: string }>(`select metric from public.usage_events where business_id = $1`, [biz]);
    expect(usage.rows.every((u) => u.metric === 'message_service')).toBe(true);
  });

  it('duplicate submits with the same clientId create one message', async () => {
    const clientId = crypto.randomUUID();
    const first = await api().post(b(`/conversations/${convRavi}/messages`)).set(bearer(agentA.token)).send({ clientId, type: 'text', body: 'Thanks!' });
    const second = await api().post(b(`/conversations/${convRavi}/messages`)).set(bearer(agentA.token)).send({ clientId, type: 'text', body: 'Thanks!' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual({ id: first.body.data.id, duplicate: true });
    const n = await ctx.deps.db.query<{ n: number }>(`select count(*)::int as n from public.messages where body = 'Thanks!'`);
    expect(n.rows[0]!.n).toBe(1);
    const jobs = await ctx.deps.db.query<{ n: number }>(`select count(*)::int as n from public.scheduled_jobs where kind = 'conversation.send' and payload->>'messageId' = $1`, [first.body.data.id]);
    expect(jobs.rows[0]!.n).toBe(1);
  });

  it('agents see only their own and unassigned conversations, and cannot assign to others', async () => {
    const forB = await api().get(b('/conversations')).set(bearer(agentB.token));
    expect(forB.body.data.map((c: { id: string }) => c.id)).toEqual([convAsha]);
    expect((await api().get(b(`/conversations/${convRavi}`)).set(bearer(agentB.token))).status).toBe(404);
    expect((await reply(agentB.token, convRavi, { type: 'text', body: 'hijack' })).status).toBe(404);
    expect((await api().post(b(`/conversations/${convAsha}/assign`)).set(bearer(agentB.token)).send({ userId: agentA.userId })).status).toBe(403);
    // claiming an unassigned conversation is allowed
    const claim = await api().post(b(`/conversations/${convAsha}/assign`)).set(bearer(agentB.token)).send({ userId: agentB.userId });
    expect(claim.status).toBe(200);
    expect(claim.body.data.assignedTo.id).toBe(agentB.userId);
    // releasing it again is allowed
    expect((await api().post(b(`/conversations/${convAsha}/assign`)).set(bearer(agentB.token)).send({ userId: null })).status).toBe(200);
    // owner reassigns
    const re = await api().post(b(`/conversations/${convAsha}/assign`)).set(bearer(owner.token)).send({ userId: agentB.userId });
    expect(re.body.data.assignedTo.id).toBe(agentB.userId);
    expect((await api().post(b(`/conversations/${convAsha}/assign`)).set(bearer(owner.token)).send({ userId: crypto.randomUUID() })).status).toBe(422);
  });

  it('enforces the 24-hour window: free text blocked, approved template allowed', async () => {
    await ctx.deps.db.query(`update public.conversations set last_inbound_at = now() - interval '25 hours' where id = $1`, [convAsha]);
    const text = await reply(agentB.token, convAsha, { type: 'text', body: 'Hello again' });
    expect(text.status).toBe(422);
    expect(text.body.error.code).toBe('outside_24h_window');
    const tpl = await reply(agentB.token, convAsha, { type: 'template', templateId });
    expect(tpl.status).toBe(201);
    await worker.drain();
    const thread = await api().get(b(`/conversations/${convAsha}`)).set(bearer(agentB.token));
    const last = thread.body.data.messages.at(-1);
    expect(last).toMatchObject({ type: 'template', body: 'Hi Asha, following up on your enquiry at Gold Fitness Kengeri. Reply to continue.' });
    expect(['sent', 'delivered', 'read']).toContain(last.status);
    // the worker re-checks the window too (message queued while open, window closes before send)
    const queued = await reply(agentA.token, convRavi, { type: 'text', body: 'Late message' });
    await ctx.deps.db.query(`update public.conversations set last_inbound_at = now() - interval '2 days' where id = $1`, [convRavi]);
    await worker.drain();
    const m = await ctx.deps.db.query<{ status: string; error_code: string }>('select status, error_code from public.messages where id = $1', [queued.body.data.id]);
    expect(m.rows[0]).toEqual({ status: 'failed', error_code: 'outside_24h_window' });
  });

  it('marketing templates require consent in the inbox too', async () => {
    const t = await api().post(b('/templates')).set(bearer(owner.token)).send({
      name: 'promo', language: 'en', category: 'MARKETING', body: 'Hi {{customer_name}}, 20% off this week!', examples: { customer_name: 'Ravi' } });
    await api().post(b(`/templates/${t.body.data.id}/submit`)).set(bearer(owner.token));
    await worker.drain();
    const res = await reply(owner.token, convAsha, { type: 'template', templateId: t.body.data.id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('no_consent');
  });

  it('internal notes, tags, read state, close and reopen', async () => {
    const note = await api().post(b(`/conversations/${convAsha}/notes`)).set(bearer(agentB.token)).send({ body: 'Interested in 3-month PT package' });
    expect(note.status).toBe(201);
    const tags = await api().put(b(`/conversations/${convAsha}/tags`)).set(bearer(agentB.token)).send({ tags: ['pt-enquiry', 'hot', 'hot'] });
    expect(tags.body.data.tags).toEqual(['pt-enquiry', 'hot']);
    await api().post(b(`/conversations/${convAsha}/read`)).set(bearer(agentB.token));
    const closed = await api().post(b(`/conversations/${convAsha}/status`)).set(bearer(agentB.token)).send({ status: 'closed' });
    expect(closed.body.data.status).toBe('closed');
    expect((await reply(agentB.token, convAsha, { type: 'template', templateId })).status).toBe(409);
    // a new customer message opens a new conversation; the old one cannot be reopened over it
    await inbound('+919876500012', 'One more question', 'Asha');
    expect((await api().post(b(`/conversations/${convAsha}/status`)).set(bearer(agentB.token)).send({ status: 'open' })).status).toBe(409);
    const detail = await api().get(b(`/conversations/${convAsha}`)).set(bearer(agentB.token));
    expect(detail.body.data.notes[0]).toMatchObject({ body: 'Interested in 3-month PT package', authorName: 'Agent Person' });
  });

  it('canned replies: managers create, agents use', async () => {
    expect((await api().post(b('/canned-replies')).set(bearer(agentA.token)).send({ shortcut: 'hours', title: 'Hours', body: 'x' })).status).toBe(403);
    const c = await api().post(b('/canned-replies')).set(bearer(owner.token)).send({ shortcut: 'Hours', title: 'Opening hours', body: 'We are open 5am–10pm, Mon–Sat.' });
    expect(c.status).toBe(201);
    expect(c.body.data.shortcut).toBe('hours');
    expect((await api().post(b('/canned-replies')).set(bearer(owner.token)).send({ shortcut: 'hours', title: 'x', body: 'y' })).status).toBe(409);
    const list = await api().get(b('/canned-replies')).set(bearer(agentA.token));
    expect(list.body.data.map((x: { shortcut: string }) => x.shortcut)).toEqual(['hours']);
  });

  it('lead pipeline: create, move stages, won status, history; agents can update', async () => {
    const pipes = await api().get(b('/pipelines')).set(bearer(owner.token));
    const stages = pipes.body.data[0].stages;
    expect(stages.map((s: { name: string }) => s.name)).toEqual(['New enquiry', 'Contacted', 'Visit / trial booked', 'Negotiation', 'Won', 'Lost']);
    const contacts = await api().get(b('/contacts?q=asha')).set(bearer(owner.token));
    const asha = contacts.body.data[0].id;
    const lead = await api().post(b('/leads')).set(bearer(agentB.token)).send({ contactId: asha, title: 'PT package – 3 months', source: 'whatsapp', valueRupees: 9000 });
    expect(lead.status).toBe(201);
    expect(lead.body.data).toMatchObject({ status: 'open', stageId: stages[0].id, valuePaise: 900000, assignedTo: { id: agentB.userId } });
    const moved = await api().patch(b(`/leads/${lead.body.data.id}`)).set(bearer(agentB.token)).send({ stageId: stages[2].id });
    expect(moved.body.data.status).toBe('open');
    const won = await api().patch(b(`/leads/${lead.body.data.id}`)).set(bearer(owner.token)).send({ stageId: stages[4].id });
    expect(won.body.data.status).toBe('won');
    const timeline = await api().get(b(`/contacts/${asha}/timeline`)).set(bearer(owner.token));
    expect(timeline.body.data.stageEvents.map((e: { stage: string }) => e.stage)).toEqual(['Won', 'Visit / trial booked', 'New enquiry']);
    expect((await api().patch(b(`/leads/${lead.body.data.id}`)).set(bearer(owner.token)).send({ stageId: crypto.randomUUID() })).status).toBe(422);
  });

  it('follow-up tasks: create from a conversation, my/overdue views, complete', async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const t = await api().post(b('/tasks')).set(bearer(agentB.token)).send({ title: 'Call Asha about PT slots', conversationId: convAsha, dueAt: past });
    expect(t.status).toBe(201);
    expect(t.body.data).toMatchObject({ overdue: true, assignedTo: { id: agentB.userId }, contact: { name: 'Asha' } });
    expect((await api().get(b('/tasks?view=mine')).set(bearer(agentB.token))).body.data).toHaveLength(1);
    expect((await api().get(b('/tasks?view=mine')).set(bearer(agentA.token))).body.data).toHaveLength(0);
    expect((await api().get(b('/tasks?view=overdue')).set(bearer(owner.token))).body.data).toHaveLength(1);
    const done = await api().patch(b(`/tasks/${t.body.data.id}`)).set(bearer(agentB.token)).send({ status: 'done' });
    expect(done.body.data).toMatchObject({ status: 'done', overdue: false });
    expect(done.body.data.completedAt).toBeTruthy();
    const note = await api().post(b(`/contacts/${t.body.data.contact.id}/notes`)).set(bearer(agentB.token)).send({ body: 'Prefers evening slots' });
    expect(note.status).toBe(201);
  });

  it('reports aggregate conversations, leads and team performance', async () => {
    expect((await api().get(b('/reports')).set(bearer(agentA.token))).status).toBe(403);
    const r = await api().get(b('/reports?days=7')).set(bearer(owner.token));
    expect(r.status).toBe(200);
    expect(r.body.data.conversations.inbound).toBe(3);
    expect(r.body.data.conversations.medianFirstResponseMinutes).not.toBeNull();
    expect(r.body.data.leads).toMatchObject({ created: 1, won: 1, wonValuePaise: 900000 });
    const b2 = r.body.data.team.find((t: { userId: string }) => t.userId === agentB.userId);
    expect(b2).toMatchObject({ tasksDone: 1, leadsWon: 1 });
    expect(r.body.data.daily).toHaveLength(7);
    const csv = await api().get(b('/reports/team.csv?days=7')).set(bearer(owner.token));
    expect(csv.text.split('\r\n')[0]).toContain('median_first_response_minutes');
  });

  it('out-of-order receipts: a late "sent" never undoes "failed"', async () => {
    const msg = await ctx.deps.db.query<{ id: string; provider_message_id: string }>(
      `select id, provider_message_id from public.messages where direction = 'outbound' and provider_message_id is not null order by created_at limit 1`);
    const { id, provider_message_id: wamid } = msg.rows[0]!;
    await ctx.deps.db.query(`delete from public.message_status_events where provider_message_id = $1`, [wamid]);
    await ctx.deps.db.query(`update public.messages set status = 'sending' where id = $1`, [id]);
    const pn = await ctx.deps.db.query<{ phone_number_id: string }>(`select phone_number_id from public.whatsapp_phone_numbers where business_id = $1`, [biz]);
    const { processMetaPayload, mockStatusPayload } = await import('../src/whatsapp/webhook');
    await ctx.deps.db.transaction((tx) => processMetaPayload(tx, mockStatusPayload(pn.rows[0]!.phone_number_id, wamid, '+919876543210', 'failed', 131049)));
    await ctx.deps.db.transaction((tx) => processMetaPayload(tx, mockStatusPayload(pn.rows[0]!.phone_number_id, wamid, '+919876543210', 'sent')));
    expect((await ctx.deps.db.query<{ status: string }>('select status from public.messages where id = $1', [id])).rows[0]!.status).toBe('failed');
    await ctx.deps.db.transaction((tx) => processMetaPayload(tx, mockStatusPayload(pn.rows[0]!.phone_number_id, wamid, '+919876543210', 'delivered')));
    expect((await ctx.deps.db.query<{ status: string }>('select status from public.messages where id = $1', [id])).rows[0]!.status).toBe('delivered');
  });

  it('tenant isolation for inbox and CRM', async () => {
    const other = await signup(ctx.app, 'x@other.in');
    for (const p of ['/conversations', `/conversations/${convRavi}`, '/leads', '/tasks', '/pipelines', '/canned-replies', '/reports'])
      expect((await api().get(b(p)).set(bearer(other.token))).status, p).toBe(404);
  });
});
