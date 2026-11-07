import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, MailPlus, MoreHorizontal, Trash2, UserPlus, Users } from 'lucide-react';
import { can, invitableRoles, inviteMemberSchema, manageableRoles, ROLE_LABELS, type BusinessRole, type InvitationDto, type InviteMemberInput, type MemberDto } from '@socialpilot/shared';
import { del, get, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { handleFormError } from '@/lib/forms';
import { formatDate } from '@/lib/utils';
import { useWorkspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { DropdownContent, DropdownItem, DropdownMenu, DropdownSeparator, DropdownTrigger } from '@/components/ui/dropdown';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Avatar, Badge, EmptyState, PageHeader, Skeleton, Table, Td, Th } from '@/components/ui/misc';

const roleTone = { owner: 'blue', manager: 'teal', agent: 'neutral' } as const;

export default function Team() {
  const b = useWorkspace();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [removing, setRemoving] = useState<MemberDto | null>(null);
  const canInvite = can(b.myRole, 'members.invite_agent');
  const manageable = manageableRoles(b.myRole);

  const members = useQuery({ queryKey: ['members', b.id], queryFn: () => get<MemberDto[]>(`/v1/businesses/${b.id}/members`) });
  const invites = useQuery({ queryKey: ['invitations', b.id], queryFn: () => get<InvitationDto[]>(`/v1/businesses/${b.id}/invitations`), enabled: canInvite });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['members', b.id] }), qc.invalidateQueries({ queryKey: ['invitations', b.id] }), qc.invalidateQueries({ queryKey: ['dashboard', b.id] })]);

  const updateMember = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { role?: BusinessRole; status?: 'active' | 'disabled' } }) => patch<MemberDto>(`/v1/businesses/${b.id}/members/${id}`, body),
    onSuccess: async () => { await refresh(); toast.success('Team member updated'); },
    onError: (e) => handleFormError(e),
  });
  const removeMember = useMutation({
    mutationFn: (id: string) => del(`/v1/businesses/${b.id}/members/${id}`),
    onSuccess: async () => { setRemoving(null); await refresh(); toast.success('Team member removed'); },
    onError: (e) => handleFormError(e),
  });
  const revokeInvite = useMutation({
    mutationFn: (id: string) => del(`/v1/businesses/${b.id}/invitations/${id}`),
    onSuccess: async () => { await refresh(); toast.success('Invitation revoked'); },
    onError: (e) => handleFormError(e),
  });

  const seatLimit = b.subscription?.plan.limits.staff_seats;
  const used = (members.data?.filter((m) => m.status === 'active').length ?? 0) + (invites.data?.length ?? 0);

  return (
    <>
      <PageHeader title="Team Members" description="Invite staff and control what they can access."
        actions={canInvite && <Button onClick={() => { setInviteLink(null); setInviteOpen(true); }}><UserPlus /> Invite member</Button>} />

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Members</CardTitle>
            {seatLimit !== undefined && <CardDescription>{used} of {seatLimit} seats used on the {b.subscription!.plan.name} plan</CardDescription>}
          </div>
        </CardHeader>
        {members.isLoading ? <CardContent><Skeleton className="h-32" /></CardContent> : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Role</Th><Th className="hidden sm:table-cell">Status</Th><Th className="hidden md:table-cell">Joined</Th><Th className="w-12"><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {members.data?.map((m) => {
                const isMe = m.userId === me?.id;
                const canManage = !isMe && manageable.includes(m.role);
                return (
                  <tr key={m.id}>
                    <Td>
                      <div className="flex items-center gap-3">
                        <Avatar name={m.fullName || m.email} />
                        <div className="min-w-0"><p className="truncate font-medium">{m.fullName || '—'} {isMe && <span className="text-xs text-muted-foreground">(you)</span>}</p><p className="truncate text-xs text-muted-foreground">{m.email}</p></div>
                      </div>
                    </Td>
                    <Td><Badge tone={roleTone[m.role]}>{ROLE_LABELS[m.role]}</Badge></Td>
                    <Td className="hidden sm:table-cell"><Badge tone={m.status === 'active' ? 'green' : 'amber'}>{m.status}</Badge></Td>
                    <Td className="hidden text-muted-foreground md:table-cell">{formatDate(m.createdAt, b.timezone)}</Td>
                    <Td>
                      {canManage && (
                        <DropdownMenu>
                          <DropdownTrigger asChild><Button variant="ghost" size="icon" aria-label={`Manage ${m.email}`}><MoreHorizontal /></Button></DropdownTrigger>
                          <DropdownContent>
                            {manageable.filter((r) => r !== m.role).map((r) => (
                              <DropdownItem key={r} onSelect={() => updateMember.mutate({ id: m.id, body: { role: r } })}>Make {ROLE_LABELS[r]}</DropdownItem>
                            ))}
                            <DropdownItem onSelect={() => updateMember.mutate({ id: m.id, body: { status: m.status === 'active' ? 'disabled' : 'active' } })}>
                              {m.status === 'active' ? 'Disable access' : 'Re-enable access'}
                            </DropdownItem>
                            <DropdownSeparator />
                            <DropdownItem className="text-destructive" onSelect={() => setRemoving(m)}><Trash2 className="!text-destructive" /> Remove from workspace</DropdownItem>
                          </DropdownContent>
                        </DropdownMenu>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {canInvite && (
        <Card className="mt-6">
          <CardHeader><CardTitle>Pending invitations</CardTitle></CardHeader>
          <CardContent>
            {invites.data?.length === 0 ? (
              <EmptyState icon={<Users />} title="No pending invitations" description="Invite managers and agents to collaborate on campaigns and conversations." />
            ) : (
              <ul className="divide-y">
                {invites.data?.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-3 py-3">
                    <MailPlus className="size-4 text-muted-foreground" />
                    <span className="flex-1 text-sm"><span className="font-medium">{i.email}</span> · {ROLE_LABELS[i.role]} <span className="text-muted-foreground">· expires {formatDate(i.expiresAt, b.timezone)}</span></span>
                    <Button variant="outline" size="sm" loading={revokeInvite.isPending && revokeInvite.variables === i.id} onClick={() => revokeInvite.mutate(i.id)}>Revoke</Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} roles={invitableRoles(b.myRole)} link={inviteLink}
        onInvited={async (link) => { setInviteLink(link); await refresh(); }} businessId={b.id} />

      <ConfirmDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} destructive title="Remove team member?"
        description={`${removing?.email} will immediately lose access to ${b.name}.`} confirmLabel="Remove"
        loading={removeMember.isPending} onConfirm={() => removing && removeMember.mutate(removing.id)} />
    </>
  );
}

function InviteDialog({ open, onOpenChange, roles, link, onInvited, businessId }: {
  open: boolean; onOpenChange: (o: boolean) => void; roles: Array<'manager' | 'agent'>; link: string | null; onInvited: (link: string) => void; businessId: string;
}) {
  const form = useForm<InviteMemberInput>({ resolver: zodResolver(inviteMemberSchema), defaultValues: { email: '', role: roles.includes('agent') ? 'agent' : roles[0] } });
  const submit = form.handleSubmit(async (v) => {
    try {
      const r = await post<{ inviteUrl: string }>(`/v1/businesses/${businessId}/invitations`, v);
      form.reset({ email: '', role: v.role });
      onInvited(r.inviteUrl);
    } catch (err) { handleFormError(err, form.setError); }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={link ? 'Invitation created' : 'Invite a team member'}
      description={link ? 'Share this one-time link with your team member. It expires in 7 days and only works for the invited email.' : 'They will join this workspace with the role you choose.'}>
      {link ? (
        <div className="space-y-4">
          <div className="flex gap-2"><Input readOnly value={link} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
            <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(link); toast.success('Link copied'); }}><Copy /> Copy</Button></div>
          <p className="text-xs text-muted-foreground">Automatic invitation emails are not configured yet, so please share this link yourself (for example over WhatsApp or email).</p>
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onInvited('') /* reset */}>Invite another</Button><Button onClick={() => onOpenChange(false)}>Done</Button></div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field id="invite-email" label="Email" error={form.formState.errors.email?.message}><Input id="invite-email" type="email" {...form.register('email')} /></Field>
          <Field id="invite-role" label="Role" error={form.formState.errors.role?.message}>
            <NativeSelect id="invite-role" {...form.register('role')}>{roles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</NativeSelect>
          </Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" loading={form.formState.isSubmitting}>Create invitation</Button></div>
        </form>
      )}
    </Dialog>
  );
}
