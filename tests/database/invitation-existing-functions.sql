CREATE OR REPLACE FUNCTION public.ironcrest_accept_invitation(p_token_hash text, p_user_id uuid)
 RETURNS TABLE(invitation_id uuid, membership_id uuid, organization_id uuid, assigned_role text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$

DECLARE

    v_inv public.ironcrest_invitations%ROWTYPE;

    v_user_email text;

    v_email_confirmed timestamptz;

    v_existing_org uuid;

    v_ent record;

    v_cap record;

    v_membership_id uuid;

BEGIN

    IF auth.role() IS DISTINCT FROM 'service_role' THEN

        RAISE EXCEPTION 'Backend authorization required' USING ERRCODE = '42501';

    END IF;



    IF p_user_id IS NULL OR p_token_hash IS NULL

       OR p_token_hash !~ '^[0-9a-f]{64}$' THEN

        RAISE EXCEPTION 'Invalid invitation' USING ERRCODE = '22023';

    END IF;



    -- Non-locking lookup identifies the organization. Recheck under the lock below.

    SELECT i.organization_id INTO v_existing_org

    FROM public.ironcrest_invitations i

    WHERE i.token_hash = p_token_hash;



    IF v_existing_org IS NULL THEN

        RAISE EXCEPTION 'Invalid invitation' USING ERRCODE = '22023';

    END IF;



    -- Serializes creation and acceptance operations for this organization.

    IF NOT public.ironcrest_lock_organization(v_existing_org) THEN

        RAISE EXCEPTION 'Invalid organization' USING ERRCODE = '22023';

    END IF;



    SELECT i.* INTO v_inv

    FROM public.ironcrest_invitations i

    WHERE i.token_hash = p_token_hash

      AND i.organization_id = v_existing_org

    FOR UPDATE;



    IF NOT FOUND OR v_inv.status <> 'pending'

       OR v_inv.expires_at <= now()

       OR v_inv.accepted_at IS NOT NULL

       OR v_inv.revoked_at IS NOT NULL THEN

        RAISE EXCEPTION 'Invitation unavailable or expired' USING ERRCODE = '22023';

    END IF;



    IF v_inv.role NOT IN ('employee', 'manager') THEN

        RAISE EXCEPTION 'Invalid invitation role' USING ERRCODE = '22023';

    END IF;



    -- Check the authoritative Supabase Auth record, not browser-supplied email.

    SELECT lower(trim(u.email)), u.email_confirmed_at

      INTO v_user_email, v_email_confirmed

    FROM auth.users u

    WHERE u.id = p_user_id;



    IF v_user_email IS NULL OR v_email_confirmed IS NULL

       OR v_user_email <> lower(trim(v_inv.email)) THEN

        RAISE EXCEPTION 'Verified account email does not match invitation'

          USING ERRCODE = '42501';

    END IF;



    -- The existing schema enforces a unique user_id across organizations.

    -- Do not silently move a member from one organization to another.

    IF EXISTS (

        SELECT 1 FROM public.ironcrest_memberships m

        WHERE m.user_id = p_user_id

    ) THEN

        RAISE EXCEPTION 'Account already has an Ironcrest membership'

          USING ERRCODE = '23505';

    END IF;



    SELECT * INTO v_ent

    FROM public.ironcrest_business_entitlement(v_inv.organization_id);



    IF NOT FOUND OR v_ent.business_active IS DISTINCT FROM true THEN

        RAISE EXCEPTION 'Organization subscription is not active'

          USING ERRCODE = '42501';

    END IF;



    SELECT * INTO v_cap

    FROM public.ironcrest_employee_capacity(v_inv.organization_id);



    -- This pending invitation already occupies a reserved slot. Refuse an

    -- over-capacity organization, but do not charge an additional slot.

    IF v_ent.unlimited_employees IS DISTINCT FROM true AND

       (v_ent.employee_limit IS NULL OR

        v_cap.occupied_slots > v_ent.employee_limit) THEN

        RAISE EXCEPTION 'Employee capacity exceeded'

          USING ERRCODE = '23514';

    END IF;



    INSERT INTO public.ironcrest_memberships

        (organization_id, user_id, role, active)

    VALUES

        (v_inv.organization_id, p_user_id, v_inv.role, true)

    RETURNING id INTO v_membership_id;



    UPDATE public.ironcrest_invitations i

       SET status = 'accepted', accepted_at = now()

     WHERE i.id = v_inv.id

       AND i.status = 'pending';



    IF NOT FOUND THEN

        RAISE EXCEPTION 'Invitation acceptance conflict'

          USING ERRCODE = '40001';

    END IF;



    RETURN QUERY SELECT v_inv.id, v_membership_id,

                        v_inv.organization_id, v_inv.role;

END;

$function$;


CREATE OR REPLACE FUNCTION public.ironcrest_claim_invitation_delivery(p_audit_id uuid, p_invitation_id uuid, p_organization_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$

DECLARE v_count integer;

BEGIN

 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'server only' USING ERRCODE='42501'; END IF;

 UPDATE public.ironcrest_invitation_delivery_audit a SET delivery_status='sending',attempt_count=attempt_count+1,updated_at=now()

 WHERE a.id=p_audit_id AND a.invitation_id=p_invitation_id AND a.organization_id=p_organization_id AND a.delivery_status='pending'

 AND EXISTS (SELECT 1 FROM public.ironcrest_invitations i WHERE i.id=a.invitation_id AND i.organization_id=a.organization_id

   AND i.status='pending' AND i.revoked_at IS NULL AND i.expires_at>now() AND lower(i.email)=a.recipient_email);

 GET DIAGNOSTICS v_count=ROW_COUNT;

 RETURN v_count=1;

END $function$;


CREATE OR REPLACE FUNCTION public.ironcrest_create_invitation(p_organization_id uuid, p_invited_by uuid, p_email text, p_role text, p_token_hash text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$

DECLARE

    v_entitlement record;

    v_capacity record;

    v_invitation_id uuid;

    v_email text;

BEGIN

    -- Only the trusted service-role backend may call this.

    IF auth.role()::text

       IS DISTINCT FROM 'service_role' THEN

        RAISE EXCEPTION 'Backend authorization required';

    END IF;



    -- Validate invitation details.

    v_email := lower(trim(p_email));



    IF v_email IS NULL

       OR length(v_email) NOT BETWEEN 3 AND 254

       OR v_email !~*

          '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'

    THEN

        RAISE EXCEPTION 'Invalid email address';

    END IF;



    IF p_role NOT IN ('employee', 'manager') THEN

        RAISE EXCEPTION 'Invalid invitation role';

    END IF;



    IF p_token_hash IS NULL

       OR p_token_hash !~ '^[a-f0-9]{64}$' THEN

        RAISE EXCEPTION 'Invalid invitation token hash';

    END IF;



    -- Verify active organization owner membership.

    IF NOT EXISTS (

        SELECT 1

        FROM public.ironcrest_memberships m

        WHERE m.organization_id = p_organization_id

          AND m.user_id = p_invited_by

          AND m.role = 'owner'

          AND m.active = true

    ) THEN

        RAISE EXCEPTION 'Owner authorization required';

    END IF;



    -- Serialize invitations for this organization.

    PERFORM 1

    FROM public.ironcrest_organizations o

    WHERE o.id = p_organization_id

    FOR UPDATE;



    IF NOT FOUND THEN

        RAISE EXCEPTION 'Organization not found';

    END IF;



    -- Mark expired invitations so they no longer

    -- block the unique pending-email index.

    UPDATE public.ironcrest_invitations

    SET status = 'expired'

    WHERE organization_id = p_organization_id

      AND status = 'pending'

      AND expires_at <= now();



    -- Verify the Business entitlement.

    SELECT *

    INTO v_entitlement

    FROM public.ironcrest_business_entitlement(

        p_organization_id

    );



    IF NOT COALESCE(

        v_entitlement.business_active, false

    ) THEN

        RAISE EXCEPTION 'Business membership required';

    END IF;



    -- Count active employees and reserved invitations.

    SELECT *

    INTO v_capacity

    FROM public.ironcrest_employee_capacity(

        p_organization_id

    );



    IF v_entitlement.employee_limit IS NOT NULL

       AND v_capacity.occupied_slots >=

           v_entitlement.employee_limit THEN

        RAISE EXCEPTION 'Employee limit reached';

    END IF;



    -- Reject invitations to existing active members.

    IF public.ironcrest_existing_member_email(

        p_organization_id,

        v_email

    ) THEN

        RAISE EXCEPTION 'User already belongs to this organization';

    END IF;



    -- Prevent duplicate outstanding invitations.

    IF EXISTS (

        SELECT 1

        FROM public.ironcrest_invitations i

        WHERE i.organization_id = p_organization_id

          AND lower(i.email) = v_email

          AND i.status = 'pending'

    ) THEN

        RAISE EXCEPTION 'Invitation already pending';

    END IF;



    INSERT INTO public.ironcrest_invitations (

        organization_id,

        email,

        role,

        invited_by,

        token_hash,

        status,

        expires_at

    )

    VALUES (

        p_organization_id,

        v_email,

        p_role,

        p_invited_by,

        p_token_hash,

        'pending',

        now() + interval '7 days'

    )

    RETURNING id INTO v_invitation_id;



    RETURN v_invitation_id;

END;

$function$;


CREATE OR REPLACE FUNCTION public.ironcrest_employee_capacity(p_organization_id uuid)
 RETURNS TABLE(active_employees bigint, pending_invitations bigint, occupied_slots bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$

    SELECT

        (

            SELECT COUNT(*)

            FROM public.ironcrest_memberships m

            WHERE m.organization_id = p_organization_id

              AND m.active = true

              AND m.role IN ('employee', 'manager')

        ),

        (

            SELECT COUNT(*)

            FROM public.ironcrest_invitations i

            WHERE i.organization_id = p_organization_id

              AND i.status = 'pending'

              AND i.expires_at > now()

        ),

        (

            SELECT COUNT(*)

            FROM public.ironcrest_memberships m

            WHERE m.organization_id = p_organization_id

              AND m.active = true

              AND m.role IN ('employee', 'manager')

        )

        +

        (

            SELECT COUNT(*)

            FROM public.ironcrest_invitations i

            WHERE i.organization_id = p_organization_id

              AND i.status = 'pending'

              AND i.expires_at > now()

        );

$function$;


CREATE OR REPLACE FUNCTION public.ironcrest_existing_member_email(p_organization_id uuid, p_email text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$

    SELECT EXISTS (

        SELECT 1

        FROM public.ironcrest_memberships m

        JOIN auth.users u

          ON u.id = m.user_id

        WHERE m.organization_id = p_organization_id

          AND m.active = true

          AND lower(u.email) = lower(trim(p_email))

    );

$function$;


CREATE OR REPLACE FUNCTION public.ironcrest_finish_invitation_delivery(p_audit_id uuid, p_invitation_id uuid, p_organization_id uuid, p_status text, p_provider_message_id text DEFAULT NULL::text, p_error_code text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$

DECLARE v_count integer;

BEGIN

 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'server only' USING ERRCODE='42501'; END IF;

 IF p_status NOT IN ('accepted','failed','unknown') THEN RAISE EXCEPTION 'invalid delivery status' USING ERRCODE='22023'; END IF;

 IF p_status='accepted' AND (p_provider_message_id IS NULL OR length(p_provider_message_id)>255) THEN RAISE EXCEPTION 'message id required' USING ERRCODE='22023'; END IF;

 UPDATE public.ironcrest_invitation_delivery_audit a

 SET delivery_status=p_status,provider_message_id=CASE WHEN p_status='accepted' THEN p_provider_message_id ELSE NULL END,

 last_error_code=CASE WHEN p_status='accepted' THEN NULL ELSE left(coalesce(p_error_code,'DELIVERY_ERROR'),100) END,updated_at=now()

 WHERE a.id=p_audit_id AND a.invitation_id=p_invitation_id AND a.organization_id=p_organization_id AND a.delivery_status='sending';

 GET DIAGNOSTICS v_count=ROW_COUNT;

 RETURN v_count=1;

END $function$;


CREATE OR REPLACE FUNCTION public.ironcrest_lock_organization(p_organization_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$

DECLARE

    v_found boolean := false;

BEGIN

    -- Lock the organization row until the transaction ends.

    PERFORM 1

    FROM public.ironcrest_organizations

    WHERE id = p_organization_id

    FOR UPDATE;



    v_found := FOUND;



    RETURN v_found;

END;

$function$;


CREATE OR REPLACE FUNCTION public.ironcrest_reserve_invitation_delivery(p_invitation_id uuid, p_organization_id uuid, p_recipient_email text)
 RETURNS TABLE(audit_id uuid, reservation_created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$

DECLARE v_id uuid;

BEGIN

 IF auth.role() IS DISTINCT FROM 'service_role' THEN

   RAISE EXCEPTION 'server-only function' USING ERRCODE = '42501';

 END IF;

 IF NOT EXISTS (

   SELECT 1 FROM public.ironcrest_invitations i

   WHERE i.id = p_invitation_id

     AND i.organization_id = p_organization_id

     AND lower(i.email) = lower(trim(p_recipient_email))

     AND i.status = 'pending'

     AND i.revoked_at IS NULL

     AND i.expires_at > now()

 ) THEN

   RAISE EXCEPTION 'invitation not eligible for delivery';

 END IF;

 INSERT INTO public.ironcrest_invitation_delivery_audit

   (invitation_id, organization_id, recipient_email, provider, delivery_status, attempt_count)

 VALUES

   (p_invitation_id, p_organization_id, lower(trim(p_recipient_email)), 'resend', 'pending', 0)

 ON CONFLICT (invitation_id)

   WHERE delivery_status IN ('pending','sending','accepted','delivered')

 DO NOTHING

 RETURNING id INTO v_id;

 IF v_id IS NOT NULL THEN

   RETURN QUERY SELECT v_id, true;

 ELSE

   RETURN QUERY SELECT a.id, false

   FROM public.ironcrest_invitation_delivery_audit a

   WHERE a.invitation_id = p_invitation_id

     AND a.delivery_status IN ('pending','sending','accepted','delivered')

   ORDER BY a.created_at DESC LIMIT 1;

 END IF;

END;

$function$;
