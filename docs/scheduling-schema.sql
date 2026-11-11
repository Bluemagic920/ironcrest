-- Isolated scheduling data; no attendance, payroll, or permission changes.
begin;
create table public.ironcrest_scheduled_shifts (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.ironcrest_organizations(id),
 employee_user_id uuid not null references auth.users(id),
 worksite_id uuid not null references public.ironcrest_worksites(id),
 title text not null check(length(btrim(title)) between 1 and 120),
 starts_at timestamptz not null, ends_at timestamptz not null,
 time_zone text not null check(length(time_zone) between 1 and 100),
 status text not null default 'draft' check(status in ('draft','published','cancelled')),
 revision bigint not null default 1 check(revision>0),
 published_at timestamptz, cancelled_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 updated_by uuid not null references auth.users(id),
 check(ends_at>starts_at and ends_at<=starts_at+interval '24 hours'),
 check((status='draft' and published_at is null and cancelled_at is null) or
       (status='published' and published_at is not null and cancelled_at is null) or
       (status='cancelled' and cancelled_at is not null))
);
create index ironcrest_scheduled_shifts_org_start on public.ironcrest_scheduled_shifts(organization_id,starts_at,id);
create index ironcrest_scheduled_shifts_employee_start on public.ironcrest_scheduled_shifts(organization_id,employee_user_id,starts_at) where published_at is not null;
alter table public.ironcrest_scheduled_shifts enable row level security;
revoke all on public.ironcrest_scheduled_shifts from public,anon,authenticated;
grant select,insert,update on public.ironcrest_scheduled_shifts to service_role;

create function public.ironcrest_schedule_action(
 p_actor uuid,p_organization_id uuid,p_action text,p_shift_id uuid,p_expected_revision bigint,
 p_employee uuid default null,p_worksite uuid default null,p_title text default null,
 p_starts_at timestamptz default null,p_ends_at timestamptz default null,p_time_zone text default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_shift public.ironcrest_scheduled_shifts%rowtype; v_zone text; v_title text:=btrim(p_title);
begin
 if current_user<>'service_role' then raise insufficient_privilege; end if;
 if p_action is null or p_action not in ('save_draft','publish','cancel') or p_expected_revision is null
   or p_expected_revision<0 or p_expected_revision>9007199254740990 then
   return jsonb_build_object('ok',false,'error','invalid_schedule'); end if;
 perform 1 from public.ironcrest_organizations where id=p_organization_id and created_by=p_actor for update;
 if not found then return jsonb_build_object('ok',false,'error','owner_required'); end if;
 perform 1 from public.ironcrest_memberships where organization_id=p_organization_id and user_id=p_actor and role='owner' and active for share;
 if not found or (select count(*) from public.ironcrest_memberships where user_id=p_actor and role='owner' and active)<>1 then
  return jsonb_build_object('ok',false,'error','owner_required'); end if;
 if not exists(select 1 from public.ironcrest_business_entitlement(p_organization_id) where business_active) then
  return jsonb_build_object('ok',false,'error','business_access_required'); end if;
 if p_shift_id is not null then
  select * into v_shift from public.ironcrest_scheduled_shifts where id=p_shift_id and organization_id=p_organization_id for update;
  if not found then return jsonb_build_object('ok',false,'error','shift_not_found'); end if;
  if v_shift.revision<>p_expected_revision then return jsonb_build_object('ok',false,'error','schedule_conflict'); end if;
 elsif p_expected_revision<>0 or p_action<>'save_draft' then
  return jsonb_build_object('ok',false,'error','invalid_schedule');
 end if;
 if p_action='cancel' then
  if v_shift.status='cancelled' then return jsonb_build_object('ok',false,'error','schedule_conflict'); end if;
  update public.ironcrest_scheduled_shifts set status='cancelled',cancelled_at=now(),revision=revision+1,updated_at=now(),updated_by=p_actor
   where id=v_shift.id returning * into v_shift;
 elsif p_action='publish' then
  if v_shift.status<>'draft' then return jsonb_build_object('ok',false,'error','schedule_conflict'); end if;
  perform 1 from public.ironcrest_memberships where organization_id=p_organization_id and user_id=v_shift.employee_user_id and role='employee' and active for share;
  if not found then return jsonb_build_object('ok',false,'error','active_employee_required'); end if;
  perform 1 from public.ironcrest_worksites where id=v_shift.worksite_id and organization_id=p_organization_id and active for share;
  if not found then return jsonb_build_object('ok',false,'error','active_worksite_required'); end if;
  if v_shift.starts_at<=now() then return jsonb_build_object('ok',false,'error','future_shift_required'); end if;
  if exists(select 1 from public.ironcrest_scheduled_shifts s where s.organization_id=p_organization_id
    and s.employee_user_id=v_shift.employee_user_id and s.status='published' and s.id<>v_shift.id
    and s.starts_at<v_shift.ends_at and s.ends_at>v_shift.starts_at) then
   return jsonb_build_object('ok',false,'error','employee_schedule_overlap'); end if;
  update public.ironcrest_scheduled_shifts set status='published',published_at=now(),revision=revision+1,updated_at=now(),updated_by=p_actor
   where id=v_shift.id returning * into v_shift;
 else
  if p_shift_id is not null and v_shift.status<>'draft' then return jsonb_build_object('ok',false,'error','published_shift_read_only'); end if;
  select coalesce((select time_zone from public.ironcrest_company_settings where organization_id=p_organization_id),'UTC') into v_zone;
  if p_time_zone is distinct from v_zone then return jsonb_build_object('ok',false,'error','company_time_zone_changed'); end if;
  if v_title is null or length(v_title) not between 1 and 120 or v_title~'[[:cntrl:]]'
    or p_starts_at is null or not isfinite(p_starts_at) or p_ends_at is null or not isfinite(p_ends_at)
    or p_starts_at<=now() or p_ends_at<=p_starts_at or p_ends_at>p_starts_at+interval '24 hours'
    then return jsonb_build_object('ok',false,'error','invalid_schedule'); end if;
  perform 1 from public.ironcrest_memberships where organization_id=p_organization_id and user_id=p_employee and role='employee' and active for share;
  if not found then return jsonb_build_object('ok',false,'error','active_employee_required'); end if;
  perform 1 from public.ironcrest_worksites where id=p_worksite and organization_id=p_organization_id and active for share;
  if not found then return jsonb_build_object('ok',false,'error','active_worksite_required'); end if;
  if p_shift_id is null then
   insert into public.ironcrest_scheduled_shifts(organization_id,employee_user_id,worksite_id,title,starts_at,ends_at,time_zone,updated_by)
    values(p_organization_id,p_employee,p_worksite,v_title,p_starts_at,p_ends_at,v_zone,p_actor) returning * into v_shift;
  else
   update public.ironcrest_scheduled_shifts set employee_user_id=p_employee,worksite_id=p_worksite,title=v_title,starts_at=p_starts_at,ends_at=p_ends_at,time_zone=v_zone,
    revision=revision+1,updated_at=now(),updated_by=p_actor where id=v_shift.id returning * into v_shift;
  end if;
 end if;
 return jsonb_build_object('ok',true,'shift',to_jsonb(v_shift)-'organization_id'-'updated_by');
end;
$$;
revoke all on function public.ironcrest_schedule_action(uuid,uuid,text,uuid,bigint,uuid,uuid,text,timestamptz,timestamptz,text) from public,anon,authenticated;
grant execute on function public.ironcrest_schedule_action(uuid,uuid,text,uuid,bigint,uuid,uuid,text,timestamptz,timestamptz,text) to service_role;
commit;
