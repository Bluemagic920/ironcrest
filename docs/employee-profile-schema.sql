-- Extend existing profiles without changing existing memberships, grants or policies.
begin;
alter table public.ironcrest_employee_profiles add column revision bigint not null default 1 check(revision>0);
create function public.ironcrest_employee_profile_revision() returns trigger
 language plpgsql security invoker set search_path='' as $$
begin new.revision:=old.revision+1;new.updated_at:=clock_timestamp();return new;end;
$$;
revoke all on function public.ironcrest_employee_profile_revision() from public,anon,authenticated;
create trigger ironcrest_profile_revision before update on public.ironcrest_employee_profiles
 for each row execute function public.ironcrest_employee_profile_revision();

create table public.ironcrest_employee_profile_events(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,
 membership_id uuid not null,actor_user_id uuid not null,profile_revision bigint not null,
 action text not null check(action in ('owner_edit','employee_contact_edit')),
 created_at timestamptz not null default now()
);
create index ironcrest_employee_profile_events_org_time on public.ironcrest_employee_profile_events(organization_id,created_at);
alter table public.ironcrest_employee_profile_events enable row level security;
revoke all on public.ironcrest_employee_profile_events from public,anon,authenticated;
grant select,insert on public.ironcrest_employee_profile_events to service_role;

create function public.ironcrest_update_employee_profile(
 p_actor uuid,p_organization_id uuid,p_membership_id uuid,p_expected_revision bigint,
 p_changes jsonb,p_self boolean default false
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_profile public.ironcrest_employee_profiles%rowtype; v_member public.ironcrest_memberships%rowtype;
 v_first text;v_last text;v_job text;v_status text;v_phone text;v_email text;v_keys text[];
begin
 if current_user<>'service_role' then raise insufficient_privilege; end if;
 if p_self is null or p_expected_revision is null or p_expected_revision<0 or p_expected_revision>9007199254740990
  or p_changes is null or jsonb_typeof(p_changes)<>'object' then return jsonb_build_object('ok',false,'error','invalid_profile');end if;
 select array_agg(key order by key) into v_keys from jsonb_object_keys(p_changes) as key;
 if p_self then
  if v_keys is distinct from array['email','phoneNumber'] then return jsonb_build_object('ok',false,'error','contact_fields_only');end if;
 else
  if v_keys is distinct from array['email','employmentStatus','firstName','jobTitle','lastName','phoneNumber'] then return jsonb_build_object('ok',false,'error','invalid_profile');end if;
 end if;
 if exists(select 1 from jsonb_each(p_changes) where jsonb_typeof(value)<>'string') then return jsonb_build_object('ok',false,'error','invalid_profile');end if;
 v_phone:=nullif(btrim(p_changes->>'phoneNumber'),'');v_email:=nullif(btrim(p_changes->>'email'),'');
 if v_phone is not null and (length(v_phone) not between 7 and 30 or v_phone!~'^[+0-9() .-]+$')
  or v_email is not null and (length(v_email)>254 or v_email~'[[:cntrl:]]' or v_email!~'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
  then return jsonb_build_object('ok',false,'error','invalid_contact_details');end if;
 if not p_self then
  v_first:=btrim(p_changes->>'firstName');v_last:=btrim(p_changes->>'lastName');v_job:=nullif(btrim(p_changes->>'jobTitle'),'');v_status:=p_changes->>'employmentStatus';
  if length(v_first) not between 1 and 100 or length(v_last) not between 1 and 100
   or v_first~'[[:cntrl:]]' or v_last~'[[:cntrl:]]' or length(v_job)>120 or v_job~'[[:cntrl:]]'
   or v_status not in ('active','inactive','on_leave') then return jsonb_build_object('ok',false,'error','invalid_profile');end if;
  perform 1 from public.ironcrest_organizations where id=p_organization_id and created_by=p_actor for share;
  if not found then return jsonb_build_object('ok',false,'error','owner_required');end if;
  perform 1 from public.ironcrest_memberships where organization_id=p_organization_id and user_id=p_actor and role='owner' and active for share;
  if not found or (select count(*) from public.ironcrest_memberships where user_id=p_actor and role='owner' and active)<>1 then return jsonb_build_object('ok',false,'error','owner_required');end if;
 end if;
 select * into v_member from public.ironcrest_memberships where id=p_membership_id and organization_id=p_organization_id and role='employee' for update;
 if not found then return jsonb_build_object('ok',false,'error','employee_not_found');end if;
 if p_self and (v_member.user_id is distinct from p_actor or not v_member.active
  or (select count(*) from public.ironcrest_memberships where user_id=p_actor and role='employee' and active)<>1)
  then return jsonb_build_object('ok',false,'error','active_employee_required');end if;
 if not exists(select 1 from public.ironcrest_business_entitlement(p_organization_id) where business_active)
  then return jsonb_build_object('ok',false,'error','business_access_required');end if;
 select * into v_profile from public.ironcrest_employee_profiles where membership_id=p_membership_id and organization_id=p_organization_id for update;
 if not found then
  if p_self then return jsonb_build_object('ok',false,'error','profile_not_ready');end if;
  if p_expected_revision<>0 then return jsonb_build_object('ok',false,'error','profile_conflict');end if;
  insert into public.ironcrest_employee_profiles(organization_id,membership_id,first_name,last_name,job_title,employment_status,phone_number,email)
   values(p_organization_id,p_membership_id,v_first,v_last,v_job,v_status,v_phone,v_email) returning * into v_profile;
 else
  if v_profile.revision<>p_expected_revision then return jsonb_build_object('ok',false,'error','profile_conflict');end if;
  if p_self then
   update public.ironcrest_employee_profiles set phone_number=v_phone,email=v_email where id=v_profile.id returning * into v_profile;
  else
   update public.ironcrest_employee_profiles set first_name=v_first,last_name=v_last,job_title=v_job,employment_status=v_status,phone_number=v_phone,email=v_email
    where id=v_profile.id returning * into v_profile;
  end if;
 end if;
 insert into public.ironcrest_employee_profile_events(organization_id,membership_id,actor_user_id,profile_revision,action)
  values(p_organization_id,p_membership_id,p_actor,v_profile.revision,case when p_self then 'employee_contact_edit' else 'owner_edit' end);
 return jsonb_build_object('ok',true,'revision',v_profile.revision,'profile',jsonb_build_object(
  'firstName',v_profile.first_name,'lastName',v_profile.last_name,'jobTitle',v_profile.job_title,'employmentStatus',v_profile.employment_status,
  'phoneNumber',v_profile.phone_number,'email',v_profile.email,'revision',v_profile.revision));
end;
$$;
revoke all on function public.ironcrest_update_employee_profile(uuid,uuid,uuid,bigint,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.ironcrest_update_employee_profile(uuid,uuid,uuid,bigint,jsonb,boolean) to service_role;
commit;
