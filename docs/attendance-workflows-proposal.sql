-- NOT DEPLOYED. General attendance activation requires tested release approval.
-- Service-only request journal; coordinates are checked transiently, never stored.
begin;
create table public.ironcrest_attendance_operations (
 actor_user_id uuid not null references auth.users(id),
 operation_id uuid not null,
 organization_id uuid not null references public.ironcrest_organizations(id),
 worksite_id uuid not null references public.ironcrest_worksites(id),
 action text not null check(action in ('clock_in','clock_out')),
 expected_entry_id uuid,
 result jsonb not null,
 created_at timestamptz not null default now(),
 primary key(actor_user_id,operation_id)
);
alter table public.ironcrest_attendance_operations enable row level security;
revoke all on public.ironcrest_attendance_operations from public,anon,authenticated;
grant select,insert on public.ironcrest_attendance_operations to service_role;

create function public.ironcrest_attendance_workflow(
 p_actor uuid,p_operation_id uuid,p_worksite_id uuid,p_action text,p_expected_entry_id uuid,
 p_latitude double precision,p_longitude double precision,p_accuracy_m double precision,p_sample_at timestamptz
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 v_member public.ironcrest_memberships%rowtype;
 v_site public.ironcrest_worksites%rowtype;
 v_prior public.ironcrest_attendance_operations%rowtype;
 v_entry uuid; v_time timestamptz; v_result jsonb; v_distance double precision; v_h double precision;
begin
 if current_user<>'service_role' then raise insufficient_privilege;end if;
 if p_actor is null or p_operation_id is null or p_worksite_id is null or p_action is null
  or p_action not in ('clock_in','clock_out')
  or (p_action='clock_in' and p_expected_entry_id is not null)
  or (p_action='clock_out' and p_expected_entry_id is null)
 then raise exception 'Invalid attendance request';end if;
 -- Serialize new operations and replays for this actor, including different operation IDs.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_actor::text,181));
 select * into v_member from public.ironcrest_memberships
  where user_id=p_actor and role='employee' and active for update;
 if not found or (select count(*) from public.ironcrest_memberships where user_id=p_actor and active)<>1
 then raise exception 'One active employee membership required';end if;
 perform 1 from public.ironcrest_organizations o join public.ironcrest_memberships m
  on m.organization_id=o.id and m.user_id=o.created_by and m.role='owner' and m.active
  where o.id=v_member.organization_id for share of m;
 if not found then raise exception 'Active company owner required';end if;
 if not exists(select 1 from public.ironcrest_business_entitlement(v_member.organization_id) where business_active)
 then raise exception 'Business access required';end if;
 -- A replay never performs another write, but still requires current company access.
 select * into v_prior from public.ironcrest_attendance_operations
  where actor_user_id=p_actor and operation_id=p_operation_id;
 if found then
  if v_prior.organization_id<>v_member.organization_id or v_prior.worksite_id<>p_worksite_id
   or v_prior.action<>p_action or v_prior.expected_entry_id is distinct from p_expected_entry_id
  then raise exception 'Operation parameters changed';end if;
  return v_prior.result || jsonb_build_object('replayed',true);
 end if;
 select * into v_site from public.ironcrest_worksites
  where id=p_worksite_id and organization_id=v_member.organization_id and active for share;
 if not found then raise exception 'Active company worksite required';end if;
 perform 1 from public.ironcrest_employee_worksite_assignments
  where membership_id=v_member.id and organization_id=v_member.organization_id
   and worksite_id=p_worksite_id and active for share;
 if not found then raise exception 'Active worksite assignment required';end if;
 v_time:=clock_timestamp();
 -- Bounds also reject PostgreSQL NaN and infinity values.
 if p_sample_at is null or not isfinite(p_sample_at) or p_sample_at>v_time+interval '5 seconds'
  or p_sample_at<v_time-interval '30 seconds'
  or p_latitude is null or not(p_latitude between -90 and 90)
  or p_longitude is null or not(p_longitude between -180 and 180)
  or p_accuracy_m is null or not(p_accuracy_m between 0 and 100)
  or v_site.latitude is null or not(v_site.latitude between -90 and 90)
  or v_site.longitude is null or not(v_site.longitude between -180 and 180)
  or v_site.radius_m is null or not(v_site.radius_m>0 and v_site.radius_m<=100000)
 then raise exception 'Fresh accurate location required';end if;
 v_h:=power(sin(radians(p_latitude-v_site.latitude)/2),2)
  +cos(radians(p_latitude))*cos(radians(v_site.latitude))*power(sin(radians(p_longitude-v_site.longitude)/2),2);
 v_distance:=6371000*2*asin(sqrt(least(1::double precision,greatest(0::double precision,v_h))));
 if v_distance+p_accuracy_m>v_site.radius_m then raise exception 'Location is outside or uncertain';end if;
 if p_action='clock_in' then
  insert into public.ironcrest_attendance_entries(organization_id,employee_user_id,worksite_id,clock_in_at,clock_in_method)
   values(v_member.organization_id,p_actor,p_worksite_id,v_time,'geofence') returning id into v_entry;
  v_result:=jsonb_build_object('entryId',v_entry,'clockInAt',v_time,'action',p_action,'operationId',p_operation_id,'replayed',false);
 else
  -- Exact shift identity prevents a delayed request from closing a later shift.
  update public.ironcrest_attendance_entries set clock_out_at=greatest(v_time,clock_in_at),clock_out_method='geofence',updated_at=v_time
   where id=p_expected_entry_id and employee_user_id=p_actor and organization_id=v_member.organization_id
    and worksite_id=p_worksite_id and clock_out_at is null returning id,clock_out_at into v_entry,v_time;
  if v_entry is null then raise exception 'Expected open shift was not found';end if;
  v_result:=jsonb_build_object('entryId',v_entry,'clockOutAt',v_time,'action',p_action,'operationId',p_operation_id,'replayed',false);
 end if;
 insert into public.ironcrest_attendance_audit(organization_id,attendance_entry_id,actor_user_id,action,details)
  values(v_member.organization_id,v_entry,p_actor,p_action,jsonb_build_object('method','geofence','operation_id',p_operation_id));
 insert into public.ironcrest_attendance_operations(actor_user_id,operation_id,organization_id,worksite_id,action,expected_entry_id,result)
  values(p_actor,p_operation_id,v_member.organization_id,p_worksite_id,p_action,p_expected_entry_id,v_result);
 return v_result;
end;
$$;
revoke all on function public.ironcrest_attendance_workflow(uuid,uuid,uuid,text,uuid,double precision,double precision,double precision,timestamptz) from public,anon,authenticated;
grant execute on function public.ironcrest_attendance_workflow(uuid,uuid,uuid,text,uuid,double precision,double precision,double precision,timestamptz) to service_role;
commit;
