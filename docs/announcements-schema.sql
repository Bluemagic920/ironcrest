-- Company notices only; no notification delivery or employee/attendance changes.
begin;
create table public.ironcrest_announcements(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.ironcrest_organizations(id),
 title text not null check(length(btrim(title)) between 1 and 160),
 body text not null check(length(btrim(body)) between 1 and 5000),
 status text not null default 'draft' check(status in ('draft','published','archived')),
 revision bigint not null default 1 check(revision>0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 created_by uuid not null,updated_by uuid not null,published_at timestamptz,archived_at timestamptz,
 check((status='draft' and published_at is null and archived_at is null)
  or (status='published' and published_at is not null and archived_at is null)
  or (status='archived' and archived_at is not null))
);
create index ironcrest_announcements_org_created on public.ironcrest_announcements(organization_id,created_at desc,id desc);
create index ironcrest_announcements_published on public.ironcrest_announcements(organization_id,published_at desc,id desc) where status='published';
alter table public.ironcrest_announcements enable row level security;
revoke all on public.ironcrest_announcements from public,anon,authenticated;
grant select,insert,update on public.ironcrest_announcements to service_role;

create function public.ironcrest_announcement_action(
 p_actor uuid,p_organization_id uuid,p_action text,p_id uuid,p_expected_revision bigint,
 p_title text default null,p_body text default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_notice public.ironcrest_announcements%rowtype;v_title text:=btrim(p_title);v_body text:=btrim(p_body);
begin
 if current_user<>'service_role' then raise insufficient_privilege;end if;
 if p_action is null or p_action not in ('save_draft','publish','archive') or p_expected_revision is null
  or p_expected_revision<0 or p_expected_revision>9007199254740990 then return jsonb_build_object('ok',false,'error','invalid_announcement');end if;
 perform 1 from public.ironcrest_organizations where id=p_organization_id and created_by=p_actor for share;
 if not found then return jsonb_build_object('ok',false,'error','owner_required');end if;
 perform 1 from public.ironcrest_memberships where organization_id=p_organization_id and user_id=p_actor and role='owner' and active for share;
 if not found or (select count(*) from public.ironcrest_memberships where user_id=p_actor and role='owner' and active)<>1 then
  return jsonb_build_object('ok',false,'error','owner_required');end if;
 if not exists(select 1 from public.ironcrest_business_entitlement(p_organization_id) where business_active) then return jsonb_build_object('ok',false,'error','business_access_required');end if;
 if p_id is not null then
  select * into v_notice from public.ironcrest_announcements where id=p_id and organization_id=p_organization_id for update;
  if not found then return jsonb_build_object('ok',false,'error','announcement_not_found');end if;
  if v_notice.revision<>p_expected_revision then return jsonb_build_object('ok',false,'error','announcement_conflict');end if;
 elsif p_expected_revision<>0 or p_action<>'save_draft' then return jsonb_build_object('ok',false,'error','invalid_announcement');end if;
 if p_action='save_draft' then
  if p_id is not null and v_notice.status<>'draft' then return jsonb_build_object('ok',false,'error','published_announcement_read_only');end if;
  if v_title is null or length(v_title) not between 1 and 160 or v_title~'[[:cntrl:]]'
   or v_body is null or length(v_body) not between 1 and 5000
   or replace(replace(replace(v_body,chr(9),''),chr(10),''),chr(13),'')~'[[:cntrl:]]'
   then return jsonb_build_object('ok',false,'error','invalid_announcement');end if;
  if p_id is null then
   insert into public.ironcrest_announcements(organization_id,title,body,created_by,updated_by)
    values(p_organization_id,v_title,v_body,p_actor,p_actor) returning * into v_notice;
  else
   update public.ironcrest_announcements set title=v_title,body=v_body,revision=revision+1,updated_at=now(),updated_by=p_actor
    where id=v_notice.id returning * into v_notice;
  end if;
 elsif p_action='publish' then
  if v_notice.status<>'draft' then return jsonb_build_object('ok',false,'error','announcement_conflict');end if;
  update public.ironcrest_announcements set status='published',published_at=now(),revision=revision+1,updated_at=now(),updated_by=p_actor
   where id=v_notice.id returning * into v_notice;
 else
  if v_notice.status='archived' then return jsonb_build_object('ok',false,'error','announcement_conflict');end if;
  update public.ironcrest_announcements set status='archived',archived_at=now(),revision=revision+1,updated_at=now(),updated_by=p_actor
   where id=v_notice.id returning * into v_notice;
 end if;
 return jsonb_build_object('ok',true,'announcement',to_jsonb(v_notice)-'organization_id'-'created_by'-'updated_by');
end;
$$;
revoke all on function public.ironcrest_announcement_action(uuid,uuid,text,uuid,bigint,text,text) from public,anon,authenticated;
grant execute on function public.ironcrest_announcement_action(uuid,uuid,text,uuid,bigint,text,text) to service_role;
commit;
