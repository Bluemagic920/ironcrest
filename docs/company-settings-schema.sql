-- Company preferences only. Existing workforce records and permissions are unchanged.
begin;
create table public.ironcrest_company_settings (
  organization_id uuid primary key references public.ironcrest_organizations(id),
  time_zone text not null default 'UTC' check (length(time_zone) between 1 and 100),
  week_starts_on smallint not null default 1 check (week_starts_on between 0 and 6),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id)
);
alter table public.ironcrest_company_settings enable row level security;
revoke all on public.ironcrest_company_settings from public, anon, authenticated;
grant select, insert, update on public.ironcrest_company_settings to service_role;

create function public.ironcrest_save_company_settings(
  p_actor uuid, p_organization_id uuid, p_name text, p_time_zone text,
  p_week_starts_on integer, p_expected_revision bigint
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_revision bigint; v_result jsonb; v_name text := btrim(p_name);
begin
  if current_user <> 'service_role' then raise insufficient_privilege; end if;
  if p_expected_revision is null or p_expected_revision < 0 or p_expected_revision > 9007199254740990
    or v_name is null or length(v_name) not between 1 and 120
    or v_name ~ '[[:cntrl:]]' or p_time_zone is null
    or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone)
    or p_week_starts_on is null or p_week_starts_on not between 0 and 6
  then return jsonb_build_object('ok', false, 'error', 'invalid_settings'); end if;

  -- Lock the organization to serialize first-save and concurrent preference edits.
  perform 1 from public.ironcrest_organizations
    where id = p_organization_id and created_by = p_actor for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'owner_required'); end if;
  perform 1 from public.ironcrest_memberships
    where organization_id = p_organization_id and user_id = p_actor
      and role = 'owner' and active = true for share;
  if not found or (select count(*) from public.ironcrest_memberships
    where user_id = p_actor and role = 'owner' and active = true) <> 1
    then return jsonb_build_object('ok', false, 'error', 'owner_required'); end if;
  if not exists (select 1 from public.ironcrest_business_entitlement(p_organization_id) where business_active = true)
    then return jsonb_build_object('ok', false, 'error', 'business_access_required'); end if;

  select revision into v_revision from public.ironcrest_company_settings where organization_id = p_organization_id;
  if coalesce(v_revision, 0) <> p_expected_revision
    then return jsonb_build_object('ok', false, 'error', 'settings_conflict'); end if;
  update public.ironcrest_organizations set name = v_name where id = p_organization_id;
  insert into public.ironcrest_company_settings(organization_id,time_zone,week_starts_on,revision,updated_by)
    values(p_organization_id,p_time_zone,p_week_starts_on,1,p_actor)
    on conflict (organization_id) do update set time_zone = excluded.time_zone,
      week_starts_on = excluded.week_starts_on, revision = ironcrest_company_settings.revision + 1,
      updated_at = now(), updated_by = p_actor;
  select jsonb_build_object('name',v_name,'timeZone',s.time_zone,'weekStartsOn',s.week_starts_on,
    'revision',s.revision,'updatedAt',s.updated_at) into v_result
    from public.ironcrest_company_settings s where organization_id = p_organization_id;
  return jsonb_build_object('ok',true,'settings',v_result);
end;
$$;
revoke all on function public.ironcrest_save_company_settings(uuid,uuid,text,text,integer,bigint) from public,anon,authenticated;
grant execute on function public.ironcrest_save_company_settings(uuid,uuid,text,text,integer,bigint) to service_role;
commit;
