-- Review artifact; apply to a disposable database first. Not applied to hosted Supabase.
-- Customer mapping must be enrolled by trusted checkout code after verified authentication.
begin;
create table public.ironcrest_billing_customers (
 mode text not null check(mode in ('test','live')),
 customer_id text not null check(customer_id ~ '^cus_[A-Za-z0-9]+$'),
 owner_user_id uuid not null references auth.users(id),
 organization_id uuid not null references public.ironcrest_organizations(id),
 subscription_id text check(subscription_id ~ '^sub_[A-Za-z0-9]+$'),
 unlimited_subscription_id text check(unlimited_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
 lease_token uuid,lease_until timestamptz,
 review_required boolean not null default false,
 primary key(mode,customer_id),unique(mode,owner_user_id),unique(mode,organization_id)
);
create table public.ironcrest_billing_events (
 mode text not null,event_id text not null check(event_id ~ '^evt_[A-Za-z0-9]+$'),
 customer_id text not null,event_type text not null,outcome text not null check(outcome in ('committed','review')),
 created_at timestamptz not null default clock_timestamp(),
 primary key(mode,event_id),foreign key(mode,customer_id) references public.ironcrest_billing_customers(mode,customer_id)
);
create table public.ironcrest_billing_snapshots (
 mode text not null,customer_id text not null,subscription_id text not null,
 subscription_type text not null check(subscription_type in ('business','unlimited_employees')),
 status text not null,business_active boolean not null,unlimited_employees boolean not null,
 employee_limit integer not null check(employee_limit between 0 and 100000),
 current_period_end timestamptz not null,cancel_at_period_end boolean not null,
 updated_at timestamptz not null default clock_timestamp(),
 primary key(mode,customer_id,subscription_type),foreign key(mode,customer_id) references public.ironcrest_billing_customers(mode,customer_id)
);
alter table public.ironcrest_billing_customers enable row level security;
alter table public.ironcrest_billing_events enable row level security;
alter table public.ironcrest_billing_snapshots enable row level security;
revoke all on public.ironcrest_billing_customers,public.ironcrest_billing_events,public.ironcrest_billing_snapshots from public,anon,authenticated;
grant select,insert,update on public.ironcrest_billing_customers,public.ironcrest_billing_snapshots to service_role;
grant select,insert on public.ironcrest_billing_events to service_role;

create function public.ironcrest_billing_preserve_customer_mapping() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if row(new.mode,new.customer_id,new.owner_user_id,new.organization_id) is distinct from row(old.mode,old.customer_id,old.owner_user_id,old.organization_id)
 then raise exception 'Billing customer mapping is immutable';end if;
 return new;
end;
$$;
revoke all on function public.ironcrest_billing_preserve_customer_mapping() from public,anon,authenticated;
grant execute on function public.ironcrest_billing_preserve_customer_mapping() to service_role;
create trigger ironcrest_billing_immutable_customer before update on public.ironcrest_billing_customers
for each row execute function public.ironcrest_billing_preserve_customer_mapping();

create function public.ironcrest_billing_event_operation(
 p_mode text,p_customer_id text,p_operation text,p_token uuid default null,p_data jsonb default '{}'::jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare c public.ironcrest_billing_customers%rowtype;e public.ironcrest_billing_events%rowtype;
 s jsonb;v_end timestamptz;v_subscription text;v_event text;v_type text;v_token uuid;v_kind text;v_pin text;
begin
 if current_user<>'service_role' then raise insufficient_privilege;end if;
 if p_mode is null or p_mode not in ('test','live') or p_customer_id is null
  or p_customer_id !~ '^cus_[A-Za-z0-9]+$' or jsonb_typeof(p_data) is distinct from 'object'
 then raise exception 'Invalid billing operation';end if;
 select * into c from public.ironcrest_billing_customers where mode=p_mode and customer_id=p_customer_id for update;
 if not found then
  if p_operation='mapped' then return jsonb_build_object('mapped',false);end if;
  raise exception 'Unmapped billing customer';
 end if;
 if p_operation='release' then
  if c.lease_token=p_token then update public.ironcrest_billing_customers set lease_token=null,lease_until=null where mode=p_mode and customer_id=p_customer_id;end if;
  return jsonb_build_object('ok',true);
 end if;
 -- Recheck current owner membership, including duplicate active memberships.
 if not exists(select 1 from public.ironcrest_organizations o join public.ironcrest_memberships m
  on m.organization_id=o.id and m.user_id=o.created_by and m.role='owner' and m.active
  where o.id=c.organization_id and o.created_by=c.owner_user_id)
  or (select count(*) from public.ironcrest_memberships where user_id=c.owner_user_id and active)<>1
 then raise exception 'Active unambiguous owner mapping required';end if;
 if p_operation='mapped' then return jsonb_build_object('mapped',true);end if;
 if p_operation='acquire' then
  if c.lease_token is not null and c.lease_until>clock_timestamp() then raise exception 'Billing busy';end if;
  v_token:=gen_random_uuid();
  update public.ironcrest_billing_customers set lease_token=v_token,lease_until=clock_timestamp()+interval '120 seconds'
   where mode=p_mode and customer_id=p_customer_id;
  return jsonb_build_object('token',v_token);
 end if;
 if p_token is null or c.lease_token is distinct from p_token or c.lease_until is null or c.lease_until<=clock_timestamp()
 then raise exception 'Expired billing lease';end if;
 if p_operation='is_tracked' then
  if coalesce(p_data->>'subscriptionId','') !~ '^sub_[A-Za-z0-9]+$' then raise exception 'Invalid subscription';end if;
  return jsonb_build_object('tracked',coalesce(c.subscription_id=p_data->>'subscriptionId',false) or coalesce(c.unlimited_subscription_id=p_data->>'subscriptionId',false));
 end if;
 v_event:=p_data->>'eventId';v_type:=p_data->>'eventType';
 if v_event is null or v_event !~ '^evt_[A-Za-z0-9]+$' or v_type is null or length(v_type)>100 then raise exception 'Invalid event';end if;
 select * into e from public.ironcrest_billing_events where mode=p_mode and event_id=v_event;
 if found then
  if e.customer_id<>p_customer_id or e.event_type<>v_type then raise exception 'Event identity conflict';end if;
  return jsonb_build_object('exists',true,'duplicate',true,'ok',true);
 end if;
 if p_operation='has_event' then return jsonb_build_object('exists',false);end if;
 if p_operation not in ('commit','review') then raise exception 'Invalid event operation';end if;
 v_subscription:=case when p_operation='commit' then p_data->'snapshot'->>'stripe_subscription_id' else p_data->>'subscriptionId' end;
 if v_subscription is null or v_subscription !~ '^sub_[A-Za-z0-9]+$' then raise exception 'Invalid subscription';end if;
 -- Pin base and separate unlimited subscriptions independently; never replace either silently.
 v_kind:=coalesce(p_data->'snapshot'->>'subscription_type','business');
 if v_kind not in ('business','unlimited_employees') then raise exception 'Invalid subscription type';end if;
 v_pin:=case when v_kind='business' then c.subscription_id else c.unlimited_subscription_id end;
 if p_operation='commit' and v_pin is not null and v_pin<>v_subscription then raise exception 'Subscription replacement requires reconciliation';end if;
 if p_operation='review' then
  update public.ironcrest_billing_customers set review_required=true where mode=p_mode and customer_id=p_customer_id;
 else
  s:=p_data->'snapshot';
  if jsonb_typeof(s) is distinct from 'object' or s->>'stripe_customer_id' is distinct from p_customer_id
   or s->>'status' is null or s->>'status' not in ('active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired','paused')
   or jsonb_typeof(s->'business_active') is distinct from 'boolean'
   or jsonb_typeof(s->'unlimited_employees') is distinct from 'boolean'
   or jsonb_typeof(s->'cancel_at_period_end') is distinct from 'boolean'
   or coalesce(s->>'employee_limit','') !~ '^[0-9]{1,6}$'
   or (s->>'employee_limit')::integer>100000
   or s->>'current_period_end' is null
  then raise exception 'Invalid snapshot';end if;
  v_end:=(s->>'current_period_end')::timestamptz;
  if not isfinite(v_end) or (((s->>'business_active')::boolean or (s->>'unlimited_employees')::boolean) and (s->>'status'<>'active' or v_end<=clock_timestamp()))
   or (v_kind='unlimited_employees' and ((s->>'business_active')::boolean or (s->>'employee_limit')::integer<>0))
   or (v_kind='business' and not(s->>'business_active')::boolean and ((s->>'unlimited_employees')::boolean or (s->>'employee_limit')::integer<>0))
  then raise exception 'Invalid entitlement';end if;
  insert into public.ironcrest_billing_snapshots(mode,customer_id,subscription_id,subscription_type,status,business_active,unlimited_employees,employee_limit,current_period_end,cancel_at_period_end)
   values(p_mode,p_customer_id,v_subscription,v_kind,s->>'status',(s->>'business_active')::boolean,(s->>'unlimited_employees')::boolean,(s->>'employee_limit')::integer,v_end,(s->>'cancel_at_period_end')::boolean)
   on conflict(mode,customer_id,subscription_type) do update set subscription_id=excluded.subscription_id,status=excluded.status,
    business_active=excluded.business_active,unlimited_employees=excluded.unlimited_employees,employee_limit=excluded.employee_limit,
    current_period_end=excluded.current_period_end,cancel_at_period_end=excluded.cancel_at_period_end,updated_at=clock_timestamp();
 end if;
 if p_operation='commit' then update public.ironcrest_billing_customers
  set subscription_id=case when v_kind='business' then v_subscription else subscription_id end,
   unlimited_subscription_id=case when v_kind='unlimited_employees' then v_subscription else unlimited_subscription_id end
  where mode=p_mode and customer_id=p_customer_id;end if;
 insert into public.ironcrest_billing_events(mode,event_id,customer_id,event_type,outcome)
  values(p_mode,v_event,p_customer_id,v_type,case when p_operation='review' then 'review' else 'committed' end);
 return jsonb_build_object('ok',true,'duplicate',false,'reviewRequired',c.review_required or p_operation='review');
end;
$$;
revoke all on function public.ironcrest_billing_event_operation(text,text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ironcrest_billing_event_operation(text,text,text,uuid,jsonb) to service_role;

-- Separate helper: test receipts cannot grant live access, and lifetime/legacy sources are not overwritten.
create function public.ironcrest_webhook_business_entitlement(p_organization_id uuid,p_mode text)
returns table(business_active boolean,unlimited_employees boolean,employee_limit integer,review_required boolean)
language plpgsql stable security invoker set search_path='' as $$
begin
 if current_user<>'service_role' then raise insufficient_privilege;end if;
 if p_mode is null or p_mode not in ('test','live') then raise exception 'Billing mode required';end if;
 return query
 with access as (
  select s.business_active and s.status='active' and s.current_period_end>now() and not c.review_required
   and exists(select 1 from public.ironcrest_organizations o join public.ironcrest_memberships m on m.organization_id=o.id
    and m.user_id=o.created_by and m.role='owner' and m.active where o.id=c.organization_id and o.created_by=c.owner_user_id)
   and (select count(*) from public.ironcrest_memberships where user_id=c.owner_user_id and active)=1 as active,
   (s.unlimited_employees or (a.unlimited_employees and a.status='active' and a.current_period_end>now())) as unlimited_employees,s.employee_limit,c.review_required
  from public.ironcrest_billing_customers c left join public.ironcrest_billing_snapshots s
   on s.mode=c.mode and s.customer_id=c.customer_id and s.subscription_type='business'
   left join public.ironcrest_billing_snapshots a on a.mode=c.mode and a.customer_id=c.customer_id and a.subscription_type='unlimited_employees'
   where c.mode=p_mode and c.organization_id=p_organization_id
 ) select coalesce((select active from access),false),coalesce((select active and a.unlimited_employees from access a),false),
  coalesce((select case when active then a.employee_limit else 0 end from access a),0),coalesce((select a.review_required from access a),false);
end;
$$;
revoke all on function public.ironcrest_webhook_business_entitlement(uuid,text) from public,anon,authenticated;
grant execute on function public.ironcrest_webhook_business_entitlement(uuid,text) to service_role;
commit;
