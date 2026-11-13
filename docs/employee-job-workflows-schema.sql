-- Server-only wrapper around the existing atomic transition; no rows or grants widened.
begin;
create function public.ironcrest_employee_job_workflow(p_actor uuid,p_job_id uuid,p_expected_updated_at timestamptz,p_action text)
 returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_member public.ironcrest_memberships%rowtype;v_count integer;v_business boolean;
begin
 if current_user<>'service_role' then raise insufficient_privilege;end if;
 if p_action not in ('start','complete') or p_expected_updated_at is null or p_job_id is null then raise exception 'Invalid transition';end if;
 select count(*) into v_count from public.ironcrest_memberships where user_id=p_actor and active;
 if v_count<>1 then raise exception 'Exactly one active employee membership required';end if;
 select * into v_member from public.ironcrest_memberships where user_id=p_actor and role='employee' and active for share;
 if not found then raise exception 'Employee membership required';end if;
 -- The active owner and employee locks make revocation serialize with this action.
 perform 1 from public.ironcrest_organizations o join public.ironcrest_memberships m
  on m.organization_id=o.id and m.user_id=o.created_by and m.role='owner' and m.active
  where o.id=v_member.organization_id for share of m;
 if not found then raise exception 'Active company owner required';end if;
 select business_active into v_business from public.ironcrest_business_entitlement(v_member.organization_id);
 if v_business is distinct from true then raise exception 'Business access required';end if;
 -- Existing implementation locks job, compares exact version, enforces assignment and
 -- pending -> in_progress -> completed, and commits status/event/outbox together.
 return public.ironcrest_employee_transition_job(p_actor,v_member.id,v_member.organization_id,p_job_id,p_expected_updated_at,p_action);
end;
$$;
revoke all on function public.ironcrest_employee_job_workflow(uuid,uuid,timestamptz,text) from public,anon,authenticated;
grant execute on function public.ironcrest_employee_job_workflow(uuid,uuid,timestamptz,text) to service_role;
commit;
