-- Reuse existing capacity and acceptance rules; preserve existing invitation rows.
begin;
alter table public.ironcrest_invitation_delivery_audit drop constraint ironcrest_delivery_status_check;
alter table public.ironcrest_invitation_delivery_audit add constraint ironcrest_delivery_status_check
 check(delivery_status in ('pending','sending','accepted','delivered','bounced','failed','cancelled','unknown'));
-- Keep the existing unique index; this additional stronger index also blocks uncertain sends.
create unique index ironcrest_delivery_one_active_or_unknown on public.ironcrest_invitation_delivery_audit(invitation_id)
 where delivery_status in ('pending','sending','accepted','delivered','unknown');
create index ironcrest_invitation_org_recent on public.ironcrest_invitations(organization_id,created_at);
create index ironcrest_invitation_recipient_recent on public.ironcrest_invitations(organization_id,lower(email),created_at);

create or replace function public.ironcrest_reserve_invitation_delivery(p_invitation_id uuid,p_organization_id uuid,p_recipient_email text)
 returns table(audit_id uuid,reservation_created boolean) language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'server-only function' using errcode='42501';end if;
 if not exists(select 1 from public.ironcrest_invitations i where i.id=p_invitation_id and i.organization_id=p_organization_id
  and lower(i.email)=lower(trim(p_recipient_email)) and i.status='pending' and i.revoked_at is null and i.expires_at>now())
  then raise exception 'invitation not eligible for delivery';end if;
 insert into public.ironcrest_invitation_delivery_audit(invitation_id,organization_id,recipient_email,provider,delivery_status,attempt_count)
  values(p_invitation_id,p_organization_id,lower(trim(p_recipient_email)),'resend','pending',0)
  on conflict(invitation_id) where delivery_status in ('pending','sending','accepted','delivered','unknown') do nothing returning id into v_id;
 if v_id is not null then return query select v_id,true;
 else return query select a.id,false from public.ironcrest_invitation_delivery_audit a
  where a.invitation_id=p_invitation_id and a.delivery_status in ('pending','sending','accepted','delivered','unknown') order by a.created_at desc limit 1;
 end if;
end;
$$;
revoke all on function public.ironcrest_reserve_invitation_delivery(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.ironcrest_reserve_invitation_delivery(uuid,uuid,text) to service_role;

create function public.ironcrest_owner_create_invitation(p_actor uuid,p_organization_id uuid,p_email text,p_token_hash text)
 returns uuid language plpgsql security invoker set search_path='' as $$
begin
 if current_user<>'service_role' then raise insufficient_privilege;end if;
 perform 1 from public.ironcrest_organizations where id=p_organization_id and created_by=p_actor for update;
 if not found then raise exception 'Owner authorization required';end if;
 perform 1 from public.ironcrest_memberships where organization_id=p_organization_id and user_id=p_actor and role='owner' and active for share;
 if not found or (select count(*) from public.ironcrest_memberships where user_id=p_actor and role='owner' and active)<>1 then raise exception 'Owner authorization required';end if;
 if (select count(*) from public.ironcrest_invitations where organization_id=p_organization_id and created_at>now()-interval '1 hour')>=30 then raise exception 'Organization invitation rate limit reached';end if;
 if (select count(*) from public.ironcrest_invitations where organization_id=p_organization_id and lower(email)=lower(trim(p_email)) and created_at>now()-interval '1 hour')>=3 then raise exception 'Recipient invitation rate limit reached';end if;
 return public.ironcrest_create_invitation(p_organization_id,p_actor,p_email,'employee',p_token_hash);
end;
$$;
revoke all on function public.ironcrest_owner_create_invitation(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.ironcrest_owner_create_invitation(uuid,uuid,text,text) to service_role;

create function public.ironcrest_owner_revoke_invitation(p_actor uuid,p_organization_id uuid,p_invitation_id uuid)
 returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_inv public.ironcrest_invitations%rowtype;
begin
 if current_user<>'service_role' then raise insufficient_privilege;end if;
 perform 1 from public.ironcrest_organizations where id=p_organization_id and created_by=p_actor for update;
 if not found then return jsonb_build_object('ok',false,'error','owner_required');end if;
 perform 1 from public.ironcrest_memberships where organization_id=p_organization_id and user_id=p_actor and role='owner' and active for share;
 if not found or (select count(*) from public.ironcrest_memberships where user_id=p_actor and role='owner' and active)<>1 then return jsonb_build_object('ok',false,'error','owner_required');end if;
 select * into v_inv from public.ironcrest_invitations where id=p_invitation_id and organization_id=p_organization_id for update;
 if not found then return jsonb_build_object('ok',false,'error','invitation_not_found');end if;
 if v_inv.status='revoked' then return jsonb_build_object('ok',true,'revoked',true);end if;
 if v_inv.status<>'pending' then return jsonb_build_object('ok',false,'error','invitation_not_pending');end if;
 update public.ironcrest_invitations set status='revoked',revoked_at=now() where id=v_inv.id;
 return jsonb_build_object('ok',true,'revoked',true);
end;
$$;
revoke all on function public.ironcrest_owner_revoke_invitation(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.ironcrest_owner_revoke_invitation(uuid,uuid,uuid) to service_role;
commit;
