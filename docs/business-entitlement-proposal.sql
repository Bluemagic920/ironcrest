-- REVIEW ONLY. Not applied to hosted Supabase; does not replace the live helper.
-- Business/price IDs verified read-only against Stripe on November 15, 2026.
-- Enable only after the billing writer, revocation and reconciliation are tested.
begin;
create function public.ironcrest_business_entitlement_v2(p_organization_id uuid)
returns table(business_active boolean,unlimited_employees boolean,employee_limit integer,entitlement_status text)
language plpgsql stable security invoker set search_path='' as $$
begin
 if current_user<>'service_role' then raise insufficient_privilege;end if;
 return query
 with company as (
  select o.created_by as owner_id from public.ironcrest_organizations o
  where o.id=p_organization_id and exists(
   select 1 from public.ironcrest_memberships m where m.organization_id=o.id
    and m.user_id=o.created_by and m.role='owner' and m.active)
 ), catalog(price_id,billing_interval) as (
  values ('price_1UXk8pAQCOww3CbZm6PjdBil'::text,'month'::text),
         ('price_1UYO1JAQCOww3CbZAMWwOC7N'::text,'year'::text)
 ), current_business as (
  select s.* from public.ph_business_subscriptions_live s join company c on c.owner_id=s.user_id
  where s.subscription_type='business'
 ), paid as (
  select s.stripe_subscription_id from current_business s join catalog p
   on p.price_id=s.stripe_price_id and p.billing_interval=s.billing_interval
  where s.status='active' and s.current_period_end>now()
 ), legacy_paid as (
  select s.stripe_subscription_id from public.ph_subscriptions_live s
   join company c on c.owner_id=s.user_id join catalog p on p.price_id=s.stripe_price_id
  where s.status='active' and s.current_period_end>now()
   -- A current canceled/expired Business row must never fall back to stale legacy access.
   and not exists(select 1 from current_business)
 ), access_check as (
  select exists(select 1 from public.owner_entitlements e join company c on c.owner_id=e.user_id
    where e.role='owner' and e.lifetime_business=true) as lifetime,
   ((select count(*) from paid)=1 or (select count(*) from legacy_paid)=1) as paid_business,
   (exists(select 1 from public.ph_business_subscriptions_live s join company c on c.owner_id=s.user_id
      where s.subscription_type='unlimited_employees' and s.billing_interval='month'
       and s.stripe_price_id='price_1UXkBDAQCOww3CbZpXEDYoHB'
       and s.status='active' and s.current_period_end>now())
    or exists(select 1 from public.ironcrest_addon_subscriptions a
      where a.organization_id=p_organization_id and a.stripe_price_id='price_1UXkBDAQCOww3CbZpXEDYoHB'
       and a.status='active' and a.current_period_end>now()
       and not exists(select 1 from public.ph_business_subscriptions_live s join company c on c.owner_id=s.user_id
        where s.subscription_type='unlimited_employees'))) as unlimited
 )
 select lifetime or paid_business,(lifetime or paid_business) and unlimited,
  case when not(lifetime or paid_business) then 0 when unlimited then null::integer else 20 end,
  case when lifetime then 'LIFETIME_BUSINESS' when not paid_business then 'NO_BUSINESS_ACCESS'
   when unlimited then 'BUSINESS_UNLIMITED' else 'BUSINESS_20' end
 from access_check;
end;
$$;
revoke all on function public.ironcrest_business_entitlement_v2(uuid) from public,anon,authenticated;
grant execute on function public.ironcrest_business_entitlement_v2(uuid) to service_role;
commit;
