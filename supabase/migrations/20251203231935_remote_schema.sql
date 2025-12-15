


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "ci";


ALTER SCHEMA "ci" OWNER TO "postgres";


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






CREATE SCHEMA IF NOT EXISTS "iso_compliance";


ALTER SCHEMA "iso_compliance" OWNER TO "postgres";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgjwt" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."ci_orb_mode" AS ENUM (
    'nur',
    'ruh',
    'alert'
);


ALTER TYPE "public"."ci_orb_mode" OWNER TO "postgres";


CREATE TYPE "public"."ci_orb_severity" AS ENUM (
    'info',
    'focus',
    'alert'
);


ALTER TYPE "public"."ci_orb_severity" OWNER TO "postgres";


CREATE TYPE "public"."doc_pillar_enum" AS ENUM (
    'Formation',
    'Governance',
    'Registers',
    'Capital',
    'FilingsNotices',
    'BankingInsurance',
    'Valuations',
    'Compliance',
    'LegalPackages',
    'General'
);


ALTER TYPE "public"."doc_pillar_enum" OWNER TO "postgres";


CREATE TYPE "public"."doc_section_enum" AS ENUM (
    'Bylaws',
    'Resolutions',
    'Registers',
    'ShareCertificates',
    'Annexes',
    'ClosingBinders',
    'general',
    'formation',
    'notices',
    'annual_returns',
    'registers',
    'resolutions',
    'bylaws',
    'share_certificates',
    'consents',
    'banking',
    'insurance',
    'appraisal',
    'compliance',
    'legal_package'
);


ALTER TYPE "public"."doc_section_enum" OWNER TO "postgres";


CREATE TYPE "public"."document_class" AS ENUM (
    'resolution',
    'invoice',
    'certificate',
    'report',
    'minutes',
    'tax_filing',
    'other'
);


ALTER TYPE "public"."document_class" OWNER TO "postgres";


CREATE TYPE "public"."entity_key_enum" AS ENUM (
    'OIH',
    'OIL',
    'OIRE',
    'holdings',
    'realestate'
);


ALTER TYPE "public"."entity_key_enum" OWNER TO "postgres";


CREATE TYPE "public"."entry_type_enum" AS ENUM (
    'Resolution',
    'Register',
    'Bylaw',
    'Annex',
    'ClosingBinder'
);


ALTER TYPE "public"."entry_type_enum" OWNER TO "postgres";


CREATE TYPE "public"."governance_status" AS ENUM (
    'draft',
    'under_review',
    'council_approved',
    'ready_for_signature',
    'signing',
    'signed',
    'executed',
    'archived'
);


ALTER TYPE "public"."governance_status" OWNER TO "postgres";


CREATE TYPE "public"."ledger_action" AS ENUM (
    'upload_document',
    'replace_document',
    'delete_document',
    'create_section',
    'update_section',
    'delete_section',
    'create_resolution',
    'update_resolution',
    'finalize_resolution',
    'generate_note',
    'export_section',
    'misc'
);


ALTER TYPE "public"."ledger_action" OWNER TO "postgres";


CREATE TYPE "public"."note_scope_type" AS ENUM (
    'document',
    'section',
    'book',
    'entity'
);


ALTER TYPE "public"."note_scope_type" OWNER TO "postgres";


CREATE TYPE "public"."note_type" AS ENUM (
    'note',
    'resolution_draft',
    'summary',
    'memo'
);


ALTER TYPE "public"."note_type" OWNER TO "postgres";


CREATE TYPE "public"."verification_level" AS ENUM (
    'draft',
    'unsigned',
    'signed',
    'signed_verified',
    'certified'
);


ALTER TYPE "public"."verification_level" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "iso_compliance"."log_ai_sentinel_heartbeat"() RETURNS "void"
    LANGUAGE "sql"
    AS $$
  insert into compliance_audit_log
    (resolution_id, old_status, new_status, reviewer, actor_type, context)
  values
    (null, null, null, 'ai-sentinel', 'system',
     jsonb_build_object(
       'note','AI Sentinel daily heartbeat',
       'source','ai-sentinel',
       'status','ok'
     ));
$$;


ALTER FUNCTION "iso_compliance"."log_ai_sentinel_heartbeat"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_first_approved_attachment"("p_attachments" "jsonb") RETURNS "text"
    LANGUAGE "sql"
    AS $$
  select coalesce(
    (select a->>'type'
       from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) a
      where (a->>'type') in ('signed_pdf','scanned_pdf')
      limit 1),
    null
  );
$$;


ALTER FUNCTION "public"."_first_approved_attachment"("p_attachments" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."add_minute_book_doc"("p_entity_key" "text", "p_section" "text", "p_entry_type" "text", "p_storage_path" "text", "p_file_name" "text", "p_mime_type" "text", "p_file_size" bigint, "p_file_hash" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $_$
declare
  v_owner uuid := auth.uid();
  v_date date;
  v_title text;
  v_version int;
  v_entry_id uuid;
  v_doc_id uuid;
  v_section doc_section_enum;
begin
  if v_owner is null then
    raise exception 'Not authenticated';
  end if;

  select file_date, base_title, version
  into v_date, v_title, v_version
  from mb_parse_filename(p_file_name);

  v_date := coalesce(v_date, current_date);
  v_title := coalesce(nullif(v_title,''), regexp_replace(p_file_name, '\.[A-Za-z0-9]+$', ''));
  v_version := coalesce(v_version, 1);

  -- map arbitrary folder name → canonical enum
  v_section := mb_map_section(p_section);

  -- find or create the entry
  select id into v_entry_id
  from minute_book_entries
  where entity_key = p_entity_key::entity_key_enum
    and coalesce(title,'') = coalesce(v_title,'')
    and entry_date = v_date
    and owner_id = v_owner
  limit 1;

  if v_entry_id is null then
    insert into minute_book_entries(entity_key, entry_date, entry_type, title, owner_id)
    values (p_entity_key::entity_key_enum, v_date, p_entry_type::entry_type_enum, v_title, v_owner)
    returning id into v_entry_id;
  end if;

  -- skip duplicates by hash
  select id into v_doc_id
  from supporting_documents
  where entry_id = v_entry_id
    and section = v_section
    and file_hash = p_file_hash
  limit 1;

  if v_doc_id is not null then
    return v_doc_id;
  end if;

  insert into supporting_documents(
    entry_id, entity_key, section, file_path, file_name,
    doc_type, version, uploaded_by, owner_id,
    mime_type, file_size, file_hash
  )
  values (
    v_entry_id, p_entity_key::entity_key_enum, v_section,
    p_storage_path, p_file_name,
    p_entry_type, v_version, v_owner, v_owner,
    p_mime_type, p_file_size, p_file_hash
  )
  returning id into v_doc_id;

  return v_doc_id;
end
$_$;


ALTER FUNCTION "public"."add_minute_book_doc"("p_entity_key" "text", "p_section" "text", "p_entry_type" "text", "p_storage_path" "text", "p_file_name" "text", "p_mime_type" "text", "p_file_size" bigint, "p_file_hash" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."adopt_resolution"("p_entity" "uuid", "p_resolution" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_row   public.resolutions%rowtype;
  v_actor uuid := auth.uid();
begin
  -- Load resolution regardless of RLS, then check entity match
  select * into v_row
  from public.resolutions
  where id = p_resolution;

  if v_row is null then
    raise exception 'Resolution % does not exist', p_resolution;
  end if;

  if v_row.entity_id <> p_entity then
    raise exception 'Resolution % belongs to a different entity: %', p_resolution, v_row.entity_id;
  end if;

  -- Move draft -> ready if needed
  if v_row.status = 'draft' then
    update public.resolutions
    set status = 'ready', updated_at = now()
    where id = p_resolution;
  end if;

  -- Then ready -> adopted
  update public.resolutions
  set status = 'adopted', updated_at = now()
  where id = p_resolution;

  -- Record audit trail
  insert into public.audit_logs (entity_id, actor, table_name, row_pk, action, payload)
  values (
    p_entity,
    coalesce(v_actor, '00000000-0000-0000-0000-000000000000'::uuid),
    'resolutions',
    p_resolution::text,
    'adopt',
    to_jsonb(v_row)
  );
end;
$$;


ALTER FUNCTION "public"."adopt_resolution"("p_entity" "uuid", "p_resolution" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."advisor_check_and_log"("p_entity_slug" "text", "p_title" "text", "p_amount" numeric DEFAULT NULL::numeric, "p_currency" "text" DEFAULT 'CAD'::"text", "p_attachment" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_result jsonb;
  v_policy_version text;
begin
  -- run the basic advisor check you already created
  v_result := public.advisor_check_basic(
    p_entity_slug,
    p_title,
    p_amount,
    p_currency,
    p_attachment
  );

  -- capture the policy version we used (latest for that entity)
  select pr.version
    into v_policy_version
  from public.policy_rules pr
  where pr.entity_slug = p_entity_slug
  order by pr.created_at desc
  limit 1;

  -- write an audit row for IRAP / traceability
  insert into public.advisor_audit(
    entity_slug, record_title, amount, currency, attachment,
    policy_version, result_json
  )
  values (
    p_entity_slug, p_title, p_amount, p_currency, p_attachment,
    v_policy_version, v_result
  );

  return v_result;
end;
$$;


ALTER FUNCTION "public"."advisor_check_and_log"("p_entity_slug" "text", "p_title" "text", "p_amount" numeric, "p_currency" "text", "p_attachment" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."advisor_check_basic"("p_entity_slug" "text", "p_title" "text", "p_amount" numeric DEFAULT NULL::numeric, "p_currency" "text" DEFAULT 'CAD'::"text", "p_attachment" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_rules jsonb;
  v_result jsonb := '{}'::jsonb;
  v_issues text[] := array[]::text[];
  v_ok boolean := true;
  v_board_limit numeric := null;
begin
  -- Fetch the rule set for this entity
  select yaml_json into v_rules
  from public.policy_rules
  where entity_slug = p_entity_slug
  order by created_at desc
  limit 1;

  if v_rules is null then
    raise exception 'No policy_rules found for %', p_entity_slug;
  end if;

  -- ✅ Check title and basic required fields
  if p_title is null or length(trim(p_title)) = 0 then
    v_issues := array_append(v_issues, 'Missing title');
    v_ok := false;
  end if;

  -- ✅ Check amount (if provided) against board_max
  if p_amount is not null then
    select (elem->>'board_max')::numeric
    into v_board_limit
    from jsonb_array_elements(v_rules->'approval_limits') elem
    where elem->>'currency' = p_currency
    order by (elem->>'board_max')::numeric desc
    limit 1;

    if v_board_limit is not null and p_amount > v_board_limit then
      v_issues := array_append(v_issues, format('Amount %.2f exceeds board limit of %.2f', p_amount, v_board_limit));
      v_ok := false;
    end if;
  end if;

  -- ✅ Check attachment type
  if p_attachment is not null and not (p_attachment = any(ARRAY['signed_pdf','scanned_pdf'])) then
    v_issues := array_append(v_issues, 'Attachment not approved type');
    v_ok := false;
  end if;

  -- ✅ Build result JSON
  v_result := jsonb_build_object(
    'entity', p_entity_slug,
    'status', case when v_ok then 'PASS' else 'FAIL' end,
    'issues', v_issues,
    'checked_at', now()
  );

  return v_result;
end;
$$;


ALTER FUNCTION "public"."advisor_check_basic"("p_entity_slug" "text", "p_title" "text", "p_amount" numeric, "p_currency" "text", "p_attachment" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."advisor_check_for_record"("p_record_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_rec          record;
  v_entity_slug  text;
  v_attachment   text;
  v_result       jsonb;
  v_latest_id    uuid;
begin
  -- Pull the record + entity slug
  select gl.id, gl.entity_id, gl.title, gl.attachments, e.slug as entity_slug
    into v_rec
  from public.governance_ledger gl
  left join public.entities e on e.id = gl.entity_id
  where gl.id = p_record_id;

  if v_rec.id is null then
    raise exception 'Record % not found in governance_ledger', p_record_id;
  end if;

  v_entity_slug := v_rec.entity_slug;
  v_attachment  := public._first_approved_attachment(v_rec.attachments);

  -- Call the Advisor (amount unknown here; pass null)
  v_result := public.advisor_check_and_log(
    v_entity_slug,
    v_rec.title,
    null,
    'CAD',
    v_attachment
  );

  -- Backfill record_id into the latest audit row we just wrote
  select id
    into v_latest_id
  from public.advisor_audit
  where record_id  is null
    and entity_slug = v_entity_slug
    and record_title = v_rec.title
  order by created_at desc
  limit 1;

  if v_latest_id is not null then
    update public.advisor_audit
       set record_id = v_rec.id
     where id = v_latest_id;
  end if;

  return v_result;
end;
$$;


ALTER FUNCTION "public"."advisor_check_for_record"("p_record_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_ai_advice_and_resolve"("p_max" integer DEFAULT 50) RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
declare
  v_row record;
  v_count int := 0;
  v_old_violation_status text;
  v_old_action_status    text;
  v_old_review_status    text;
begin
  -- Pick corrective actions that:
  --  * are still OPEN
  --  * have an attached governance_violation that is OPEN / IN_REVIEW
  --  * already have AI advice (not just "pending")
  for v_row in
    select
      ca.id  as corrective_action_id,
      gv.id  as violation_id,
      gv.record_id,
      ca.review_id,
      aa.id  as advice_id
    from public.corrective_actions      ca
    join public.governance_violations   gv
      on gv.corrective_action_id = ca.id
    join public.ai_advice               aa
      on aa.corrective_action_id = ca.id
    where ca.status = 'open'
      and gv.status in ('open','in_review')
      and (
            aa.advice is not null
         or aa.recommendation is distinct from 'AI-generated recommendation pending'
          )
    order by aa.generated_at
    limit p_max
  loop
    -- capture old statuses for debugging
    select status
      into v_old_violation_status
      from public.governance_violations
     where id = v_row.violation_id;

    v_old_action_status := 'open';

    if v_row.review_id is not null then
      select overall_status
        into v_old_review_status
        from public.compliance_reviews
       where id = v_row.review_id;
    end if;

    ------------------------------------------------------------------
    -- 1) Mark the corrective action as DONE
    ------------------------------------------------------------------
    update public.corrective_actions
       set status = 'done'
     where id = v_row.corrective_action_id
       and status = 'open';

    ------------------------------------------------------------------
    -- 2) Mark the violation as CORRECTED
    ------------------------------------------------------------------
    update public.governance_violations
       set status       = 'corrected',
           corrected_at = now(),
           details      = coalesce(details, '{}'::jsonb)
                          || jsonb_build_object(
                               'corrected_by', 'ai-auto-resolution',
                               'corrected_at', now()
                             )
     where id = v_row.violation_id;

    ------------------------------------------------------------------
    -- 3) If there is a linked compliance review, mark it REVIEWED
    ------------------------------------------------------------------
    if v_row.review_id is not null then
      update public.compliance_reviews
         set overall_status = 'reviewed',
             updated_at     = now(),
             notes          = coalesce(notes, '')
                               || E'\n[AI auto-resolution applied at '
                               || now()::text || ']'
       where id = v_row.review_id;
    end if;

    ------------------------------------------------------------------
    -- 4) Drop a breadcrumb into ai_status_debug
    ------------------------------------------------------------------
    insert into public.ai_status_debug(
      advice_id,
      record_id,
      rows_updated,
      created_at,
      event,
      old_status,
      new_status,
      details
    )
    values (
      v_row.advice_id,
      v_row.record_id,
      1,
      now(),
      'ai_auto_resolve',
      coalesce(v_old_violation_status,'') || '/' ||
      coalesce(v_old_action_status,'')    || '/' ||
      coalesce(v_old_review_status,''),
      'corrected/done/reviewed',
      'AI auto-resolution for corrective_action ' || v_row.corrective_action_id::text
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;


ALTER FUNCTION "public"."apply_ai_advice_and_resolve"("p_max" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_retention_expiry"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  yrs integer;
BEGIN
  IF NEW.retention_policy_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT keep_years INTO yrs
  FROM document_retention_policies
  WHERE id = NEW.retention_policy_id;

  IF yrs IS NOT NULL THEN
    NEW.expires_at := (NEW.created_at + (yrs || ' years')::interval);
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."apply_retention_expiry"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."approve_compliance_review"("p_review_id" "uuid", "p_mark_compliant" boolean) RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
begin
  update public.compliance_reviews
  set
    compliant      = p_mark_compliant,
    overall_status = case
                       when p_mark_compliant then 'compliant'
                       else 'review_required'
                     end,
    approved_by    = auth.uid(),
    approved_at    = now(),
    updated_at     = now()
  where id = p_review_id;
end;
$$;


ALTER FUNCTION "public"."approve_compliance_review"("p_review_id" "uuid", "p_mark_compliant" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."approve_governance_ledger"("p_ledger_id" "uuid", "p_approver_name" "text", "p_approver_email" "text", "p_approver_role" "text", "p_decision" "text", "p_comment" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
begin
  -- 1) log the decision
  insert into governance_approvals (
    ledger_id,
    approver_name,
    approver_email,
    approver_role,
    decision,
    comment
  ) values (
    p_ledger_id,
    p_approver_name,
    p_approver_email,
    p_approver_role,
    p_decision,
    p_comment
  );

  -- 2) update ledger status based on decision
  update governance_ledger
  set status = case
    when p_decision = 'approved' then 'approved'
    when p_decision = 'rejected' then 'archived'
    else status  -- 'changes_requested' keeps it as draft
  end
  where id = p_ledger_id;
end;
$$;


ALTER FUNCTION "public"."approve_governance_ledger"("p_ledger_id" "uuid", "p_approver_name" "text", "p_approver_email" "text", "p_approver_role" "text", "p_decision" "text", "p_comment" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."approve_latest_obligation_review"("p_obligation_id" "uuid", "p_mark_compliant" boolean DEFAULT true) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_review_id uuid;
begin
  -- find most recent review for that obligation
  select id
  into v_review_id
  from public.compliance_reviews
  where obligation_id = p_obligation_id
  order by review_date desc
  limit 1;

  if not found then
    raise exception
      using
        message = format('No reviews found for obligation %s', p_obligation_id),
        errcode = 'P0083';
  end if;

  -- reuse the main function
  perform public.approve_compliance_review(v_review_id, p_mark_compliant);
end;
$$;


ALTER FUNCTION "public"."approve_latest_obligation_review"("p_obligation_id" "uuid", "p_mark_compliant" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."audit_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.hash :=
    encode(
      extensions.digest(  -- 👈 schema-qualified call
        convert_to(
          coalesce(new.prev_hash,'') ||
          new.table_name ||
          new.row_pk ||
          new.action ||
          coalesce(new.payload::text,'') ||
          new.occurred_at::text,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );
  return new;
end;
$$;


ALTER FUNCTION "public"."audit_insert"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."audit_row"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  actor_id uuid := auth.uid();
  entity uuid;
  pk text;
  payload jsonb;
begin
  if TG_OP in ('INSERT','UPDATE') then
    entity := NEW.entity_id; pk := NEW.id::text; payload := to_jsonb(NEW);
  else
    entity := OLD.entity_id; pk := OLD.id::text; payload := to_jsonb(OLD);
  end if;

  insert into public.audit_logs(entity_id, actor, table_name, row_pk, action, payload)
  values (entity, coalesce(actor_id,'00000000-0000-0000-0000-000000000000'::uuid),
          TG_TABLE_NAME, pk, lower(TG_OP), payload);

  return case when TG_OP='DELETE' then OLD else NEW end;
end; $$;


ALTER FUNCTION "public"."audit_row"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auto_create_corrective_actions_for_open_violations"() RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_rec      record;
  v_owner    text;
  v_due_date date;
  v_action   text;
  v_ca_id    uuid;
  v_count    int := 0;
BEGIN
  -- Scan all violations that are still open / in_review and have no corrective action yet
  FOR v_rec IN
    SELECT
      v.*,
      gv.severity,
      gv.rule_key,
      e.name AS entity_name,
      e.slug AS entity_slug
    FROM public.governance_violations v
    JOIN public.governance_validations gv
      ON gv.id = v.validation_id
    JOIN public.entities e
      ON e.id = v.entity_id
    WHERE v.status IN ('open','in_review')
      AND v.corrective_action_id IS NULL
  LOOP
    -- Owner: simple, but clear (can be refined later)
    v_owner := 'Corporate Director – ' || v_rec.entity_name;

    -- Due date by severity
    v_due_date := current_date +
      CASE v_rec.severity
        WHEN 'critical' THEN 3
        WHEN 'error'    THEN 7
        ELSE 14
      END;

    -- Action text per rule_key (fallback to generic issue text)
    v_action := CASE v_rec.rule_key
      WHEN 'CRA-T2-ANNUAL-FILING-CHECK' THEN
        format(
          'File the T2 corporate income tax return with CRA for year %s for %s.',
          v_rec.details->>'year',
          v_rec.entity_name
        )

      WHEN 'OBCA-AGM-ANNUAL-CHECK' THEN
        format(
          'Schedule and hold the Annual General Meeting for year %s for %s and record the minutes in governance_ledger.',
          v_rec.details->>'year',
          v_rec.entity_name
        )

      WHEN 'INT-MINUTE-BOOK-COMPLETE-CHECK' THEN
        format(
          'Create or update the complete corporate minute book for %s for year %s (articles, by-laws, registers, resolutions).',
          v_rec.entity_name,
          v_rec.details->>'year'
        )

      WHEN 'OBCA-FINANCIAL-STATEMENTS-TABLED-CHECK' THEN
        format(
          'Prepare annual financial statements for year %s for %s, table them at the AGM, and add a resolution confirming presentation/approval.',
          v_rec.details->>'year',
          v_rec.entity_name
        )

      WHEN 'INT-MATERIAL-EVENT-RESOLUTION-CHECK' THEN
        format(
          'Draft and approve a resolution describing material financial event %s for %s and link it via linked_financial_event_id in governance_ledger.',
          COALESCE(v_rec.details->>'financial_event_id','(event-id missing)'),
          v_rec.entity_name
        )

      WHEN 'INT-PARENT-APPROVAL-MATERIAL-CHILD-EVENT' THEN
        format(
          'Draft and approve a Holdings-level resolution authorizing the child entity (id: %s) material financial event %s, linking the same financial_event_id.',
          COALESCE(v_rec.details->>'child_entity_id','(child-id missing)'),
          COALESCE(v_rec.details->>'financial_event_id','(event-id missing)')
        )

      ELSE
        COALESCE(
          v_rec.details->>'issue',
          'Review and remediate this governance violation for ' || v_rec.entity_name
        )
    END;

    -- Insert corrective action
    INSERT INTO public.corrective_actions (
      review_id,
      action,
      owner,
      due_date,
      status
    )
    VALUES (
      NULL,
      v_action,
      v_owner,
      v_due_date,
      'open'
    )
    RETURNING id INTO v_ca_id;

    -- Wire violation → corrective action
    UPDATE public.governance_violations
    SET corrective_action_id = v_ca_id
    WHERE id = v_rec.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;


ALTER FUNCTION "public"."auto_create_corrective_actions_for_open_violations"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."block_audit_mutations"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  raise exception 'audit_logs is append-only';
end;
$$;


ALTER FUNCTION "public"."block_audit_mutations"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."block_party_changes_if_envelope_completed"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  env_status text;
  env_id uuid;
begin
  -- Figure out which envelope we’re talking about (OLD for delete, NEW for insert/update)
  if (tg_op = 'DELETE') then
    env_id := old.envelope_id;
  else
    env_id := new.envelope_id;
  end if;

  select status into env_status
  from public.signature_envelopes
  where id = env_id;

  -- If parent envelope is completed, block changes
  if env_status = 'completed' then
    raise exception 'Cannot % signature_party for a completed envelope (envelope_id=%)', tg_op, env_id;
  end if;

  -- Otherwise allow the change
  if tg_op = 'DELETE' then
    return old;
  else
    return new;
  end if;
end;
$$;


ALTER FUNCTION "public"."block_party_changes_if_envelope_completed"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."build_storage_path"("p_entity_slug" "text", "p_section" "text", "p_year" integer, "p_file_name" "text", "p_subfolder" "text" DEFAULT NULL::"text") RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_path text;
begin
  -- Safety: trim slashes
  p_entity_slug := trim(both '/' from p_entity_slug);
  p_section     := trim(both '/' from p_section);
  p_file_name   := trim(both '/' from p_file_name);
  p_subfolder   := nullif(trim(both '/' from coalesce(p_subfolder, '')), '');

  if p_year is null then
    -- default to current year if not provided
    p_year := extract(year from current_date)::int;
  end if;

  if p_subfolder is null then
    v_path := format(
      '%s/%s/%s/%s',
      p_entity_slug, p_section, p_year, p_file_name
    );
  else
    v_path := format(
      '%s/%s/%s/%s/%s',
      p_entity_slug, p_section, p_year, p_subfolder, p_file_name
    );
  end if;

  return v_path;
end;
$$;


ALTER FUNCTION "public"."build_storage_path"("p_entity_slug" "text", "p_section" "text", "p_year" integer, "p_file_name" "text", "p_subfolder" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bump_document_version"("p_record_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  next_version integer;
BEGIN
  SELECT coalesce(max(version), 0) + 1
  INTO next_version
  FROM governance_documents
  WHERE record_id = p_record_id;

  RETURN next_version;
END;
$$;


ALTER FUNCTION "public"."bump_document_version"("p_record_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_role"("p_entity_slug" "text", "p_role_id" "text", "p_capability" "text") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from memberships m
    join entities e
      on e.id = m.entity_id
    join ai_entity_roles r
      on r.entity_id = e.id
     and r.role_id   = lower(p_role_id)
    where e.slug     = lower(p_entity_slug)
      and m.user_id  = auth.uid()
      and coalesce(r.is_enabled, false) = true
      and (
        p_capability is null
        or p_capability = ''
        or lower(p_capability) = any (
             coalesce(
               (
                 -- JSONB → text rows → array for ANY()
                 select array_agg(lower(val))
                 from jsonb_array_elements_text(r.capabilities::jsonb) as t(val)
               ),
               array[]::text[]
             )
          )
      )
  );
$$;


ALTER FUNCTION "public"."can_role"("p_entity_slug" "text", "p_role_id" "text", "p_capability" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_role_debug"("p_entity_slug" "text", "p_role_id" "text", "p_capability" "text", "p_user" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM v_ai_agent_config v
    JOIN memberships m ON m.entity_id = (SELECT id FROM entities WHERE slug = p_entity_slug)
    WHERE m.user_id = p_user
      AND v.entity_slug = p_entity_slug
      AND v.role_id = p_role_id
      AND v.is_enabled = true
      AND v.capabilities ? p_capability
  );
$$;


ALTER FUNCTION "public"."can_role_debug"("p_entity_slug" "text", "p_role_id" "text", "p_capability" "text", "p_user" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ci_genesis_finalize"("p_session_id" "uuid") RETURNS TABLE("entity_id" "uuid", "entity_slug" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_session       public.ci_genesis_sessions;
  v_slug_base     text;
  v_slug          text;
  v_suffix        integer := 0;
  v_entity_id     uuid;
  v_minute_book_id uuid;
  v_record_id     uuid;
BEGIN
  -- 1) Fetch + lock session
  SELECT *
  INTO v_session
  FROM public.ci_genesis_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CI-Genesis session % not found', p_session_id;
  END IF;

  IF v_session.status <> 'draft' THEN
    RAISE EXCEPTION 'CI-Genesis session % is already %',
      p_session_id, v_session.status;
  END IF;

  -- 2) Generate unique slug
  v_slug_base := v_session.entity_slug;
  v_slug := v_slug_base;

  LOOP
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.entities WHERE slug = v_slug
    );
    v_suffix := v_suffix + 1;
    v_slug := v_slug_base || '-' || v_suffix::text;
  END LOOP;

  -- 3) Create entity
  INSERT INTO public.entities (slug, name)
  VALUES (v_slug, v_session.entity_name)
  RETURNING id INTO v_entity_id;

  -- 4) Membership for creator (owner + admin)
  INSERT INTO public.memberships (user_id, entity_id, role, is_admin)
  VALUES (v_session.created_by, v_entity_id, 'owner', true);

  -- 5) Create minute book shell
  INSERT INTO public.minute_books (entity_id, title)
  VALUES (
    v_entity_id,
    v_session.entity_name || ' Minute Book'
  )
  RETURNING id INTO v_minute_book_id;

  -- 6) Seed default sections
  INSERT INTO public.sections (entity_id, name)
  VALUES
    (v_entity_id, 'Board Resolutions'),
    (v_entity_id, 'Shareholder Resolutions');

  -- 7) Enable AI features by default
  INSERT INTO public.ai_feature_flags (entity_slug, ai_enabled, auto_summarize)
  VALUES (v_slug, true, true)
  ON CONFLICT (entity_slug) DO NOTHING;

  -- 8) Governance ledger record for Genesis onboarding
  INSERT INTO public.governance_ledger (
    entity_id,
    title,
    description,
    record_type,
    created_by,
    created_at,
    provisional,
    provenance,
    approved,
    ai_status,
    compliance_status
  )
  VALUES (
    v_entity_id,
    'CI-Genesis Onboarding Completed',
    format(
      'Entity %s (%s) onboarded via CI-Genesis at %s by user %s',
      v_session.entity_name,
      v_slug,
      now(),
      v_session.created_by
    ),
    'resolution',
    v_session.created_by,
    now(),
    false,
    jsonb_build_object(
      'source', 'ci-genesis',
      'session_id', p_session_id
    ),
    true,
    'completed',
    'compliant'
  )
  RETURNING id INTO v_record_id;

  -- 9) Optional audit trail entry (if table exists)
  INSERT INTO public.audit_trail (actor, action, ref_table, ref_id, at)
  VALUES (
    v_session.created_by,
    'ci_genesis_completed',
    'entities',
    v_entity_id,
    now()
  )
  ON CONFLICT DO NOTHING;

  -- 10) Mark session completed
  UPDATE public.ci_genesis_sessions
  SET status = 'completed',
      completed_at = now(),
      updated_at   = now()
  WHERE id = p_session_id;

  -- 11) Return new entity
  entity_id   := v_entity_id;
  entity_slug := v_slug;
  RETURN NEXT;
END;
$$;


ALTER FUNCTION "public"."ci_genesis_finalize"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ci_genesis_start"("p_entity_name" "text", "p_primary_email" "text", "p_jurisdiction" "text" DEFAULT NULL::"text", "p_actor_role" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.ci_genesis_sessions (
    entity_name,
    primary_email,
    jurisdiction,
    actor_role
  )
  VALUES (
    p_entity_name,
    p_primary_email,
    p_jurisdiction,
    p_actor_role
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."ci_genesis_start"("p_entity_name" "text", "p_primary_email" "text", "p_jurisdiction" "text", "p_actor_role" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ci_genesis_touch_session"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."ci_genesis_touch_session"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."compliance_status_trigger"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_context jsonb := coalesce(to_jsonb(current_setting('app.audit_context', true)), 'null'::jsonb);
  v_source  text   := coalesce((v_context->>'source'), null);
  v_actor   text;
begin
  -- Decide actor_type
  if v_source ilike '%ai%' then
    v_actor := 'ai';
  elsif v_source ilike '%trigger%' then
    v_actor := 'system';
  elsif session_user in ('postgres','supabase_admin') then
    v_actor := 'system';
  else
    v_actor := 'human';
  end if;

  insert into compliance_audit_log (
    resolution_id,
    old_status,
    new_status,
    changed_at,
    reviewer,
    context,
    actor_type
  )
  values (
    new.id,
    old.compliance_status,
    new.compliance_status,
    now(),
    session_user,                  -- who executed the change
    jsonb_build_object(
      'source', coalesce(v_source, 'auto-trigger'),
      'note',   'Status changed by trigger'
    ),
    v_actor
  );

  return new;
end$$;


ALTER FUNCTION "public"."compliance_status_trigger"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."compute_resolution_hash"("p_prior" "text", "p_title" "text", "p_body" "jsonb") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
begin
  return encode(
    digest(
      coalesce(p_prior,'') || '|' ||
      coalesce(p_title,'') || '|' ||
      public.normalize_jsonb(p_body),
      'sha256'
    ),
    'hex'
  );
end;
$$;


ALTER FUNCTION "public"."compute_resolution_hash"("p_prior" "text", "p_title" "text", "p_body" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_resolution"("p_entity" "uuid", "p_minute_book" "uuid", "p_body" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_section uuid;
  v_new_id uuid;
begin
  -- Find the default 'General' section for this entity
  select id into v_section
  from public.sections
  where entity_id = p_entity and name = 'General'
  limit 1;

  if v_section is null then
    -- If not found, create one automatically
    insert into public.sections (entity_id, name)
    values (p_entity, 'General')
    returning id into v_section;
  end if;

  -- Create the resolution
  insert into public.resolutions (id, entity_id, section_id, title, status, drafted_by)
  values (
    gen_random_uuid(),
    p_entity,
    v_section,
    p_body,
    'draft',
    auth.uid()
  )
  returning id into v_new_id;

  return v_new_id;
end;
$$;


ALTER FUNCTION "public"."create_resolution"("p_entity" "uuid", "p_minute_book" "uuid", "p_body" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_revised_governance_draft"("p_original_draft_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_old public.governance_drafts;
  v_new_id uuid;
begin
  -- Load original draft
  select * into v_old
  from public.governance_drafts
  where id = p_original_draft_id;

  if not found then
    raise exception 'Original draft not found';
  end if;

  if v_old.status != 'finalized' then
    raise exception 'Only finalized drafts can be revised';
  end if;

  -- Create a new editable draft cloned from the old one
  insert into public.governance_drafts (
    entity_id,
    entity_slug,
    entity_name,
    title,
    record_type,
    draft_text,
    status,
    created_by
  )
  values (
    v_old.entity_id,
    v_old.entity_slug,
    v_old.entity_name,
    v_old.title || ' (Revised)',
    v_old.record_type,
    v_old.draft_text,
    'draft',
    v_old.created_by
  )
  returning id into v_new_id;

  return v_new_id;
end;
$$;


ALTER FUNCTION "public"."create_revised_governance_draft"("p_original_draft_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."draft_annual_board_approval"("p_entity_id" "uuid", "p_entity_name" "text", "p_fiscal_year" "text", "p_fiscal_year_end" "text", "p_meeting_date" "date", "p_directors" "text"[]) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_template    jsonb;
  v_whereas     jsonb;
  v_resolved    jsonb;
  v_title       text;
  v_ledger_id   uuid;
  v_resolution_id uuid;
  v_section_id  uuid;
BEGIN
  -- 1. Load template
  SELECT schema_json
  INTO v_template
  FROM public.governance_templates
  WHERE doc_type = 'annual_board_approval'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_template IS NULL THEN
    RAISE EXCEPTION 'Template not found for doc_type=annual_board_approval';
  END IF;

  -- 2. Build title
  v_title := replace(
               replace(
                 replace((v_template->>'title'),
                   '{{entity_name}}', p_entity_name),
                 '{{fiscal_year}}', p_fiscal_year),
               '{{fiscal_year_end}}', p_fiscal_year_end
             );

  -- 3. Build WHEREAS array with replacements
  v_whereas := (
    SELECT jsonb_agg(
      replace(
        replace(
          replace(elem::text,
            '{{entity_name}}', p_entity_name),
          '{{fiscal_year_end}}', p_fiscal_year_end),
        '{{fiscal_year}}', p_fiscal_year
      )::jsonb
    )
    FROM jsonb_array_elements(v_template->'whereas') elem
  );

  -- 4. Build RESOLVED array with replacements
  v_resolved := (
    SELECT jsonb_agg(
      replace(
        replace(
          replace(elem::text,
            '{{entity_name}}', p_entity_name),
          '{{fiscal_year_end}}', p_fiscal_year_end),
        '{{fiscal_year}}', p_fiscal_year
      )::jsonb
    )
    FROM jsonb_array_elements(v_template->'resolved') elem
  );

  -- 5. Pick a section for this entity
  SELECT id INTO v_section_id
  FROM public.sections
  WHERE entity_id = p_entity_id
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_section_id IS NULL THEN
    RAISE EXCEPTION 'No section exists for entity_id=%', p_entity_id;
  END IF;

  -- 6. Create governance_ledger record
  INSERT INTO public.governance_ledger (
    entity_id,
    title,
    description,
    record_type,
    created_by,
    provisional,
    needs_summary
  )
  VALUES (
    p_entity_id,
    v_title,
    'Auto-drafted annual board approval resolution.',
    'resolution',
    auth.uid(),
    true,
    true
  )
  RETURNING id INTO v_ledger_id;

  -- 7. Insert into resolutions
  INSERT INTO public.resolutions (
    section_id,
    title,
    whereas_json,
    resolve_json,
    status,
    created_by,
    entity_id,
    body_json
  )
  VALUES (
    v_section_id,
    v_title,
    v_whereas,
    v_resolved,
    'draft',
    auth.uid(),
    p_entity_id,
    jsonb_build_object(
      'entity_name',       p_entity_name,
      'fiscal_year',       p_fiscal_year,
      'fiscal_year_end',   p_fiscal_year_end,
      'meeting_date',      p_meeting_date,
      'directors',         p_directors,
      'ledger_id',         v_ledger_id
    )
  )
  RETURNING id INTO v_resolution_id;

  RETURN v_resolution_id;
END;
$$;


ALTER FUNCTION "public"."draft_annual_board_approval"("p_entity_id" "uuid", "p_entity_name" "text", "p_fiscal_year" "text", "p_fiscal_year_end" "text", "p_meeting_date" "date", "p_directors" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_completed_envelope_immutability"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  -- If the old status is NOT completed, we only care when it becomes completed.
  if (tg_op = 'UPDATE' and old.status <> 'completed' and new.status = 'completed') then
    -- This transition is allowed (we're completing it now).
    return new;
  end if;

  -- If the envelope is already completed, lock down everything
  -- except metadata changes.
  if (old.status = 'completed') then
    -- Block any attempt to change status away from completed
    if new.status <> old.status then
      raise exception 'Cannot change status of a completed envelope (id=%)', old.id;
    end if;

    -- Block changes to core identity fields
    if new.record_id <> old.record_id
       or new.entity_id <> old.entity_id
       or new.supporting_document_path is distinct from old.supporting_document_path then
      raise exception 'Cannot modify core fields of a completed envelope (id=%)', old.id;
    end if;

    -- Metadata is allowed to change (certificate, verify_url, etc.)
    return new;
  end if;

  -- For all other cases (not completed yet), allow the update
  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_completed_envelope_immutability"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_council_before_ready_for_signature"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_require_council boolean;
  v_entity_id uuid;
BEGIN
  -- Only when status actually changes
  IF NEW.status IS DISTINCT FROM OLD.status THEN

    -- Only care about moves into ready_for_signature
    IF NEW.status = 'ready_for_signature' THEN

      -- 1) Resolve entity via governance_ledger
      SELECT gl.entity_id
      INTO v_entity_id
      FROM governance_ledger gl
      WHERE gl.id = NEW.record_id;

      -- 2) Look up policy for that entity
      IF v_entity_id IS NOT NULL THEN
        SELECT gp.require_council_review
        INTO v_require_council
        FROM governance_policies gp
        WHERE gp.entity_id = v_entity_id;
      ELSE
        v_require_council := false;
      END IF;

      -- 3) If policy says “council required”, block jump unless already approved
      IF COALESCE(v_require_council, false) THEN
        IF OLD.status IS DISTINCT FROM 'council_approved' THEN
          RAISE EXCEPTION
            'Council approval required before ready_for_signature for entity % (doc %)',
            v_entity_id, NEW.id
          USING ERRCODE = 'P0001';
        END IF;
      END IF;

    END IF;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enforce_council_before_ready_for_signature"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_signature_email_for_party"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  -- Only enqueue if we have an email and the party is pending
  if new.email is not null
     and new.status = 'pending' then

    insert into public.signature_email_queue (
      envelope_id,
      party_id,
      to_email,
      to_name,
      template_key,
      payload
    )
    values (
      new.envelope_id,
      new.id,
      new.email,
      coalesce(new.display_name, new.email),
      'signature_invite',
      jsonb_build_object(
        'party_id', new.id,
        'envelope_id', new.envelope_id
      )
    );
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."enqueue_signature_email_for_party"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."entity_key_to_slug"("p_entity_key" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select p_entity_key  -- adjust here if needed
$$;


ALTER FUNCTION "public"."entity_key_to_slug"("p_entity_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finalize_governance_draft"("p_draft_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_draft public.governance_drafts;
  v_new_record_id uuid;
begin
  select * into v_draft
  from public.governance_drafts
  where id = p_draft_id
  and status in ('draft', 'reviewed');

  if not found then
    raise exception 'Draft not found or already finalized';
  end if;

  insert into public.governance_ledger (
    entity_id,
    entity_slug,
    entity_name,
    title,
    record_type,
    description,
    status
  )
  values (
    v_draft.entity_id,
    v_draft.entity_slug,
    v_draft.entity_name,
    v_draft.title,
    v_draft.record_type,
    v_draft.draft_text,
    'pending_approval'
  )
  returning id into v_new_record_id;

  update public.governance_drafts
  set
    status = 'finalized',
    finalized_at = now(),
    finalized_record_id = v_new_record_id
  where id = p_draft_id;

  return v_new_record_id;
end;
$$;


ALTER FUNCTION "public"."finalize_governance_draft"("p_draft_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_update_resolution_status_from_review"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  is_latest boolean;
  new_status text;
begin
  -- Check if this is the latest review for the same resolution
  select not exists (
    select 1
    from compliance_reviews cr2
    where cr2.resolution_id = NEW.resolution_id
      and cr2.review_date > coalesce(NEW.review_date, now())
  ) into is_latest;

  if not is_latest then
    return NEW; -- skip if a newer review exists
  end if;

  -- Define mapping from risk level → compliance status
  new_status :=
    case lower(coalesce(NEW.risk_level, ''))
      when 'low'    then 'compliant'
      when 'medium' then 'review_required'
      when 'high'   then 'at_risk'
      else 'pending'
    end;

  -- Update the resolution table
  update resolutions
     set compliance_status = new_status,
         updated_at = now()
   where id = NEW.resolution_id;

  return NEW;
end;
$$;


ALTER FUNCTION "public"."fn_update_resolution_status_from_review"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_all_missing_ai_advice"("p_model" "text" DEFAULT 'gpt-5.1'::"text", "p_risk_rating" numeric DEFAULT 0.8, "p_confidence" numeric DEFAULT 0.9) RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    v_row RECORD;
    v_count INTEGER := 0;
    v_result TEXT;
BEGIN
    -- Loop through corrective actions that need AI advice
    FOR v_row IN
        SELECT ca.id AS corrective_action_id
        FROM public.corrective_actions ca
        LEFT JOIN public.ai_advice a
            ON a.corrective_action_id = ca.id
        WHERE ca.status = 'open'
          AND a.id IS NULL
    LOOP
        BEGIN
            -- Call your existing function
            SELECT public.record_corrective_action_ai_advice(
                p_risk_rating  => p_risk_rating,
                p_confidence   => p_confidence,
                p_model        => p_model,
                p_corrective_action_id => v_row.corrective_action_id
            )
            INTO v_result;

            v_count := v_count + 1;

            -- Log OK event
            INSERT INTO public.ai_status_debug (
                advice_id, record_id, rows_updated,
                event, old_status, new_status, details
            )
            VALUES (
                NULL,
                NULL,
                1,
                'ai_advice_insert',
                NULL,
                'complete',
                'Generated advice for corrective_action_id=' || v_row.corrective_action_id
            );

        EXCEPTION WHEN OTHERS THEN
            -- Log error event
            INSERT INTO public.ai_status_debug (
                advice_id, record_id, rows_updated,
                event, old_status, new_status, details
            )
            VALUES (
                NULL,
                NULL,
                0,
                'ai_advice_error',
                NULL,
                'error',
                format('AI advice generation failed for corrective_action_id=%s. Error=%s',
                       v_row.corrective_action_id,
                       SQLERRM)
            );
            -- Continue loop
        END;
    END LOOP;

    RETURN v_count;
END;
$$;


ALTER FUNCTION "public"."generate_all_missing_ai_advice"("p_model" "text", "p_risk_rating" numeric, "p_confidence" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_entity_slug_for_record"("p_record_id" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE
    AS $$
  select e.slug
  from governance_ledger g
  join entities e on e.id = g.entity_id
  where g.id = p_record_id
$$;


ALTER FUNCTION "public"."get_entity_slug_for_record"("p_record_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."governance_ai_daily_cycle"("p_model" "text" DEFAULT 'gpt-5.1'::"text", "p_risk_rating" numeric DEFAULT 0.8, "p_confidence" numeric DEFAULT 0.9) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_validations_run        integer := 0;
  v_new_corrective_actions integer := 0;
  v_advice_generated       integer := 0;
  v_autoresolved           integer := 0;
begin
  -- 2.a) Re-run all governance validations
  begin
    v_validations_run := coalesce(public.run_all_governance_validations(), 0);
  exception
    when others then
      v_validations_run := -1;
  end;

  -- 2.b) Make sure every open violation has a corrective action
  begin
    v_new_corrective_actions := coalesce(public.auto_create_corrective_actions_for_open_violations(), 0);
  exception
    when others then
      v_new_corrective_actions := -1;
  end;

  -- 2.c) Generate / refresh AI advice for all corrective actions needing it
  begin
    v_advice_generated := coalesce(
      public.record_corrective_action_ai_advice(
        p_risk_rating => p_risk_rating,
        p_confidence  => p_confidence,
        p_model       => p_model
      ),
      0
    );
  exception
    when others then
      v_advice_generated := -1;
  end;

  -- 2.d) Apply AI advice + auto-resolve safe items
  begin
    v_autoresolved := coalesce(public.apply_ai_advice_and_autoresolve(), 0);
  exception
    when others then
      v_autoresolved := -1;
  end;

  -- 2.e) Return a compact status payload for logs / dashboards
  return jsonb_build_object(
    'model',                p_model,
    'risk_rating',          p_risk_rating,
    'confidence',           p_confidence,
    'validations_run',      v_validations_run,
    'new_corrective_actions', v_new_corrective_actions,
    'advice_generated',     v_advice_generated,
    'autoresolved',         v_autoresolved,
    'run_timestamp',        now()
  );
end;
$$;


ALTER FUNCTION "public"."governance_ai_daily_cycle"("p_model" "text", "p_risk_rating" numeric, "p_confidence" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_adopt_resolution"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare q boolean;
begin
  if new.status = 'adopted' then
    select quorum into q
    from public.meetings
    where entity_id = new.entity_id
      and held_at = (select max(held_at)
                     from public.meetings
                     where entity_id = new.entity_id);
    if coalesce(q,false) = false then
      raise exception 'Cannot adopt resolution: quorum not met for latest meeting.';
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."guard_adopt_resolution"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_resolution_transitions"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if (old.status, new.status) not in (
    ('draft','ready'),
    ('ready','adopted'),
    ('draft','draft'),
    ('ready','ready'),
    ('adopted','adopted')
  ) then
    raise exception 'Invalid status transition: % -> %', old.status, new.status;
  end if;
  return new;
end; $$;


ALTER FUNCTION "public"."guard_resolution_transitions"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_role"("entity" "uuid", "roles" "text"[]) RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select exists (
    select 1 from public.memberships m
    where m.entity_id = entity
      and m.user_id = auth.uid()
      and m.role = any(roles)
  );
$$;


ALTER FUNCTION "public"."has_role"("entity" "uuid", "roles" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_member_of"("entity" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select exists (
    select 1 from public.memberships m
    where m.entity_id = entity
      and m.user_id = auth.uid()
  );
$$;


ALTER FUNCTION "public"."is_member_of"("entity" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_ai_sentinel_check"() RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
declare
  rec record;
begin
  select * into rec from public.v_ai_sentinel_status limit 1;

  insert into compliance_audit_log (id, resolution_id, changed_at, actor_type, reviewer, old_status, new_status, context)
  values (
    gen_random_uuid(),
    null,
    now(),
    'ai-sentinel',
    'system',
    'heartbeat_check',
    rec.status,
    jsonb_build_object(
      'last_heartbeat_at', rec.last_beat_utc,
      'hours_since_last_beat', rec.hours_since_last_beat,
      'status', rec.status
    )
  );
end;
$$;


ALTER FUNCTION "public"."log_ai_sentinel_check"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_ai_sentinel_heartbeat"() RETURNS "void"
    LANGUAGE "sql"
    AS $$
  insert into compliance_audit_log
    (resolution_id, old_status, new_status, reviewer, actor_type, context)
  values
    (null, null, null, 'ai-sentinel', 'system',
     jsonb_build_object(
       'note', 'AI Sentinel daily heartbeat',
       'source', 'ai-sentinel',
       'status', 'ok'
     ));
$$;


ALTER FUNCTION "public"."log_ai_sentinel_heartbeat"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_minute_book_entry_to_verified"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  -- Only register RESOLUTIONS that actually have a file
  if new.section_name is null
     or new.section_name <> 'Resolutions'
     or new.storage_path is null then
    return new;
  end if;

  insert into public.verified_documents (
    entity_id,
    entity_slug,
    document_class,
    title,
    source_table,
    source_record_id,
    storage_bucket,
    storage_path,
    verification_level
  )
  values (
    null,                          -- we can map to a UUID later if needed
    new.entity_key::text,          -- enum → text (slug)
    'resolution',                  -- document_class enum
    new.title,
    'minute_book_entries',         -- source table
    new.id,
    'minute_book',                 -- bucket
    new.storage_path,
    'signed_verified'              -- minute book = signed & verified
  );

  return new;
end;
$$;


ALTER FUNCTION "public"."log_minute_book_entry_to_verified"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_minute_book_update_to_verified"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  -- only when section is Resolutions AND storage_path was null and is now set
  if new.section_name = 'Resolutions'
     and (old.storage_path is null and new.storage_path is not null) then

    insert into public.verified_documents (
      entity_id,
      entity_slug,
      document_class,
      title,
      source_table,
      source_record_id,
      storage_bucket,
      storage_path,
      verification_level
    )
    select
      null,
      new.entity_key::text,
      'resolution',
      new.title,
      'minute_book_entries',
      new.id,
      'minute_book',
      new.storage_path,
      'signed_verified'
    where not exists (
      select 1
      from public.verified_documents vd
      where vd.source_table = 'minute_book_entries'
        and vd.source_record_id = new.id
    );
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."log_minute_book_update_to_verified"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_minute_book_upload"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_entity_id uuid;
  v_actor     uuid;
begin
  -- map entity_key_enum → entities.id
  select e.id
  into v_entity_id
  from public.entities e
  where e.slug = new.entity_key::text
  limit 1;

  -- choose an actor: auth user if present, otherwise owner_id, otherwise random
  v_actor := coalesce(auth.uid(), new.owner_id, gen_random_uuid());

  insert into public.audit_logs (
    entity_id,
    actor,
    table_name,
    row_pk,
    action,
    payload,
    hash
  )
  values (
    v_entity_id,
    v_actor,
    'minute_book_entries',
    new.id::text,
    'insert',
    to_jsonb(new),
    encode(digest(new.id::text, 'sha256'), 'hex')
  );

  return new;
end;
$$;


ALTER FUNCTION "public"."log_minute_book_upload"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_orb_event"("p_source" "text", "p_message" "text", "p_mode" "text" DEFAULT NULL::"text", "p_meta" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
begin
  insert into ci_orb_logs (source, message, mode, meta)
  values (p_source, p_message, p_mode, p_meta);
end;
$$;


ALTER FUNCTION "public"."log_orb_event"("p_source" "text", "p_message" "text", "p_mode" "text", "p_meta" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_resolution_status_change"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  -- Only log when status actually changes
  if (old.status is distinct from new.status) then
    insert into public.resolution_status_history (
      resolution_id,
      old_status,
      new_status,
      reason,
      changed_by,
      context
    )
    values (
      old.id,
      old.status,
      new.status,
      coalesce(current_setting('app.resolution_status_reason', true), null),
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      coalesce(
        nullif(current_setting('app.resolution_status_context', true), ''),
        '{}'::jsonb
      )
    );
  end if;

  -- You could also update NEW.updated_at here if desired:
  -- new.updated_at := now();

  return new;
end;
$$;


ALTER FUNCTION "public"."log_resolution_status_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_signature_envelope_status_change"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if (old.status is distinct from new.status) then
    insert into public.signature_envelope_status_history (
      envelope_id,
      old_status,
      new_status,
      reason,
      changed_by,
      context
    )
    values (
      old.id,
      old.status,
      new.status,
      coalesce(current_setting('app.signature_status_reason', true), null),
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      coalesce(
        nullif(current_setting('app.signature_status_context', true), ''),
        '{}'::jsonb
      )
    );
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."log_signature_envelope_status_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mb_map_section"("src" "text") RETURNS "public"."doc_section_enum"
    LANGUAGE "plpgsql"
    AS $$
declare s text := coalesce(src, '');
begin
  -- No subfolder → files at the root of OIRE_MinuteBook
  if s = '' then
    return 'general';
  end if;

  -- Normalize
  s := lower(s);

  -- Match common folders you showed me (ILike patterns are flexible)
  if s like '%certificate%' or s like '%articles%' then
    return 'formation';
  elsif s like '%initial return%' or s like '%notice%' then
    return 'notices';
  elsif s like '%annual return%' then
    return 'annual_returns';
  elsif s like '%register%' or s like '%ledger%' then
    return 'registers';
  elsif s like '%resolution%' then
    return 'resolutions';
  elsif s like '%by-law%' or s like '%bylaw%' then
    return 'bylaws';
  elsif s like '%share certificate%' then
    return 'share_certificates';
  elsif s like '%director%' or s like '%officer%' or s like '%consent%' then
    return 'consents';
  elsif s like '%bank%' or s like '%equitable%' or s like '%cibc%' or s like '%scotia%' then
    return 'banking';
  elsif s like '%insurance%' or s like '%zensurance%' then
    return 'insurance';
  elsif s like '%appraisal%' then
    return 'appraisal';
  elsif s like '%compliance%' or s like '%misc%' then
    return 'compliance';
  elsif s like '%legal submission%' or s like '%closing binder%' or s like '%ammar law%' then
    return 'legal_package';
  else
    return 'general';
  end if;
end
$$;


ALTER FUNCTION "public"."mb_map_section"("src" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mb_parse_filename"("fname" "text") RETURNS TABLE("file_date" "date", "base_title" "text", "version" integer)
    LANGUAGE "plpgsql"
    AS $_$
declare
  m text[];
  stem text;
begin
  -- Try pattern with separators (YYYY[-_/.]MM[-_/.]DD then space/underscore/dash)
  m := regexp_match(fname,
        '^(\d{4}[-_/.]\d{2}[-_/.]\d{2})[ _-]+(.+?)(?:[ _-]*v(\d+))?\.[A-Za-z0-9]+$');

  if m is not null then
    file_date := to_date(m[1], 'YYYY-MM-DD');
    base_title := trim(both ' _-' from m[2]);
    version := coalesce(nullif(m[3], ''), '1')::int;
    return next;
  end if;

  -- Try compact yyyymmdd
  m := regexp_match(fname,
        '^(\d{8})[ _-]+(.+?)(?:[ _-]*v(\d+))?\.[A-Za-z0-9]+$');
  if m is not null then
    file_date := to_date(m[1], 'YYYYMMDD');
    base_title := trim(both ' _-' from m[2]);
    version := coalesce(nullif(m[3], ''), '1')::int;
    return next;
  end if;

  -- Fallback: no parseable date; use filename (without extension) and version=1
  stem := regexp_replace(fname, '\.[A-Za-z0-9]+$', '');
  file_date := null;             -- will be coalesced by RPC
  base_title := stem;
  version := 1;
  return next;
end
$_$;


ALTER FUNCTION "public"."mb_parse_filename"("fname" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_jsonb"("j" "jsonb") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select jsonb_pretty(coalesce(j, '{}'::jsonb))::text
$$;


ALTER FUNCTION "public"."normalize_jsonb"("j" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."onboard_entity_for_user"("p_slug" "text", "p_name" "text", "p_user_email" "text", "p_kind" "text" DEFAULT 'client'::"text") RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_entity_id uuid;
  v_user_id   uuid;
begin
  -- 1. Find or create entity
  insert into public.entities (slug, name, kind)
  values (p_slug, p_name, p_kind)
  on conflict (slug) do update
    set name = excluded.name,
        kind = excluded.kind
  returning id into v_entity_id;

  -- 2. Find user by email
  select id into v_user_id
  from auth.users
  where email = p_user_email;

  if v_user_id is null then
    raise exception 'No auth.users row found for email: %', p_user_email;
  end if;

  -- 3. Ensure membership
  insert into public.memberships (user_id, entity_id, role, is_admin)
  values (v_user_id, v_entity_id, 'owner', true)
  on conflict (user_id, entity_id) do update
    set role = excluded.role,
        is_admin = excluded.is_admin;

  return v_entity_id;
end;
$$;


ALTER FUNCTION "public"."onboard_entity_for_user"("p_slug" "text", "p_name" "text", "p_user_email" "text", "p_kind" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_corrective_action_ai_advice"("p_risk_rating" numeric, "p_confidence" numeric, "p_model" "text") RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_row     public.v_corrective_actions_needing_ai%ROWTYPE;
  v_count   integer := 0;
  v_advice_id uuid;
BEGIN
  -- Loop over all corrective actions that still need AI advice
  FOR v_row IN
    SELECT *
    FROM public.v_corrective_actions_needing_ai
  LOOP
    BEGIN
      -- 1) Insert a queued AI advice row, linked to the corrective_action
      INSERT INTO public.ai_advice (
        record_id,
        corrective_action_id,
        recommendation,
        risk_rating,
        confidence,
        ai_source,
        model_id,
        model_hash,
        generated_at,
        advice,
        model
      )
      VALUES (
        NULL,                                      -- no specific governance_ledger record yet
        v_row.corrective_action_id,                -- link to corrective_actions.id
        'AI-generated recommendation pending',     -- placeholder until AI runs
        p_risk_rating,
        p_confidence,
        'cloud',
        NULL,                                      -- model_id (optional)
        NULL,                                      -- model_hash (optional)
        now(),
        NULL,                                      -- advice text (to be filled by worker)
        p_model
      )
      RETURNING id INTO v_advice_id;

      v_count := v_count + 1;

      -- 2) Log the queueing action in ai_status_debug
      INSERT INTO public.ai_status_debug (
        advice_id,
        record_id,
        rows_updated,
        event,
        old_status,
        new_status,
        details
      )
      VALUES (
        v_advice_id,
        NULL,
        0,
        'queued_corrective_action_ai_advice',
        NULL,
        NULL,
        format(
          'Queued AI advice for corrective_action_id=%s, rule_key=%s, severity=%s, owner=%s, due_date=%s',
          v_row.corrective_action_id::text,
          COALESCE(v_row.rule_key::text, '<null>'),
          COALESCE(v_row.severity::text, '<null>'),
          COALESCE(v_row.owner::text, '<null>'),
          COALESCE(v_row.due_date::text, '<null>')
        )
      );

    EXCEPTION
      WHEN OTHERS THEN
        -- 3) On error for this row, log and continue
        INSERT INTO public.ai_status_debug (
          advice_id,
          record_id,
          rows_updated,
          event,
          old_status,
          new_status,
          details
        )
        VALUES (
          NULL,
          NULL,
          0,
          'error_queuing_corrective_action_ai_advice',
          NULL,
          NULL,
          format(
            'Error while queuing corrective_action_id=%s: %s',
            v_row.corrective_action_id::text,
            SQLERRM
          )
        );
        -- Do NOT RAISE; continue with remaining actions.
    END;
  END LOOP;

  RETURN v_count;
END;
$$;


ALTER FUNCTION "public"."record_corrective_action_ai_advice"("p_risk_rating" numeric, "p_confidence" numeric, "p_model" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_corrective_action_ai_advice"("p_corrective_action_id" "uuid", "p_recommendation" "text", "p_risk_rating" numeric DEFAULT NULL::numeric, "p_confidence" numeric DEFAULT NULL::numeric, "p_model" "text" DEFAULT NULL::"text", "p_ai_source" "text" DEFAULT 'cloud'::"text") RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.ai_advice (
    record_id,
    corrective_action_id,
    recommendation,
    risk_rating,
    confidence,
    ai_source,
    model,
    generated_at
  )
  VALUES (
    NULL,                     -- no specific governance_ledger record
    p_corrective_action_id,
    p_recommendation,
    p_risk_rating,
    p_confidence,
    p_ai_source,
    p_model,
    now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."record_corrective_action_ai_advice"("p_corrective_action_id" "uuid", "p_recommendation" "text", "p_risk_rating" numeric, "p_confidence" numeric, "p_model" "text", "p_ai_source" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolution_body_normalized"("p_body" "jsonb", "p_whereas" "jsonb", "p_resolve" "jsonb") RETURNS "jsonb"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select coalesce(
    nullif(p_body, '{}'::jsonb),                                -- prefer body_json if set
    jsonb_build_object(                                         -- else build from whereas/resolve
      'whereas', coalesce(p_whereas, '[]'::jsonb),
      'resolved', coalesce(p_resolve, '[]'::jsonb)
    )
  )
$$;


ALTER FUNCTION "public"."resolution_body_normalized"("p_body" "jsonb", "p_whereas" "jsonb", "p_resolve" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolution_chain_head"("p_entity" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE
    AS $$
  select r.hash
  from public.resolutions r
  where r.entity_id = p_entity and r.hash is not null
  order by r.approved_at desc nulls last, r.created_at desc
  limit 1
$$;


ALTER FUNCTION "public"."resolution_chain_head"("p_entity" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."run_all_governance_validations"() RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_agm    int;
  v_t2     int;
  v_mb     int;
  v_fs     int;
  v_me     int;
  v_parent int;
  v_ca     int;
BEGIN
  v_agm    := public.run_validation_agm_annual();
  v_t2     := public.run_validation_t2_obligation();
  v_mb     := public.run_validation_minute_book_exists();
  v_fs     := public.run_validation_financial_statements_tabled();
  v_me     := public.run_validation_material_event_resolutions();
  v_parent := public.run_validation_parent_approval_for_child_material_events();

  -- Phase 5.A: auto-create corrective actions for any new / existing open violations
  v_ca := public.auto_create_corrective_actions_for_open_violations();

  RETURN jsonb_build_object(
    'agm_missing_inserted',                        v_agm,
    't2_obligation_missing_inserted',              v_t2,
    'minute_book_missing_inserted',                v_mb,
    'financial_statements_missing_inserted',       v_fs,
    'material_event_resolution_missing_inserted',  v_me,
    'parent_approval_missing_inserted',            v_parent,
    'corrective_actions_created',                  v_ca,
    'ran_at',                                      now()
  );
END;
$$;


ALTER FUNCTION "public"."run_all_governance_validations"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."run_validation_agm_annual"() RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_validation_id uuid;
  v_inserted int := 0;
BEGIN
  SELECT id INTO v_validation_id
  FROM public.governance_validations
  WHERE rule_key = 'OBCA-AGM-ANNUAL-CHECK'
    AND is_active = true
  LIMIT 1;

  IF v_validation_id IS NULL THEN
    RAISE NOTICE 'Validation OBCA-AGM-ANNUAL-CHECK not found or inactive';
    RETURN 0;
  END IF;

  -- Mark old violations as corrected if an AGM now exists
  UPDATE public.governance_violations gv
  SET status = 'corrected',
      corrected_at = now()
  WHERE gv.validation_id = v_validation_id
    AND gv.status IN ('open','in_review')
    AND EXISTS (
      SELECT 1
      FROM public.meetings m
      WHERE m.entity_id = gv.entity_id
        AND (m.notes ILIKE '%AGM%' OR m.notes ILIKE '%Annual General Meeting%')
        AND EXTRACT(year FROM m.held_at) = (gv.details->>'year')::int
    );

  -- Insert new violations for years missing an AGM
  INSERT INTO public.governance_violations (
    validation_id,
    entity_id,
    status,
    detected_at,
    detected_by,
    details
  )
  SELECT
    v_validation_id,
    e.id,
    'open',
    now(),
    'system',
    jsonb_build_object(
      'year', yr,
      'issue', 'Missing AGM meeting for this year',
      'rule_key', 'OBCA-AGM-ANNUAL-CHECK'
    )
  FROM (
    SELECT
      e.id AS entity_id,
      generate_series(
        EXTRACT(year FROM COALESCE(e.created_at, now()))::int,
        EXTRACT(year FROM now())::int
      ) AS yr
    FROM public.entities e
  ) s
  JOIN public.entities e ON e.id = s.entity_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.meetings m
    WHERE m.entity_id = e.id
      AND EXTRACT(year FROM m.held_at) = s.yr
      AND (m.notes ILIKE '%AGM%' OR m.notes ILIKE '%Annual General Meeting%')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.governance_violations gv
    WHERE gv.validation_id = v_validation_id
      AND gv.entity_id = e.id
      AND gv.details->>'year' = s.yr::text
      AND gv.status IN ('open','in_review')
  );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;


ALTER FUNCTION "public"."run_validation_agm_annual"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."run_validation_financial_statements_tabled"() RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_validation_id uuid;
  v_inserted int := 0;
BEGIN
  SELECT id INTO v_validation_id
  FROM public.governance_validations
  WHERE rule_key = 'OBCA-FINANCIAL-STATEMENTS-TABLED-CHECK'
    AND is_active = true
  LIMIT 1;

  IF v_validation_id IS NULL THEN
    RAISE NOTICE 'Validation OBCA-FINANCIAL-STATEMENTS-TABLED-CHECK not found or inactive';
    RETURN 0;
  END IF;

  -- Correct old violations if financial statement record now exists
  UPDATE public.governance_violations gv
  SET status = 'corrected',
      corrected_at = now()
  WHERE gv.validation_id = v_validation_id
    AND gv.status IN ('open','in_review')
    AND EXISTS (
      SELECT 1
      FROM public.governance_ledger gl
      WHERE gl.entity_id = gv.entity_id
        AND gl.record_type IN ('meeting','resolution')
        AND (
          gl.title ILIKE '%financial statement%'
          OR gl.description ILIKE '%financial statement%'
        )
        AND EXTRACT(year FROM gl.created_at) = (gv.details->>'year')::int
    );

  -- Insert new violations where AGM exists but no financial statements record
  INSERT INTO public.governance_violations (
    validation_id,
    entity_id,
    status,
    detected_at,
    detected_by,
    details
  )
  SELECT DISTINCT
    v_validation_id,
    m.entity_id,
    'open',
    now(),
    'system',
    jsonb_build_object(
      'year', EXTRACT(year FROM m.held_at)::int,
      'issue', 'AGM held but no governance record of financial statements being tabled.',
      'rule_key', 'OBCA-FINANCIAL-STATEMENTS-TABLED-CHECK'
    )
  FROM public.meetings m
  WHERE (m.notes ILIKE '%AGM%' OR m.notes ILIKE '%Annual General Meeting%')
  AND NOT EXISTS (
    SELECT 1
    FROM public.governance_ledger gl
    WHERE gl.entity_id = m.entity_id
      AND gl.record_type IN ('meeting','resolution')
      AND (
        gl.title ILIKE '%financial statement%'
        OR gl.description ILIKE '%financial statement%'
      )
      AND EXTRACT(year FROM gl.created_at) = EXTRACT(year FROM m.held_at)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.governance_violations gv
    WHERE gv.validation_id = v_validation_id
      AND gv.entity_id = m.entity_id
      AND gv.details->>'year' = EXTRACT(year FROM m.held_at)::text
      AND gv.status IN ('open','in_review')
  );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;


ALTER FUNCTION "public"."run_validation_financial_statements_tabled"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."run_validation_material_event_resolutions"() RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_validation_id uuid;
  v_inserted int := 0;
BEGIN
  SELECT id INTO v_validation_id
  FROM public.governance_validations
  WHERE rule_key = 'INT-MATERIAL-EVENT-RESOLUTION-CHECK'
    AND is_active = true
  LIMIT 1;

  IF v_validation_id IS NULL THEN
    RAISE NOTICE 'Validation INT-MATERIAL-EVENT-RESOLUTION-CHECK not found or inactive';
    RETURN 0;
  END IF;

  -- Correct old violations if resolution now exists
  UPDATE public.governance_violations gv
  SET status = 'corrected',
      corrected_at = now()
  WHERE gv.validation_id = v_validation_id
    AND gv.status IN ('open','in_review')
    AND EXISTS (
      SELECT 1
      FROM public.financial_events fe
      JOIN public.governance_ledger gl
        ON gl.linked_financial_event_id = fe.id
       AND gl.record_type = 'resolution'
      WHERE fe.entity_id = gv.entity_id
        AND fe.id = (gv.details->>'financial_event_id')::uuid
        AND fe.status IN ('approved','posted')
    );

  -- Insert new violations for material events with no resolution
  INSERT INTO public.governance_violations (
    validation_id,
    entity_id,
    obligation_id,
    status,
    detected_at,
    detected_by,
    details
  )
  SELECT
    v_validation_id,
    fe.entity_id,
    NULL,
    'open',
    now(),
    'system',
    jsonb_build_object(
      'financial_event_id', fe.id,
      'description', fe.description,
      'amount', fe.amount,
      'status', fe.status,
      'issue', 'Approved/posted financial event has no linked resolution.',
      'rule_key', 'INT-MATERIAL-EVENT-RESOLUTION-CHECK'
    )
  FROM public.financial_events fe
  WHERE fe.status IN ('approved','posted')
    AND NOT EXISTS (
      SELECT 1
      FROM public.governance_ledger gl
      WHERE gl.linked_financial_event_id = fe.id
        AND gl.record_type = 'resolution'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.governance_violations gv
      WHERE gv.validation_id = v_validation_id
        AND gv.entity_id = fe.entity_id
        AND gv.details->>'financial_event_id' = fe.id::text
        AND gv.status IN ('open','in_review')
    );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;


ALTER FUNCTION "public"."run_validation_material_event_resolutions"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."run_validation_minute_book_exists"() RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_validation_id uuid;
  v_inserted int := 0;
BEGIN
  SELECT id INTO v_validation_id
  FROM public.governance_validations
  WHERE rule_key = 'INT-MINUTE-BOOK-COMPLETE-CHECK'
    AND is_active = true
  LIMIT 1;

  IF v_validation_id IS NULL THEN
    RAISE NOTICE 'Validation INT-MINUTE-BOOK-COMPLETE-CHECK not found or inactive';
    RETURN 0;
  END IF;

  -- Mark old violations as corrected if a minute book now exists
  UPDATE public.governance_violations gv
  SET status = 'corrected',
      corrected_at = now()
  WHERE gv.validation_id = v_validation_id
    AND gv.status IN ('open','in_review')
    AND EXISTS (
      SELECT 1
      FROM public.minute_books mb
      WHERE mb.entity_id = gv.entity_id
    );

  -- Insert violations where no minute book exists
  INSERT INTO public.governance_violations (
    validation_id,
    entity_id,
    status,
    detected_at,
    detected_by,
    details
  )
  SELECT
    v_validation_id,
    e.id,
    'open',
    now(),
    'system',
    jsonb_build_object(
      'issue', 'No minute book defined for this entity',
      'rule_key', 'INT-MINUTE-BOOK-COMPLETE-CHECK'
    )
  FROM public.entities e
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.minute_books mb
    WHERE mb.entity_id = e.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.governance_violations gv
    WHERE gv.validation_id = v_validation_id
      AND gv.entity_id = e.id
      AND gv.status IN ('open','in_review')
  );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;


ALTER FUNCTION "public"."run_validation_minute_book_exists"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."run_validation_parent_approval_for_child_material_events"() RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_validation_id uuid;
  v_min_amount numeric := 0;
  v_inserted int := 0;
BEGIN
  -- Get validation + min_amount threshold
  SELECT
    id,
    COALESCE((metadata->>'min_amount')::numeric, 0)
  INTO v_validation_id, v_min_amount
  FROM public.governance_validations
  WHERE rule_key = 'INT-PARENT-APPROVAL-MATERIAL-CHILD-EVENT'
    AND is_active = true
  LIMIT 1;

  IF v_validation_id IS NULL THEN
    RAISE NOTICE 'Validation INT-PARENT-APPROVAL-MATERIAL-CHILD-EVENT not found or inactive';
    RETURN 0;
  END IF;

  -- First, mark old violations as corrected if a parent resolution now exists
  UPDATE public.governance_violations gv
  SET status = 'corrected',
      corrected_at = now()
  WHERE gv.validation_id = v_validation_id
    AND gv.status IN ('open','in_review')
    AND EXISTS (
      SELECT 1
      FROM public.financial_events fe
      JOIN public.entity_relationships er
        ON er.child_entity_id = fe.entity_id
       AND er.parent_entity_id = gv.entity_id
      JOIN public.governance_ledger gl
        ON gl.linked_financial_event_id = fe.id
       AND gl.entity_id = er.parent_entity_id
       AND gl.record_type = 'resolution'
      WHERE fe.id = (gv.details->>'financial_event_id')::uuid
        AND fe.status IN ('approved','posted')
        AND fe.amount >= v_min_amount
    );

  -- Now insert new violations for material child events without parent approval
  INSERT INTO public.governance_violations (
    validation_id,
    entity_id,        -- parent entity that should have approved
    status,
    detected_at,
    detected_by,
    details
  )
  SELECT
    v_validation_id,
    er.parent_entity_id,
    'open',
    now(),
    'system',
    jsonb_build_object(
      'financial_event_id', fe.id,
      'child_entity_id', fe.entity_id,
      'amount', fe.amount,
      'status', fe.status,
      'issue', 'Material child financial event has no parent resolution linked.',
      'rule_key', 'INT-PARENT-APPROVAL-MATERIAL-CHILD-EVENT'
    )
  FROM public.financial_events fe
  JOIN public.entity_relationships er
    ON er.child_entity_id = fe.entity_id
   -- treat any relationship_type as relevant; can narrow later if needed
  WHERE fe.status IN ('approved','posted')
    AND fe.amount IS NOT NULL
    AND fe.amount >= v_min_amount
    AND NOT EXISTS (
      SELECT 1
      FROM public.governance_ledger gl
      WHERE gl.linked_financial_event_id = fe.id
        AND gl.entity_id = er.parent_entity_id
        AND gl.record_type = 'resolution'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.governance_violations gv
      WHERE gv.validation_id = v_validation_id
        AND gv.entity_id = er.parent_entity_id
        AND gv.details->>'financial_event_id' = fe.id::text
        AND gv.status IN ('open','in_review')
    );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;


ALTER FUNCTION "public"."run_validation_parent_approval_for_child_material_events"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."run_validation_t2_obligation"() RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_validation_id uuid;
  v_req_id uuid;
  v_inserted int := 0;
BEGIN
  SELECT id INTO v_req_id
  FROM public.governance_requirements
  WHERE requirement_code = 'CRA-T2-ANNUAL-FILING'
  LIMIT 1;

  IF v_req_id IS NULL THEN
    RAISE NOTICE 'Requirement CRA-T2-ANNUAL-FILING not found';
    RETURN 0;
  END IF;

  SELECT id INTO v_validation_id
  FROM public.governance_validations
  WHERE rule_key = 'CRA-T2-ANNUAL-FILING-CHECK'
    AND is_active = true
  LIMIT 1;

  IF v_validation_id IS NULL THEN
    RAISE NOTICE 'Validation CRA-T2-ANNUAL-FILING-CHECK not found or inactive';
    RETURN 0;
  END IF;

  -- Mark old violations as corrected if an obligation now exists
  UPDATE public.governance_violations gv
  SET status = 'corrected',
      corrected_at = now()
  WHERE gv.validation_id = v_validation_id
    AND gv.status IN ('open','in_review')
    AND EXISTS (
      SELECT 1
      FROM public.compliance_obligations co
      WHERE co.entity_id = gv.entity_id
        AND co.requirement_id = v_req_id
    );

  -- Insert violations where no T2 obligation exists
  INSERT INTO public.governance_violations (
    validation_id,
    entity_id,
    status,
    detected_at,
    detected_by,
    details
  )
  SELECT
    v_validation_id,
    e.id,
    'open',
    now(),
    'system',
    jsonb_build_object(
      'issue', 'Missing T2 annual filing obligation for this entity',
      'rule_key', 'CRA-T2-ANNUAL-FILING-CHECK'
    )
  FROM public.entities e
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.compliance_obligations co
    WHERE co.entity_id = e.id
      AND co.requirement_id = v_req_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.governance_violations gv
    WHERE gv.validation_id = v_validation_id
      AND gv.entity_id = e.id
      AND gv.status IN ('open','in_review')
  );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;


ALTER FUNCTION "public"."run_validation_t2_obligation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."schedule_due_compliance_reviews"() RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
declare
    v_row record;
begin
    -- loop all obligations that are due today or earlier
    for v_row in
        select *
        from public.compliance_obligations
        where next_review_date <= current_date
    loop
        -- 1) insert a pending review for this obligation
        insert into public.compliance_reviews (
            obligation_id,
            review_date,
            overall_status,
            ai_source,
            source_table
        )
        values (
            v_row.id,
            now(),
            'pending',
            'cloud',
            'compliance_obligations'
        );

        -- 2) move the next review date forward by the review_frequency
        update public.compliance_obligations
        set next_review_date = current_date + review_frequency
        where id = v_row.id;
    end loop;
end;
$$;


ALTER FUNCTION "public"."schedule_due_compliance_reviews"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_resolution_status_from_review"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  update resolutions r
  set compliance_status = case lower(new.risk_level)
    when 'low'    then 'compliant'
    when 'medium' then 'review_required'
    when 'high'   then 'at_risk'
    else 'pending'
  end
  where r.id = new.resolution_id;
  return new;
end;
$$;


ALTER FUNCTION "public"."set_resolution_status_from_review"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_verified_documents_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_verified_documents_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_obligation_from_review"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_next_date date;
  v_status    text;
  v_freq      interval;
begin
  if new.obligation_id is null then
    return new;
  end if;

  -- Get review frequency for this obligation
  select coalesce(o.review_frequency, interval '1 year')
  into v_freq
  from public.compliance_obligations o
  where o.id = new.obligation_id;

  -- Compute next review date relative to this review_day
  v_next_date := new.review_day + v_freq;

  -- Derive obligation status from review result
  v_status :=
    case
      when new.compliant is true
           and coalesce(new.risk_level,'low') = 'low'
        then 'compliant'
      when new.compliant is false
           or new.risk_level = 'high'
        then 'at_risk'
      else 'in_progress'
    end;

  update public.compliance_obligations o
  set
    next_review_date = v_next_date,
    status           = v_status
  where o.id = new.obligation_id;

  return new;
end;
$$;


ALTER FUNCTION "public"."sync_obligation_from_review"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tg_resolutions_hash"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  head text;
  eff_body jsonb;
begin
  if new.status = 'approved' then
    head := public.resolution_chain_head(new.entity_id);
    eff_body := public.resolution_body_normalized(new.body_json, new.whereas_json, new.resolve_json);
    new.prior_hash := head;
    new.hash := public.compute_resolution_hash(head, new.title, eff_body);
    if new.approved_at is null then new.approved_at := now(); end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."tg_resolutions_hash"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_governance_draft_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_governance_draft_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_governance_policies_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."touch_governance_policies_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end $$;


ALTER FUNCTION "public"."touch_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_audit_compliance_change"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.compliance_status is distinct from old.compliance_status then
    insert into compliance_audit_log (resolution_id, old_status, new_status, context)
    values (
      new.id,
      old.compliance_status,
      new.compliance_status,
      jsonb_build_object(
        'source', 'auto-trigger',
        'note', concat('Status changed on ', now())
      )
    );
  end if;
  return new;
end $$;


ALTER FUNCTION "public"."trg_audit_compliance_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_governance_documents_after_ins"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_policy_id uuid;
  v_keep_years integer;
begin
  -- 1) Attach retention policy if not set
  if new.retention_policy_id is null then
    -- Example: policy_key is combination of category + doc_type
    select id, keep_years
      into v_policy_id, v_keep_years
    from document_retention_policies
    where policy_key = coalesce(new.metadata->>'retention_key',
                                new.doc_type);  -- fallback

    if v_policy_id is not null then
      update governance_documents
         set retention_policy_id = v_policy_id,
             expires_at = case
                            when v_keep_years is not null
                            then new.created_at + (v_keep_years || ' years')::interval
                            else null
                          end
       where id = new.id;
    end if;
  end if;

  -- 2) Mark governance_ledger record as needing AI summary/analysis
  --    We only do this for "governance" docs (AnnualReturns, Resolutions, Financials)
  if new.metadata->>'category' in ('AnnualReturns','Resolutions','Financials') then
    update governance_ledger
       set needs_summary = true,
           ai_status      = 'pending'
     where id = new.record_id;
  end if;

  -- 3) (Optional) enqueue a sentinel task row
  -- insert into ai_sentinel_tasks(...)
  --   values (...);  -- you already have the pattern from earlier

  return new;
end;
$$;


ALTER FUNCTION "public"."trg_governance_documents_after_ins"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_governance_documents_before_ins"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_entity_slug text;
  v_year        integer;
  v_category    text;
  v_subfolder   text;
  v_created_at  timestamptz;
begin
  -- 1) Derive entity_slug + created_at from related record
  select e.slug, g.created_at
    into v_entity_slug, v_created_at
  from governance_ledger g
  join entities e on e.id = g.entity_id
  where g.id = new.record_id;

  if v_entity_slug is null then
    raise exception 'Could not resolve entity_slug for record_id %', new.record_id;
  end if;

  -- 2) Category & subfolder come from metadata (simple but flexible)
  v_category  := coalesce(new.metadata->>'category', 'Other');   -- e.g. 'AnnualReturns'
  v_subfolder := new.metadata->>'subfolder';                     -- e.g. 'Section-1'

  -- 3) Year: metadata first, then record created_at, then current year
  v_year := nullif(new.metadata->>'year', '')::int;
  if v_year is null then
    v_year := coalesce(
      nullif(extract(year from v_created_at)::int, 0),
      extract(year from current_date)::int
    );
  end if;

  -- 4) Build storage_path if not supplied
  if new.storage_path is null or new.storage_path = '' then
    new.storage_path := public.build_storage_path(
      v_entity_slug,
      v_category,
      v_year,
      new.file_name,
      v_subfolder
    );
  end if;

  -- 5) Optionally default doc_type/mime_type if missing
  if new.doc_type is null then
    new.doc_type := 'pdf';
  end if;

  if new.mime_type is null then
    new.mime_type := 'application/pdf';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."trg_governance_documents_before_ins"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_log_compliance_change"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.compliance_status is distinct from old.compliance_status then
    insert into compliance_audit_log (resolution_id, old_status, new_status, context)
    values (new.id, old.compliance_status, new.compliance_status, jsonb_build_object(
      'source', current_setting('application_name', true),
      'note', 'auto-logged change from compliance_status trigger'
    ));
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."trg_log_compliance_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_normalize_low_to_compliant"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.risk_level = 'low' then
    new.compliant := true;
  end if;
  return new;
end $$;


ALTER FUNCTION "public"."trg_normalize_low_to_compliant"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_set_status"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  update resolutions r
     set compliance_status = case when new.risk_level = 'low'
                                  then 'compliant'
                                  else 'review_required'
                             end
   where r.id = new.resolution_id;
  return new;
end;
$$;


ALTER FUNCTION "public"."trg_set_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_supporting_documents_before_ins"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_entity_slug text;
  v_year        integer;
  v_section     text;
  v_created_at  timestamptz;
begin
  -- 1) Derive entity slug from entity_key
  v_entity_slug := public.entity_key_to_slug(new.entity_key::text);

  if v_entity_slug is null then
    raise exception 'Could not resolve entity_slug from entity_key %', new.entity_key;
  end if;

  -- 2) Section from enum (cast to text)
  v_section := new.section::text;  -- e.g. 'Banking', 'Tax', etc.

  -- 3) Year: use uploaded_at or now
  v_year := extract(year from coalesce(new.uploaded_at, now()))::int;

  -- 4) Build file_path if null
  if new.file_path is null or new.file_path = '' then
    new.file_path := format(
      '%s/Supporting/%s/%s/%s',
      v_entity_slug,
      v_year,
      v_section,
      trim(both '/' from new.file_name)
    );
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."trg_supporting_documents_before_ins"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_ai_status"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_old_status text;
begin
  select ai_status
  into v_old_status
  from public.governance_ledger
  where id = NEW.record_id;

  -- Log what happened
  insert into public.ai_status_debug(event, record_id, advice_id, old_status, new_status)
  values (
    'ai_advice_insert',
    NEW.record_id,
    NEW.id,
    v_old_status,
    'complete'
  );

  -- Update the ledger row
  update public.governance_ledger g
  set ai_status = 'complete'
  where g.id = NEW.record_id;

  return NEW;
end;
$$;


ALTER FUNCTION "public"."update_ai_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_governance_documents_ocr_tsv"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.ocr_tsv :=
    to_tsvector('english', coalesce(NEW.ocr_text, '')) ||
    to_tsvector('english', coalesce(NEW.file_name, ''));
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_governance_documents_ocr_tsv"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upload_minute_book_document"("p_entity_key" "public"."entity_key_enum", "p_entry_type" "public"."entry_type_enum", "p_title" "text", "p_notes" "text", "p_file_name" "text", "p_storage_path" "text", "p_file_hash" "text", "p_file_size" bigint, "p_mime_type" "text", "p_owner_id" "uuid" DEFAULT NULL::"uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_entry_id uuid;
  v_owner_id uuid;
begin
  -- decide who owns this record
  v_owner_id := coalesce(p_owner_id, auth.uid(), gen_random_uuid());

  -- main minute-book entry
  insert into public.minute_book_entries (
    entity_key,
    entry_date,
    entry_type,
    title,
    notes,
    owner_id,
    file_name,
    storage_path
  )
  values (
    p_entity_key,
    current_date,
    p_entry_type,
    p_title,
    p_notes,
    v_owner_id,
    p_file_name,
    p_storage_path
  )
  returning id into v_entry_id;

  -- linked supporting document (note the cast for section)
  insert into public.supporting_documents (
    entry_id,
    entity_key,
    section,
    file_path,
    file_name,
    mime_type,
    file_hash,
    file_size,
    owner_id
  )
  values (
    v_entry_id,
    p_entity_key,
    p_entry_type::text::doc_section_enum,
    p_storage_path,
    p_file_name,
    p_mime_type,
    p_file_hash,
    p_file_size,
    v_owner_id
  );

  return v_entry_id;
end;
$$;


ALTER FUNCTION "public"."upload_minute_book_document"("p_entity_key" "public"."entity_key_enum", "p_entry_type" "public"."entry_type_enum", "p_title" "text", "p_notes" "text", "p_file_name" "text", "p_storage_path" "text", "p_file_hash" "text", "p_file_size" bigint, "p_mime_type" "text", "p_owner_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upload_minute_book_document"("p_entity_key" "public"."entity_key_enum", "p_entry_type" "public"."entry_type_enum", "p_section" "public"."doc_section_enum", "p_title" "text", "p_notes" "text", "p_file_name" "text", "p_storage_path" "text", "p_file_hash" "text", "p_file_size" bigint, "p_mime_type" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_entry_id uuid;
  v_owner_id uuid;
  v_section  doc_section_enum;
begin
  -- 1) Decide who owns this record (for audit trace)
  v_owner_id := coalesce(auth.uid(), gen_random_uuid());

  -- 2) Determine section: explicit or default from entry_type
  if p_section is not null then
    v_section := p_section;
  else
    select default_section
      into v_section
    from public.entry_type_default_section
    where entry_type = p_entry_type::text;

    if v_section is null then
      raise exception
        'No default section configured for entry_type %; please provide p_section explicitly.',
        p_entry_type;
    end if;
  end if;

  -- 3) Insert minute book entry (logical record)
  insert into public.minute_book_entries (
    entity_key,
    entry_date,
    entry_type,
    title,
    notes,
    owner_id,
    file_name,
    storage_path
  )
  values (
    p_entity_key,
    current_date,
    p_entry_type,
    p_title,
    p_notes,
    v_owner_id,
    p_file_name,
    p_storage_path
  )
  returning id into v_entry_id;

  -- 4) Insert supporting document (actual file)
  insert into public.supporting_documents (
    entry_id,
    entity_key,
    section,
    file_path,
    file_name,
    mime_type,
    file_hash,
    file_size,
    uploaded_by,   -- 👈 NEW
    owner_id       -- 👈 still set explicitly
  )
  values (
    v_entry_id,
    p_entity_key,
    v_section,
    p_storage_path,
    p_file_name,
    p_mime_type,
    p_file_hash,
    p_file_size,
    v_owner_id,    -- uploaded_by
    v_owner_id     -- owner_id
  );

  return v_entry_id;
end;
$$;


ALTER FUNCTION "public"."upload_minute_book_document"("p_entity_key" "public"."entity_key_enum", "p_entry_type" "public"."entry_type_enum", "p_section" "public"."doc_section_enum", "p_title" "text", "p_notes" "text", "p_file_name" "text", "p_storage_path" "text", "p_file_hash" "text", "p_file_size" bigint, "p_mime_type" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."verify_resolution_hash"("p_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  r record;
  eff_body jsonb;
  expected text;
begin
  select entity_id, title, body_json, whereas_json, resolve_json, prior_hash, hash
    into r
  from public.resolutions where id = p_id;

  if r.hash is null then
    return false;
  end if;

  eff_body := public.resolution_body_normalized(r.body_json, r.whereas_json, r.resolve_json);
  expected := public.compute_resolution_hash(r.prior_hash, r.title, eff_body);
  return expected = r.hash;
end;
$$;


ALTER FUNCTION "public"."verify_resolution_hash"("p_id" "uuid") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."entities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "kind" "text" DEFAULT 'internal'::"text",
    CONSTRAINT "entities_kind_check" CHECK (("kind" = ANY (ARRAY['internal'::"text", 'client'::"text", 'sandbox'::"text", 'test'::"text"])))
);


ALTER TABLE "public"."entities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."governance_ledger" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid",
    "title" "text" NOT NULL,
    "description" "text",
    "record_type" "text",
    "record_no" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "approved_by" "jsonb" DEFAULT '[]'::"jsonb",
    "locked" boolean DEFAULT false,
    "linked_financial_event_id" "uuid",
    "ai_summary_id" "uuid",
    "attachments" "jsonb" DEFAULT '[]'::"jsonb",
    "version" integer DEFAULT 1,
    "provisional" boolean DEFAULT true,
    "provenance" "jsonb" DEFAULT '{}'::"jsonb",
    "needs_summary" boolean DEFAULT false,
    "summarized" boolean DEFAULT false,
    "approved" boolean DEFAULT false,
    "archived" boolean DEFAULT false,
    "ai_status" "text" DEFAULT 'pending'::"text",
    "compliance_status" "text" DEFAULT 'pending'::"text",
    "body" "text" NOT NULL,
    "source" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "status" "text" DEFAULT 'DRAFTED'::"text" NOT NULL,
    "dev_note" "text",
    CONSTRAINT "chk_governance_ledger_source_enum" CHECK (("source" = ANY (ARRAY['unknown'::"text", 'ci-alchemy'::"text", 'ci-forge'::"text", 'manual'::"text", 'migration'::"text"]))),
    CONSTRAINT "governance_ledger_record_type_check" CHECK (("record_type" = ANY (ARRAY['resolution'::"text", 'meeting'::"text", 'decision'::"text"]))),
    CONSTRAINT "governance_ledger_status_check" CHECK (("status" = ANY (ARRAY['DRAFTED'::"text", 'PENDING'::"text", 'APPROVED'::"text", 'REJECTED'::"text", 'READY_FOR_SIGNATURE'::"text", 'SIGNED'::"text", 'ARCHIVED'::"text"])))
);


ALTER TABLE "public"."governance_ledger" OWNER TO "postgres";


CREATE OR REPLACE VIEW "ci"."alchemy_ledger" AS
 SELECT "gl"."id",
    "gl"."entity_id",
    "ent"."slug" AS "entity_slug",
    "ent"."name" AS "entity_name",
    "gl"."title",
    "gl"."description",
    "gl"."record_type",
    "gl"."record_no",
    "gl"."created_by",
    "gl"."created_at",
    "gl"."approved_by",
    "gl"."locked",
    "gl"."version",
    "gl"."provisional",
    "gl"."provenance",
    "gl"."needs_summary",
    "gl"."summarized",
    "gl"."approved",
    "gl"."archived",
    "gl"."ai_status",
    "gl"."compliance_status"
   FROM ("public"."governance_ledger" "gl"
     LEFT JOIN "public"."entities" "ent" ON (("ent"."id" = "gl"."entity_id")));


ALTER VIEW "ci"."alchemy_ledger" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."resolutions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "section_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "whereas_json" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "resolve_json" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "drafted_by" "uuid",
    "version_int" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "entity_id" "uuid",
    "minute_book_id" "uuid",
    "body" "text",
    "prior_hash" "text",
    "hash" "text",
    "approved_at" timestamp with time zone,
    "body_json" "jsonb" DEFAULT '{}'::"jsonb",
    "created_by" "uuid",
    "iso_clause_id" "uuid",
    "compliance_status" "text" DEFAULT 'pending'::"text",
    "test_tag" "text" DEFAULT 'sandbox'::"text",
    "signature_envelope_id" "uuid",
    CONSTRAINT "resolutions_compliance_status_check" CHECK (("compliance_status" = ANY (ARRAY['pending'::"text", 'compliant'::"text", 'review_required'::"text", 'at_risk'::"text", 'reviewed'::"text", 'escalated'::"text", 'resolved'::"text"])))
);


ALTER TABLE "public"."resolutions" OWNER TO "postgres";


CREATE OR REPLACE VIEW "ci"."alchemy_resolutions" AS
 SELECT "r"."id",
    "r"."entity_id",
    "ent"."slug" AS "entity_slug",
    "ent"."name" AS "entity_name",
    "r"."section_id",
    "r"."title",
    "r"."whereas_json",
    "r"."resolve_json",
    "r"."status",
    "r"."drafted_by",
    "r"."version_int",
    "r"."created_at",
    "r"."updated_at",
    "r"."body",
    "r"."body_json",
    "r"."iso_clause_id",
    "r"."compliance_status",
    "r"."signature_envelope_id"
   FROM ("public"."resolutions" "r"
     LEFT JOIN "public"."entities" "ent" ON (("ent"."id" = "r"."entity_id")));


ALTER VIEW "ci"."alchemy_resolutions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."governance_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "record_id" "uuid" NOT NULL,
    "envelope_id" "uuid",
    "storage_path" "text" NOT NULL,
    "file_name" "text" NOT NULL,
    "doc_type" "text" DEFAULT 'pdf'::"text",
    "mime_type" "text" DEFAULT 'application/pdf'::"text",
    "file_hash" "text",
    "file_size" bigint,
    "uploaded_by" "uuid" DEFAULT "auth"."uid"(),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "ocr_text" "text",
    "thumbnail_path" "text",
    "version" integer DEFAULT 1,
    "supersedes" "uuid",
    "expires_at" timestamp with time zone,
    "retention_policy" "text",
    "has_ocr" boolean DEFAULT false,
    "ocr_lang" "text",
    "ocr_tsv" "tsvector",
    "retention_policy_id" "uuid",
    "status" "public"."governance_status" DEFAULT 'draft'::"public"."governance_status" NOT NULL,
    "council_approved_at" timestamp with time zone,
    "council_approved_by" "uuid",
    "ready_for_signature_at" timestamp with time zone,
    "executed_at" timestamp with time zone,
    CONSTRAINT "governance_documents_doc_type_check" CHECK (("doc_type" = ANY (ARRAY['pdf'::"text", 'certificate'::"text", 'attachment'::"text"])))
);


ALTER TABLE "public"."governance_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."supporting_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entry_id" "uuid" NOT NULL,
    "entity_key" "public"."entity_key_enum" NOT NULL,
    "section" "public"."doc_section_enum" NOT NULL,
    "file_path" "text" NOT NULL,
    "file_name" "text" NOT NULL,
    "doc_type" "text",
    "version" integer DEFAULT 1 NOT NULL,
    "uploaded_by" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "uploaded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "owner_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "file_hash" "text",
    "mime_type" "text",
    "file_size" bigint,
    "signature_envelope_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "ocr_text" "text",
    "thumbnail_path" "text",
    "supersedes" "uuid",
    "expires_at" timestamp with time zone,
    "retention_policy" "text",
    "has_ocr" boolean DEFAULT false,
    "retention_policy_id" "uuid",
    "verified" boolean DEFAULT false,
    "registry_visible" boolean DEFAULT true
);


ALTER TABLE "public"."supporting_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "ci"."archive_documents" AS
 SELECT 'governance'::"text" AS "source",
    "d"."id" AS "document_id",
    "d"."record_id",
    "d"."envelope_id",
    "d"."storage_path",
    "d"."file_name",
    "d"."doc_type",
    "d"."mime_type",
    "d"."file_size",
    "d"."version",
    "d"."has_ocr",
    "d"."ocr_lang",
    "d"."expires_at",
    "d"."retention_policy_id",
    "d"."created_at"
   FROM "public"."governance_documents" "d"
UNION ALL
 SELECT 'supporting'::"text" AS "source",
    "s"."id" AS "document_id",
    NULL::"uuid" AS "record_id",
    "s"."signature_envelope_id" AS "envelope_id",
    "s"."file_path" AS "storage_path",
    "s"."file_name",
    "s"."doc_type",
    "s"."mime_type",
    "s"."file_size",
    "s"."version",
    "s"."has_ocr",
    NULL::"text" AS "ocr_lang",
    "s"."expires_at",
    "s"."retention_policy_id",
    "s"."uploaded_at" AS "created_at"
   FROM "public"."supporting_documents" "s";


ALTER VIEW "ci"."archive_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "ci"."forge_documents" AS
 SELECT "id",
    "record_id",
    "envelope_id",
    "storage_path",
    "file_name",
    "doc_type",
    "mime_type",
    "file_hash",
    "file_size",
    "version",
    "created_at",
    "metadata"
   FROM "public"."governance_documents" "d"
  WHERE ("envelope_id" IS NOT NULL);


ALTER VIEW "ci"."forge_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."signature_envelopes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "record_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_by" "uuid" DEFAULT "gen_random_uuid"(),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "external_reference" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "signing_mode" "text" DEFAULT 'sequential'::"text",
    "supporting_document_path" "text",
    "supporting_document_url" "text",
    CONSTRAINT "signature_envelopes_signing_mode_check" CHECK (("signing_mode" = ANY (ARRAY['sequential'::"text", 'parallel'::"text"]))),
    CONSTRAINT "signature_envelopes_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'pending'::"text", 'completed'::"text", 'cancelled'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."signature_envelopes" OWNER TO "postgres";


CREATE OR REPLACE VIEW "ci"."forge_envelopes" AS
 SELECT "e"."id",
    "e"."entity_id",
    "ent"."slug" AS "entity_slug",
    "ent"."name" AS "entity_name",
    "e"."record_id",
    "gl"."title" AS "record_title",
    "gl"."record_type",
    "e"."title" AS "envelope_title",
    "e"."status",
    "e"."created_by",
    "e"."created_at",
    "e"."expires_at",
    "e"."completed_at",
    "e"."signing_mode",
    "e"."supporting_document_path",
    "e"."supporting_document_url",
    "e"."metadata"
   FROM (("public"."signature_envelopes" "e"
     LEFT JOIN "public"."entities" "ent" ON (("ent"."id" = "e"."entity_id")))
     LEFT JOIN "public"."governance_ledger" "gl" ON (("gl"."id" = "e"."record_id")));


ALTER VIEW "ci"."forge_envelopes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."signature_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "envelope_id" "uuid" NOT NULL,
    "party_id" "uuid",
    "event_type" "text" NOT NULL,
    "event_time" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ip_address" "text",
    "user_agent" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    CONSTRAINT "signature_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['created'::"text", 'sent'::"text", 'viewed'::"text", 'signed'::"text", 'declined'::"text", 'reminded'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."signature_events" OWNER TO "postgres";


CREATE OR REPLACE VIEW "ci"."forge_events" AS
 SELECT "id",
    "envelope_id",
    "party_id",
    "event_type",
    "event_time",
    "ip_address",
    "user_agent",
    "metadata"
   FROM "public"."signature_events" "ev";


ALTER VIEW "ci"."forge_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."signatories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "role" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "owner_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "entity_id" "uuid",
    "email" "text"
);


ALTER TABLE "public"."signatories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."signature_parties" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "envelope_id" "uuid",
    "signatory_id" "uuid",
    "email" "text",
    "display_name" "text",
    "role" "text",
    "signing_order" integer,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "signed_at" timestamp with time zone,
    "auth_method" "text",
    "auth_context" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "signature_parties_signed_status_consistency_chk" CHECK (((("status" = 'signed'::"text") AND ("signed_at" IS NOT NULL)) OR (("status" <> 'signed'::"text") AND ("signed_at" IS NULL)))),
    CONSTRAINT "signature_parties_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'viewed'::"text", 'signed'::"text", 'declined'::"text", 'bounced'::"text"])))
);


ALTER TABLE "public"."signature_parties" OWNER TO "postgres";


CREATE OR REPLACE VIEW "ci"."forge_parties" AS
 SELECT "p"."id",
    "p"."envelope_id",
    "p"."signatory_id",
    "s"."name" AS "signatory_name",
    "s"."email" AS "signatory_email",
    "s"."role" AS "signatory_role",
    "p"."email" AS "party_email",
    "p"."display_name",
    "p"."role" AS "party_role",
    "p"."signing_order",
    "p"."status",
    "p"."signed_at",
    "p"."auth_method",
    "p"."auth_context",
    "p"."created_at"
   FROM ("public"."signature_parties" "p"
     LEFT JOIN "public"."signatories" "s" ON (("s"."id" = "p"."signatory_id")));


ALTER VIEW "ci"."forge_parties" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."minute_book_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_key" "public"."entity_key_enum" NOT NULL,
    "entry_date" "date" NOT NULL,
    "entry_type" "public"."entry_type_enum" NOT NULL,
    "title" "text" NOT NULL,
    "notes" "text",
    "owner_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "file_name" "text",
    "section_name" "text",
    "storage_path" "text",
    "registry_status" "text" DEFAULT 'active'::"text",
    "instrument_date" "date" DEFAULT CURRENT_DATE,
    "source" "text" DEFAULT 'manual_upload'::"text",
    "source_record_id" "uuid",
    "source_envelope_id" "uuid",
    "pdf_hash" "text",
    CONSTRAINT "minute_book_entries_registry_status_check" CHECK (("registry_status" = ANY (ARRAY['active'::"text", 'superseded'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."minute_book_entries" OWNER TO "postgres";


CREATE OR REPLACE VIEW "ci"."minute_entries" AS
 SELECT "id",
    "entity_key",
    "entry_date",
    "entry_type",
    "title",
    "notes",
    "owner_id",
    "created_at",
    "updated_at",
    "file_name",
    "section_name",
    "storage_path"
   FROM "public"."minute_book_entries" "e";


ALTER VIEW "ci"."minute_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_advice" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "record_id" "uuid",
    "recommendation" "text" NOT NULL,
    "risk_rating" numeric,
    "confidence" numeric,
    "ai_source" "text" DEFAULT 'cloud'::"text",
    "model_id" "text",
    "model_hash" "text",
    "generated_at" timestamp with time zone DEFAULT "now"(),
    "advice" "text",
    "corrective_action_id" "uuid",
    "model" "text"
);


ALTER TABLE "public"."ai_advice" OWNER TO "postgres";


CREATE OR REPLACE VIEW "ci"."oracle_advice" AS
 SELECT "adv"."id",
    "adv"."record_id",
    "gl"."entity_id",
    "ent"."slug" AS "entity_slug",
    "ent"."name" AS "entity_name",
    "gl"."title" AS "record_title",
    "adv"."recommendation",
    "adv"."risk_rating",
    "adv"."confidence",
    "adv"."advice",
    "adv"."corrective_action_id",
    "adv"."ai_source",
    "adv"."model",
    "adv"."model_id",
    "adv"."model_hash",
    "adv"."generated_at"
   FROM (("public"."ai_advice" "adv"
     LEFT JOIN "public"."governance_ledger" "gl" ON (("gl"."id" = "adv"."record_id")))
     LEFT JOIN "public"."entities" "ent" ON (("ent"."id" = "gl"."entity_id")));


ALTER VIEW "ci"."oracle_advice" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_analyses" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "record_id" "uuid",
    "analysis" "text",
    "ai_source" "text",
    "model_id" "text",
    "model_hash" "text",
    "generated_at" timestamp with time zone DEFAULT "now"(),
    "confidence" numeric,
    "model" "text",
    "raw_response" "jsonb"
);


ALTER TABLE "public"."ai_analyses" OWNER TO "postgres";


CREATE OR REPLACE VIEW "ci"."oracle_analyses" AS
 SELECT "a"."id",
    "a"."record_id",
    "gl"."entity_id",
    "ent"."slug" AS "entity_slug",
    "ent"."name" AS "entity_name",
    "gl"."title" AS "record_title",
    "a"."analysis",
    "a"."ai_source",
    "a"."model",
    "a"."model_id",
    "a"."model_hash",
    "a"."generated_at",
    "a"."confidence"
   FROM (("public"."ai_analyses" "a"
     LEFT JOIN "public"."governance_ledger" "gl" ON (("gl"."id" = "a"."record_id")))
     LEFT JOIN "public"."entities" "ent" ON (("ent"."id" = "gl"."entity_id")));


ALTER VIEW "ci"."oracle_analyses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_summaries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "record_id" "uuid",
    "summary" "text",
    "ai_source" "text",
    "model_id" "text",
    "model_hash" "text",
    "generated_at" timestamp with time zone DEFAULT "now"(),
    "upgraded_at" timestamp with time zone,
    "confidence" numeric,
    "source_table" "text",
    "model" "text",
    "raw_response" "jsonb",
    CONSTRAINT "ai_summaries_ai_source_check" CHECK (("ai_source" = ANY (ARRAY['offline_local'::"text", 'edge'::"text", 'cloud'::"text"])))
);


ALTER TABLE "public"."ai_summaries" OWNER TO "postgres";


CREATE OR REPLACE VIEW "ci"."oracle_summaries" AS
 SELECT "s"."id",
    "s"."record_id",
    "gl"."entity_id",
    "ent"."slug" AS "entity_slug",
    "ent"."name" AS "entity_name",
    "gl"."title" AS "record_title",
    "s"."summary",
    "s"."ai_source",
    "s"."model",
    "s"."model_id",
    "s"."model_hash",
    "s"."generated_at",
    "s"."confidence",
    "s"."source_table"
   FROM (("public"."ai_summaries" "s"
     LEFT JOIN "public"."governance_ledger" "gl" ON (("gl"."id" = "s"."record_id")))
     LEFT JOIN "public"."entities" "ent" ON (("ent"."id" = "gl"."entity_id")));


ALTER VIEW "ci"."oracle_summaries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."compliance_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "resolution_id" "uuid",
    "old_status" "text",
    "new_status" "text",
    "changed_at" timestamp with time zone DEFAULT "now"(),
    "reviewer" "text" DEFAULT CURRENT_USER,
    "context" "jsonb",
    "actor_type" "text",
    CONSTRAINT "chk_audit_actor_type" CHECK (("actor_type" = ANY (ARRAY['human'::"text", 'ai'::"text", 'system'::"text"])))
);


ALTER TABLE "public"."compliance_audit_log" OWNER TO "postgres";


CREATE OR REPLACE VIEW "ci"."sentinel_audit_log" AS
 SELECT "l"."id",
    "l"."resolution_id",
    "r"."entity_id",
    "ent"."slug" AS "entity_slug",
    "ent"."name" AS "entity_name",
    "r"."title" AS "resolution_title",
    "l"."old_status",
    "l"."new_status",
    "l"."changed_at",
    "l"."reviewer",
    "l"."actor_type",
    "l"."context"
   FROM (("public"."compliance_audit_log" "l"
     LEFT JOIN "public"."resolutions" "r" ON (("r"."id" = "l"."resolution_id")))
     LEFT JOIN "public"."entities" "ent" ON (("ent"."id" = "r"."entity_id")));


ALTER VIEW "ci"."sentinel_audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."compliance_obligations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid",
    "iso_clause_id" "uuid",
    "description" "text",
    "control_owner" "text",
    "review_frequency" interval,
    "next_review_date" "date",
    "status" "text",
    "requirement_id" "uuid",
    CONSTRAINT "compliance_obligations_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'in_progress'::"text", 'compliant'::"text", 'at_risk'::"text"])))
);


ALTER TABLE "public"."compliance_obligations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."iso_clauses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "standard" "text" NOT NULL,
    "clause" "text" NOT NULL,
    "title" "text",
    "summary" "text"
);


ALTER TABLE "public"."iso_clauses" OWNER TO "postgres";


CREATE OR REPLACE VIEW "ci"."sentinel_obligations" AS
 SELECT "o"."id",
    "o"."entity_id",
    "ent"."slug" AS "entity_slug",
    "ent"."name" AS "entity_name",
    "o"."iso_clause_id",
    "iso"."standard",
    "iso"."clause",
    "iso"."title" AS "iso_title",
    "o"."description",
    "o"."control_owner",
    "o"."review_frequency",
    "o"."next_review_date",
    "o"."status",
    "o"."requirement_id"
   FROM (("public"."compliance_obligations" "o"
     LEFT JOIN "public"."entities" "ent" ON (("ent"."id" = "o"."entity_id")))
     LEFT JOIN "public"."iso_clauses" "iso" ON (("iso"."id" = "o"."iso_clause_id")));


ALTER VIEW "ci"."sentinel_obligations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."compliance_reviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "obligation_id" "uuid",
    "review_date" timestamp with time zone DEFAULT "now"(),
    "compliant" boolean,
    "risk_level" "text",
    "ai_summary" "jsonb",
    "resolution_id" "uuid",
    "review_day" "date" GENERATED ALWAYS AS ((("review_date" AT TIME ZONE 'UTC'::"text"))::"date") STORED,
    "issues" "jsonb" DEFAULT '[]'::"jsonb",
    "actions" "jsonb" DEFAULT '[]'::"jsonb",
    "notes" "text",
    "overall_status" "text" DEFAULT 'pending'::"text",
    "checked_at" timestamp with time zone DEFAULT "now"(),
    "ai_source" "text" DEFAULT 'cloud'::"text",
    "model_id" "text",
    "model" "text",
    "model_hash" "text",
    "confidence" numeric,
    "raw_response" "jsonb",
    "record_id" "uuid",
    "source_table" "text",
    "summary" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "rule_set_id" "uuid",
    "ai_policy_version_id" "uuid",
    CONSTRAINT "chk_reviews_risk" CHECK (("risk_level" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text"])))
);


ALTER TABLE "public"."compliance_reviews" OWNER TO "postgres";


CREATE OR REPLACE VIEW "ci"."sentinel_reviews" AS
 SELECT "r"."id",
    "r"."obligation_id",
    "o"."entity_id",
    "ent"."slug" AS "entity_slug",
    "ent"."name" AS "entity_name",
    "r"."review_date",
    "r"."compliant",
    "r"."risk_level",
    "r"."overall_status",
    "r"."ai_summary",
    "r"."summary",
    "r"."issues",
    "r"."actions",
    "r"."notes",
    "r"."checked_at",
    "r"."ai_source",
    "r"."model",
    "r"."model_id",
    "r"."model_hash",
    "r"."confidence",
    "r"."record_id",
    "r"."source_table"
   FROM (("public"."compliance_reviews" "r"
     LEFT JOIN "public"."compliance_obligations" "o" ON (("o"."id" = "r"."obligation_id")))
     LEFT JOIN "public"."entities" "ent" ON (("ent"."id" = "o"."entity_id")));


ALTER VIEW "ci"."sentinel_reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."governance_violations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "validation_id" "uuid" NOT NULL,
    "entity_id" "uuid",
    "record_id" "uuid",
    "resolution_id" "uuid",
    "obligation_id" "uuid",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "detected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "corrected_at" timestamp with time zone,
    "detected_by" "text" DEFAULT 'system'::"text",
    "details" "jsonb" DEFAULT '{}'::"jsonb",
    "corrective_action_id" "uuid",
    CONSTRAINT "governance_violations_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'in_review'::"text", 'corrected'::"text", 'waived'::"text"])))
);


ALTER TABLE "public"."governance_violations" OWNER TO "postgres";


CREATE OR REPLACE VIEW "ci"."sentinel_violations" AS
 SELECT "v"."id",
    "v"."validation_id",
    "v"."entity_id",
    "ent"."slug" AS "entity_slug",
    "ent"."name" AS "entity_name",
    "v"."record_id",
    "v"."resolution_id",
    "v"."obligation_id",
    "v"."status",
    "v"."detected_at",
    "v"."corrected_at",
    "v"."detected_by",
    "v"."details",
    "v"."corrective_action_id"
   FROM ("public"."governance_violations" "v"
     LEFT JOIN "public"."entities" "ent" ON (("ent"."id" = "v"."entity_id")));


ALTER VIEW "ci"."sentinel_violations" OWNER TO "postgres";


CREATE OR REPLACE VIEW "ci"."supporting_documents" AS
 SELECT "id",
    "entry_id",
    "entity_key",
    "section",
    "file_path",
    "file_name",
    "doc_type",
    "version",
    "uploaded_by",
    "uploaded_at",
    "owner_id",
    "file_hash",
    "mime_type",
    "file_size",
    "signature_envelope_id",
    "metadata",
    "ocr_text",
    "thumbnail_path",
    "supersedes",
    "expires_at",
    "retention_policy",
    "has_ocr",
    "retention_policy_id"
   FROM "public"."supporting_documents" "s";


ALTER VIEW "ci"."supporting_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."actions_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "actor_uid" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "action" "public"."ledger_action" NOT NULL,
    "target_table" "text" NOT NULL,
    "target_id" "uuid",
    "details_json" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."actions_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."advisor_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_slug" "text" NOT NULL,
    "record_title" "text" NOT NULL,
    "amount" numeric,
    "currency" "text" DEFAULT 'CAD'::"text",
    "attachment" "text",
    "policy_version" "text",
    "result_json" "jsonb" NOT NULL,
    "created_by" "uuid" DEFAULT "auth"."uid"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "record_id" "uuid"
);


ALTER TABLE "public"."advisor_audit" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "entity_slug" "text" NOT NULL,
    "type" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "processed_at" timestamp with time zone,
    "result" "jsonb",
    CONSTRAINT "ai_actions_type_check" CHECK (("type" = ANY (ARRAY['DRAFT_RESOLUTION'::"text", 'START_SIGNATURE'::"text", 'REQUEST_COMPLIANCE_SUMMARY'::"text", 'REPLAY_DECISION'::"text", 'FLAG_HIGH_RISK_ACTION'::"text"])))
);


ALTER TABLE "public"."ai_actions" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ai_advisor_overview" AS
 SELECT "e"."name" AS "entity",
    "l"."id" AS "record_id",
    "l"."title",
    "s"."summary",
    "a"."analysis",
    "adv"."recommendation",
    "adv"."risk_rating",
    "adv"."confidence",
    "adv"."model_id",
    "adv"."generated_at"
   FROM (((("public"."governance_ledger" "l"
     JOIN "public"."entities" "e" ON (("e"."id" = "l"."entity_id")))
     LEFT JOIN "public"."ai_summaries" "s" ON (("s"."record_id" = "l"."id")))
     LEFT JOIN "public"."ai_analyses" "a" ON (("a"."record_id" = "l"."id")))
     LEFT JOIN "public"."ai_advice" "adv" ON (("adv"."record_id" = "l"."id")))
  ORDER BY "adv"."generated_at" DESC NULLS LAST, "l"."created_at" DESC;


ALTER VIEW "public"."ai_advisor_overview" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_agent_bindings" (
    "entity_slug" "text" NOT NULL,
    "role_id" "text" NOT NULL,
    "is_enabled" boolean DEFAULT false NOT NULL,
    "config_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."ai_agent_bindings" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ai_analysis_overview" AS
 WITH "latest" AS (
         SELECT "a"."id",
            "a"."record_id",
            "a"."analysis",
            "a"."ai_source",
            "a"."model_id",
            "a"."model_hash",
            "a"."generated_at",
            "a"."confidence",
            "a"."model",
            "a"."raw_response",
            "row_number"() OVER (PARTITION BY "a"."record_id" ORDER BY "a"."generated_at" DESC) AS "rn"
           FROM "public"."ai_analyses" "a"
        )
 SELECT "gl"."id" AS "record_id",
    "gl"."title",
    "gl"."description",
    "latest"."analysis",
    "latest"."confidence",
    "latest"."model_id",
    "latest"."generated_at"
   FROM ("latest"
     JOIN "public"."governance_ledger" "gl" ON (("gl"."id" = "latest"."record_id")))
  WHERE ("latest"."rn" = 1);


ALTER VIEW "public"."ai_analysis_overview" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_entity_roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid",
    "role_id" "text",
    "is_enabled" boolean DEFAULT false,
    "config_json" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "ai_agent_id" "text",
    "api_key" "text",
    "model" "text",
    "temperature" numeric(3,2) DEFAULT 0.2,
    "webhook_url" "text",
    "limits_json" "jsonb" DEFAULT '{}'::"jsonb",
    "capabilities" "jsonb" DEFAULT '[]'::"jsonb"
);


ALTER TABLE "public"."ai_entity_roles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_feature_flags" (
    "entity_slug" "text" NOT NULL,
    "ai_enabled" boolean DEFAULT false NOT NULL,
    "auto_summarize" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."ai_feature_flags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scope_type" "public"."note_scope_type" NOT NULL,
    "scope_id" "uuid" NOT NULL,
    "note_type" "text" DEFAULT 'note'::"public"."note_type" NOT NULL,
    "title" "text",
    "content" "text" NOT NULL,
    "model" "text",
    "tokens_used" integer DEFAULT 0,
    "source_doc_ids" "uuid"[] DEFAULT '{}'::"uuid"[],
    "created_by" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_note_type" CHECK (("note_type" = ANY (ARRAY['note'::"text", 'summary'::"text", 'memo'::"text"])))
);


ALTER TABLE "public"."ai_notes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_policy_versions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "engine_name" "text" NOT NULL,
    "policy_code" "text" NOT NULL,
    "version" "text" NOT NULL,
    "model" "text",
    "temperature" numeric(3,2),
    "max_tokens" integer,
    "description" "text",
    "prompt_profile" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "guardrails_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "effective_from" timestamp with time zone,
    "effective_to" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_policy_versions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_roles" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "description" "text",
    "slug" "text",
    "name" "text",
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."ai_roles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_roles_backup" (
    "id" "text",
    "description" "text"
);


ALTER TABLE "public"."ai_roles_backup" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ai_sentinel_overview" AS
 SELECT "gl"."id" AS "record_id",
    "gl"."title",
    (COALESCE("a"."sum_count", (0)::bigint) > 0) AS "has_summary",
    (COALESCE("b"."ana_count", (0)::bigint) > 0) AS "has_analysis",
    (COALESCE("c"."adv_count", (0)::bigint) > 0) AS "has_advice",
    GREATEST("max"("a"."generated_at"), "max"("b"."generated_at"), "max"("c"."generated_at")) AS "last_update"
   FROM ((("public"."governance_ledger" "gl"
     LEFT JOIN ( SELECT "ai_summaries"."record_id",
            "count"(*) AS "sum_count",
            "max"("ai_summaries"."generated_at") AS "generated_at"
           FROM "public"."ai_summaries"
          GROUP BY "ai_summaries"."record_id") "a" ON (("a"."record_id" = "gl"."id")))
     LEFT JOIN ( SELECT "ai_analyses"."record_id",
            "count"(*) AS "ana_count",
            "max"("ai_analyses"."generated_at") AS "generated_at"
           FROM "public"."ai_analyses"
          GROUP BY "ai_analyses"."record_id") "b" ON (("b"."record_id" = "gl"."id")))
     LEFT JOIN ( SELECT "ai_advice"."record_id",
            "count"(*) AS "adv_count",
            "max"("ai_advice"."generated_at") AS "generated_at"
           FROM "public"."ai_advice"
          GROUP BY "ai_advice"."record_id") "c" ON (("c"."record_id" = "gl"."id")))
  GROUP BY "gl"."id", "gl"."title", "a"."sum_count", "b"."ana_count", "c"."adv_count";


ALTER VIEW "public"."ai_sentinel_overview" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_sentinel_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "mode" "text" DEFAULT 'execute'::"text" NOT NULL,
    "scan_limit" integer,
    "dry_run" boolean DEFAULT false NOT NULL,
    "scanned" integer DEFAULT 0 NOT NULL,
    "processed" integer DEFAULT 0 NOT NULL,
    "errors_count" integer DEFAULT 0 NOT NULL,
    "result_json" "jsonb",
    "triggered_by" "text",
    "notes" "text"
);


ALTER TABLE "public"."ai_sentinel_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_sentinel_tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "record_id" "uuid" NOT NULL,
    "missing_summary" boolean DEFAULT false NOT NULL,
    "missing_analysis" boolean DEFAULT false NOT NULL,
    "missing_advice" boolean DEFAULT false NOT NULL,
    "summary_ran" boolean DEFAULT false NOT NULL,
    "analysis_ran" boolean DEFAULT false NOT NULL,
    "advice_ran" boolean DEFAULT false NOT NULL,
    "summary_error" "text",
    "analysis_error" "text",
    "advice_error" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_sentinel_tasks" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ai_sentinel_record_status" AS
 SELECT "gl"."id" AS "record_id",
    "gl"."title",
    "gl"."created_at" AS "record_created_at",
    "t"."status",
    "t"."missing_summary",
    "t"."missing_analysis",
    "t"."missing_advice",
    "t"."summary_ran",
    "t"."analysis_ran",
    "t"."advice_ran",
    "r"."started_at" AS "last_run_started_at",
    "r"."finished_at" AS "last_run_finished_at",
    "r"."mode" AS "last_run_mode",
    "r"."dry_run" AS "last_run_dry_run",
    "r"."scanned" AS "last_run_scanned",
    "r"."processed" AS "last_run_processed",
    "r"."errors_count" AS "last_run_errors"
   FROM (("public"."governance_ledger" "gl"
     LEFT JOIN LATERAL ( SELECT "t2"."id",
            "t2"."run_id",
            "t2"."record_id",
            "t2"."missing_summary",
            "t2"."missing_analysis",
            "t2"."missing_advice",
            "t2"."summary_ran",
            "t2"."analysis_ran",
            "t2"."advice_ran",
            "t2"."summary_error",
            "t2"."analysis_error",
            "t2"."advice_error",
            "t2"."status",
            "t2"."created_at",
            "r2"."id",
            "r2"."started_at",
            "r2"."finished_at",
            "r2"."mode",
            "r2"."scan_limit",
            "r2"."dry_run",
            "r2"."scanned",
            "r2"."processed",
            "r2"."errors_count",
            "r2"."result_json",
            "r2"."triggered_by",
            "r2"."notes"
           FROM ("public"."ai_sentinel_tasks" "t2"
             JOIN "public"."ai_sentinel_runs" "r2" ON (("r2"."id" = "t2"."run_id")))
          WHERE ("t2"."record_id" = "gl"."id")
          ORDER BY "r2"."started_at" DESC
         LIMIT 1) "t"("id", "run_id", "record_id", "missing_summary", "missing_analysis", "missing_advice", "summary_ran", "analysis_ran", "advice_ran", "summary_error", "analysis_error", "advice_error", "status", "created_at", "id_1", "started_at", "finished_at", "mode", "scan_limit", "dry_run", "scanned", "processed", "errors_count", "result_json", "triggered_by", "notes") ON (true))
     LEFT JOIN "public"."ai_sentinel_runs" "r" ON (("r"."id" = "t"."run_id")));


ALTER VIEW "public"."ai_sentinel_record_status" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_status_debug" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "advice_id" "uuid",
    "record_id" "uuid",
    "rows_updated" integer,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "event" "text",
    "old_status" "text",
    "new_status" "text",
    "details" "text"
);


ALTER TABLE "public"."ai_status_debug" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ai_summary_overview" AS
 SELECT "e"."name" AS "entity",
    "l"."title",
    "s"."summary",
    "s"."model_id",
    "s"."ai_source",
    "s"."confidence",
    "s"."generated_at"
   FROM (("public"."governance_ledger" "l"
     JOIN "public"."entities" "e" ON (("e"."id" = "l"."entity_id")))
     JOIN "public"."ai_summaries" "s" ON (("s"."record_id" = "l"."id")))
  ORDER BY "s"."generated_at" DESC;


ALTER VIEW "public"."ai_summary_overview" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_logs" (
    "id" bigint NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "actor" "uuid" NOT NULL,
    "table_name" "text" NOT NULL,
    "row_pk" "text" NOT NULL,
    "action" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "prev_hash" "text",
    "hash" "text" NOT NULL,
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "audit_logs_action_check" CHECK (("action" = ANY (ARRAY['insert'::"text", 'update'::"text", 'delete'::"text", 'adopt'::"text", 'custom'::"text"])))
);


ALTER TABLE "public"."audit_logs" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."audit_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."audit_logs_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."audit_logs_id_seq" OWNED BY "public"."audit_logs"."id";



CREATE TABLE IF NOT EXISTS "public"."audit_trail" (
    "id" bigint NOT NULL,
    "actor" "uuid",
    "action" "text",
    "ref_table" "text",
    "ref_id" "uuid",
    "at" timestamp with time zone DEFAULT "now"(),
    "old_hash" "text",
    "new_hash" "text"
);


ALTER TABLE "public"."audit_trail" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."audit_trail_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."audit_trail_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."audit_trail_id_seq" OWNED BY "public"."audit_trail"."id";



CREATE TABLE IF NOT EXISTS "public"."books" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "book_name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."books" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."certificate_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "envelope_id" "uuid" NOT NULL,
    "record_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone
);


ALTER TABLE "public"."certificate_jobs" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ci_archive_documents" AS
 SELECT "id",
    "record_id",
    "envelope_id",
    "storage_path",
    "file_name",
    "doc_type",
    "mime_type",
    "file_hash",
    "file_size",
    "uploaded_by",
    "created_at",
    "metadata",
    "ocr_text",
    "thumbnail_path",
    "version",
    "supersedes",
    "expires_at",
    "retention_policy",
    "has_ocr",
    "ocr_lang",
    "ocr_tsv",
    "retention_policy_id"
   FROM "public"."governance_documents" "d";


ALTER VIEW "public"."ci_archive_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ci_archive_supporting_docs" AS
 SELECT "id",
    "entry_id",
    "entity_key",
    "section",
    "file_path",
    "file_name",
    "doc_type",
    "version",
    "uploaded_by",
    "uploaded_at",
    "owner_id",
    "file_hash",
    "mime_type",
    "file_size",
    "signature_envelope_id",
    "metadata",
    "ocr_text",
    "thumbnail_path",
    "supersedes",
    "expires_at",
    "retention_policy",
    "has_ocr",
    "retention_policy_id"
   FROM "public"."supporting_documents" "sd";


ALTER VIEW "public"."ci_archive_supporting_docs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_edge_functions" (
    "supabase_name" "text" NOT NULL,
    "module_key" "text" NOT NULL,
    "ci_api_name" "text" NOT NULL,
    "description" "text",
    "is_public" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ci_edge_functions" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ci_forge_envelopes" AS
 SELECT "id",
    "entity_id",
    "record_id",
    "title",
    "status",
    "created_by",
    "created_at",
    "expires_at",
    "completed_at",
    "external_reference",
    "metadata",
    "signing_mode",
    "supporting_document_path",
    "supporting_document_url"
   FROM "public"."signature_envelopes" "e";


ALTER VIEW "public"."ci_forge_envelopes" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ci_forge_events" AS
 SELECT "id",
    "envelope_id",
    "party_id",
    "event_type",
    "event_time",
    "ip_address",
    "user_agent",
    "metadata"
   FROM "public"."signature_events" "ev";


ALTER VIEW "public"."ci_forge_events" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ci_forge_parties" AS
 SELECT "id",
    "envelope_id",
    "signatory_id",
    "email",
    "display_name",
    "role",
    "signing_order",
    "status",
    "signed_at",
    "auth_method",
    "auth_context",
    "created_at"
   FROM "public"."signature_parties" "p";


ALTER VIEW "public"."ci_forge_parties" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_genesis_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "storage_path" "text" NOT NULL,
    "file_name" "text" NOT NULL,
    "doc_type" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "uploaded_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ci_genesis_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_genesis_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "full_name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" NOT NULL,
    "is_primary" boolean DEFAULT false NOT NULL,
    "signing_order" integer,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ci_genesis_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_genesis_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_by" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "entity_name" "text" NOT NULL,
    "entity_slug" "text" GENERATED ALWAYS AS ("regexp_replace"("lower"("entity_name"), '[^a-z0-9]+'::"text", '-'::"text", 'g'::"text")) STORED,
    "jurisdiction" "text",
    "primary_email" "text" NOT NULL,
    "actor_role" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    CONSTRAINT "ci_genesis_sessions_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'completed'::"text", 'abandoned'::"text"])))
);


ALTER TABLE "public"."ci_genesis_sessions" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ci_ledger_records" AS
 SELECT "id",
    "entity_id",
    "title",
    "description",
    "record_type",
    "record_no",
    "created_by",
    "created_at",
    "approved_by",
    "locked",
    "linked_financial_event_id",
    "ai_summary_id",
    "attachments",
    "version",
    "provisional",
    "provenance",
    "needs_summary",
    "summarized",
    "approved",
    "archived",
    "ai_status",
    "compliance_status"
   FROM "public"."governance_ledger" "gl";


ALTER VIEW "public"."ci_ledger_records" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_modules_registry" (
    "key" "text" NOT NULL,
    "label" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ci_modules_registry" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ci_oracle_advice" AS
 SELECT "id",
    "record_id",
    "recommendation",
    "risk_rating",
    "confidence",
    "ai_source",
    "model_id",
    "model_hash",
    "generated_at",
    "advice",
    "corrective_action_id",
    "model"
   FROM "public"."ai_advice" "ad";


ALTER VIEW "public"."ci_oracle_advice" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ci_oracle_analyses" AS
 SELECT "id",
    "record_id",
    "analysis",
    "ai_source",
    "model_id",
    "model_hash",
    "generated_at",
    "confidence",
    "model",
    "raw_response"
   FROM "public"."ai_analyses" "a";


ALTER VIEW "public"."ci_oracle_analyses" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ci_oracle_summaries" AS
 SELECT "id",
    "record_id",
    "summary",
    "ai_source",
    "model_id",
    "model_hash",
    "generated_at",
    "upgraded_at",
    "confidence",
    "source_table",
    "model",
    "raw_response"
   FROM "public"."ai_summaries" "s";


ALTER VIEW "public"."ci_oracle_summaries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_orb_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "text" NOT NULL,
    "entity_slug" "text",
    "event_type" "text" NOT NULL,
    "severity" "public"."ci_orb_severity" DEFAULT 'info'::"public"."ci_orb_severity" NOT NULL,
    "mode_target" "public"."ci_orb_mode" NOT NULL,
    "headline" "text",
    "ttl_ms" integer DEFAULT 8000 NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "ci_orb_events_ttl_ms_check" CHECK ((("ttl_ms" > 0) AND ("ttl_ms" <= 600000)))
);


ALTER TABLE "public"."ci_orb_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_orb_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "source" "text" NOT NULL,
    "message" "text" NOT NULL,
    "mode" "text",
    "meta" "jsonb" DEFAULT '{}'::"jsonb",
    CONSTRAINT "ci_orb_logs_mode_check" CHECK (("mode" = ANY (ARRAY['nur'::"text", 'ruh'::"text", 'alert'::"text"])))
);


ALTER TABLE "public"."ci_orb_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_orb_state" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "mode" "text" DEFAULT 'nur'::"text" NOT NULL,
    "source" "text" DEFAULT 'system'::"text",
    "activity" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ci_orb_state_mode_check" CHECK (("mode" = ANY (ARRAY['nur'::"text", 'ruh'::"text"])))
);


ALTER TABLE "public"."ci_orb_state" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ci_sentinel_audit_log" AS
 SELECT "id",
    "resolution_id",
    "old_status",
    "new_status",
    "changed_at",
    "reviewer",
    "context",
    "actor_type"
   FROM "public"."compliance_audit_log" "l";


ALTER VIEW "public"."ci_sentinel_audit_log" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ci_sentinel_obligations" AS
 SELECT "id",
    "entity_id",
    "iso_clause_id",
    "description",
    "control_owner",
    "review_frequency",
    "next_review_date",
    "status",
    "requirement_id"
   FROM "public"."compliance_obligations" "o";


ALTER VIEW "public"."ci_sentinel_obligations" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ci_sentinel_reviews" AS
 SELECT "id",
    "obligation_id",
    "review_date",
    "compliant",
    "risk_level",
    "ai_summary",
    "resolution_id",
    "review_day",
    "issues",
    "actions",
    "notes",
    "overall_status",
    "checked_at",
    "ai_source",
    "model_id",
    "model",
    "model_hash",
    "confidence",
    "raw_response",
    "record_id",
    "source_table",
    "summary",
    "created_at",
    "updated_at",
    "approved_by",
    "approved_at"
   FROM "public"."compliance_reviews" "r";


ALTER VIEW "public"."ci_sentinel_reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_suite_modules" (
    "key" "text" NOT NULL,
    "label" "text" NOT NULL,
    "category" "text" NOT NULL,
    "description" "text",
    "edge_functions" "text"[] DEFAULT '{}'::"text"[],
    "core_tables" "text"[] DEFAULT '{}'::"text"[],
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ci_suite_modules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_tables_registry" (
    "module_key" "text" NOT NULL,
    "ci_name" "text" NOT NULL,
    "table_name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."ci_tables_registry" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."compliance_rule_sets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "version" "text" NOT NULL,
    "scope" "text",
    "description" "text",
    "effective_from" timestamp with time zone,
    "effective_to" timestamp with time zone,
    "definition_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."compliance_rule_sets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."constitutional_objects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "object_type" "text" NOT NULL,
    "object_name" "text" NOT NULL,
    "criticality" "text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."constitutional_objects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."corrections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "record_id" "uuid",
    "old_location" "text",
    "new_location" "text",
    "reason" "text",
    "corrected_by" "uuid",
    "date_corrected" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."corrections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."corrective_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "review_id" "uuid",
    "action" "text",
    "owner" "text",
    "due_date" "date",
    "status" "text",
    CONSTRAINT "corrective_actions_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'done'::"text"])))
);


ALTER TABLE "public"."corrective_actions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."doc_section_pillars" (
    "section" "public"."doc_section_enum" NOT NULL,
    "pillar" "public"."doc_pillar_enum" NOT NULL,
    "description" "text"
);


ALTER TABLE "public"."doc_section_pillars" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."document_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "document_id" "uuid" NOT NULL,
    "resolution_id" "uuid",
    "obligation_id" "uuid",
    "link_type" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "linked_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."document_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."document_retention_policies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "policy_key" "text" NOT NULL,
    "description" "text",
    "keep_years" integer,
    "auto_delete" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."document_retention_policies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."entities_backup" (
    "id" "uuid",
    "slug" "text",
    "name" "text",
    "created_at" timestamp with time zone
);


ALTER TABLE "public"."entities_backup" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."entity_companies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "key" "public"."entity_key_enum" NOT NULL,
    "legal_name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."entity_companies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."entity_relationships" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "parent_entity_id" "uuid" NOT NULL,
    "child_entity_id" "uuid" NOT NULL,
    "relationship_type" "text" NOT NULL,
    "ownership_percent" numeric,
    "notes" "text",
    "effective_from" "date",
    "effective_to" "date",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "entity_relationships_relationship_type_check" CHECK (("relationship_type" = ANY (ARRAY['holdco'::"text", 'opco'::"text", 'propco'::"text", 'sister'::"text", 'joint_venture'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."entity_relationships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."entry_signers" (
    "entry_id" "uuid" NOT NULL,
    "signer_id" "uuid" NOT NULL,
    "signed_at" "date",
    "owner_id" "uuid" DEFAULT "auth"."uid"() NOT NULL
);


ALTER TABLE "public"."entry_signers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."entry_type_default_section" (
    "entry_type" "text" NOT NULL,
    "default_section" "public"."doc_section_enum" NOT NULL,
    "notes" "text"
);


ALTER TABLE "public"."entry_type_default_section" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid",
    "description" "text",
    "amount" numeric(12,2),
    "currency" "text" DEFAULT 'CAD'::"text",
    "status" "text" DEFAULT 'pending'::"text",
    "related_record_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "financial_events_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'posted'::"text"])))
);


ALTER TABLE "public"."financial_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."governance_approvals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ledger_id" "uuid" NOT NULL,
    "approver_name" "text",
    "approver_email" "text",
    "approver_role" "text",
    "decision" "text" NOT NULL,
    "comment" "text",
    "decided_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "governance_approvals_decision_check" CHECK (("decision" = ANY (ARRAY['approved'::"text", 'rejected'::"text", 'changes_requested'::"text"])))
);


ALTER TABLE "public"."governance_approvals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."governance_drafts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "entity_slug" "text" NOT NULL,
    "entity_name" "text" NOT NULL,
    "title" "text" NOT NULL,
    "record_type" "text" NOT NULL,
    "draft_text" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "finalized_at" timestamp with time zone,
    "finalized_record_id" "uuid",
    CONSTRAINT "governance_drafts_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'reviewed'::"text", 'finalized'::"text", 'discarded'::"text"])))
);


ALTER TABLE "public"."governance_drafts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."governance_policies" (
    "id" bigint NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "require_council_review" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."governance_policies" OWNER TO "postgres";


ALTER TABLE "public"."governance_policies" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."governance_policies_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."governance_requirements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "standard_id" "uuid" NOT NULL,
    "requirement_code" "text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "applies_to" "text",
    "frequency" "text",
    "trigger_event" "text",
    "severity" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "governance_requirements_severity_check" CHECK (("severity" = ANY (ARRAY['info'::"text", 'warning'::"text", 'error'::"text", 'critical'::"text"])))
);


ALTER TABLE "public"."governance_requirements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."governance_standards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "jurisdiction" "text",
    "source_legal_source_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."governance_standards" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."governance_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_slug" "text",
    "doc_type" "text" NOT NULL,
    "version" "text" DEFAULT 'v1'::"text" NOT NULL,
    "required_fields" "text"[] NOT NULL,
    "schema_json" "jsonb" NOT NULL,
    "legal_refs" "text"[] DEFAULT '{}'::"text"[],
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."governance_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."governance_validations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "target_type" "text" NOT NULL,
    "rule_key" "text" NOT NULL,
    "requirement_id" "uuid",
    "severity" "text" NOT NULL,
    "description" "text",
    "policy_rule_id" "uuid",
    "is_active" boolean DEFAULT true,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "governance_validations_severity_check" CHECK (("severity" = ANY (ARRAY['warning'::"text", 'error'::"text", 'critical'::"text"]))),
    CONSTRAINT "governance_validations_target_type_check" CHECK (("target_type" = ANY (ARRAY['governance_ledger'::"text", 'resolution'::"text", 'minute_book_entry'::"text", 'meeting'::"text", 'obligation'::"text"])))
);


ALTER TABLE "public"."governance_validations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."legal_policy_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "policy_id" "uuid" NOT NULL,
    "legal_source_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."legal_policy_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."legal_record_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "record_id" "uuid" NOT NULL,
    "legal_source_id" "uuid" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."legal_record_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."legal_sources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code_name" "text" NOT NULL,
    "citation" "text" NOT NULL,
    "jurisdiction" "text" NOT NULL,
    "summary" "text" NOT NULL,
    "source_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."legal_sources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meetings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "held_at" timestamp with time zone NOT NULL,
    "quorum" boolean DEFAULT false,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."meetings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."memberships" (
    "user_id" "uuid" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "is_admin" boolean DEFAULT false,
    CONSTRAINT "memberships_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'director'::"text", 'clerk'::"text", 'auditor'::"text"])))
);


ALTER TABLE "public"."memberships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."menu_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_slug" "text" DEFAULT 'lounge'::"text" NOT NULL,
    "name_en" "text" NOT NULL,
    "category" "text" NOT NULL,
    "price_minor" integer NOT NULL,
    "currency" character(3) DEFAULT 'USD'::"bpchar" NOT NULL,
    "description_en" "text",
    "photo_url" "text",
    "status" "text" DEFAULT 'Active'::"text",
    "created_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "menu_items_category_check" CHECK (("category" = ANY (ARRAY['Mezze'::"text", 'Mains'::"text", 'Drinks'::"text", 'Desserts'::"text"]))),
    CONSTRAINT "menu_items_status_check" CHECK (("status" = ANY (ARRAY['Active'::"text", 'Seasonal'::"text", 'Archived'::"text"])))
);


ALTER TABLE "public"."menu_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."menu_publish" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_slug" "text" DEFAULT 'lounge'::"text" NOT NULL,
    "label" "text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."menu_publish" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."menu_publish_items" (
    "publish_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "menu_item_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "category" "text",
    "lang" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "price_minor" integer NOT NULL,
    "currency" character(3) NOT NULL,
    "photo_url" "text",
    "price" numeric(10,2),
    "formatted_price" "text",
    "is_published" boolean DEFAULT true,
    CONSTRAINT "menu_publish_items_lang_check" CHECK (("lang" = ANY (ARRAY['en'::"text", 'es'::"text", 'ar'::"text", 'fr'::"text"])))
);


ALTER TABLE "public"."menu_publish_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."menu_publish_items_backup" (
    "publish_id" "uuid",
    "menu_item_id" "uuid",
    "category" "text",
    "lang" "text",
    "name" "text",
    "description" "text",
    "price_minor" integer,
    "currency" character(3),
    "photo_url" "text",
    "price" numeric(10,2),
    "formatted_price" "text",
    "is_published" boolean
);


ALTER TABLE "public"."menu_publish_items_backup" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."menu_translations" (
    "id" bigint NOT NULL,
    "menu_item_id" "uuid",
    "lang" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    CONSTRAINT "menu_translations_lang_check" CHECK (("lang" = ANY (ARRAY['en'::"text", 'es'::"text", 'ar'::"text", 'fr'::"text"])))
);


ALTER TABLE "public"."menu_translations" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."menu_translations_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."menu_translations_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."menu_translations_id_seq" OWNED BY "public"."menu_translations"."id";



CREATE TABLE IF NOT EXISTS "public"."metadata_sources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ref_code" "text" NOT NULL,
    "title" "text" NOT NULL,
    "jurisdiction" "text",
    "category" "text",
    "source_url" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."metadata_sources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."minute_book_members" (
    "user_id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'member'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "entity_key" "text" NOT NULL
);


ALTER TABLE "public"."minute_book_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."minute_books" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."minute_books" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."obligations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "record_id" "uuid",
    "type" "text",
    "due_date" "date",
    "status" "text" DEFAULT 'open'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."obligations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."people" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "auth_user_id" "uuid" NOT NULL,
    "full_name" "text",
    "email" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."people" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."policy_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "domain" "text",
    "name" "text",
    "version" "text",
    "yaml_json" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "entity_slug" "text"
);


ALTER TABLE "public"."policy_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "user_id" "uuid" NOT NULL,
    "full_name" "text",
    "role" "text" DEFAULT 'guest'::"text",
    "entity_slug" "text" DEFAULT 'lounge'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['guest'::"text", 'staff'::"text", 'manager'::"text", 'director'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reasoning_traces" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "record_id" "uuid",
    "source" "text",
    "steps" "jsonb",
    "confidence" numeric,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."reasoning_traces" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."resolution_status_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "resolution_id" "uuid" NOT NULL,
    "old_status" "text",
    "new_status" "text" NOT NULL,
    "reason" "text",
    "changed_by" "uuid",
    "changed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "context" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."resolution_status_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_slug" "text" NOT NULL,
    "menu_item_id" "uuid",
    "rating" smallint NOT NULL,
    "comment" "text",
    "display_name" "text",
    "source" "text" DEFAULT 'web'::"text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reviews_rating_check" CHECK ((("rating" >= 1) AND ("rating" <= 5))),
    CONSTRAINT "reviews_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'hidden'::"text"])))
);


ALTER TABLE "public"."reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."schema_change_approvals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "schema_change_id" "uuid" NOT NULL,
    "approver_entity_id" "uuid",
    "approver_user_id" "uuid",
    "approver_role" "text",
    "decision" "text" NOT NULL,
    "reason" "text",
    "decided_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."schema_change_approvals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."schema_change_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "change_key" "text" NOT NULL,
    "description" "text" NOT NULL,
    "change_type" "text" NOT NULL,
    "impact_scope" "text" NOT NULL,
    "applied_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "applied_by_entity" "uuid",
    "applied_by_user_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "stage" "text" DEFAULT 'applied'::"text" NOT NULL,
    "proposed_at" timestamp with time zone,
    "approved_at" timestamp with time zone,
    "rejected_at" timestamp with time zone,
    "proposed_by_user_id" "uuid",
    "approved_by_user_id" "uuid",
    "rejected_by_user_id" "uuid",
    "is_constitutional" boolean DEFAULT false,
    "constitutional_object_id" "uuid",
    "breaking_change" boolean DEFAULT false,
    "notes" "text"
);


ALTER TABLE "public"."schema_change_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."signature_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "envelope_id" "uuid" NOT NULL,
    "record_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "event_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actor_email" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."signature_audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."signature_email_queue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "envelope_id" "uuid" NOT NULL,
    "party_id" "uuid" NOT NULL,
    "to_email" "text" NOT NULL,
    "to_name" "text",
    "subject" "text",
    "body" "text",
    "template_key" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "error_message" "text",
    "attempts" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sent_at" timestamp with time zone,
    "document_title" "text",
    CONSTRAINT "signature_email_queue_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."signature_email_queue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."signature_envelope_status_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "envelope_id" "uuid" NOT NULL,
    "old_status" "text",
    "new_status" "text" NOT NULL,
    "reason" "text",
    "changed_by" "uuid",
    "changed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "context" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."signature_envelope_status_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."system_config" (
    "id" boolean DEFAULT true NOT NULL,
    "test_mode" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."system_config" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_ai_agent_config" AS
 SELECT "e"."slug" AS "entity_slug",
    "a"."role_id",
    "a"."is_enabled",
    "a"."capabilities",
    "a"."ai_agent_id",
    "a"."model",
    "a"."temperature",
    "a"."webhook_url",
    "a"."limits_json"
   FROM ("public"."ai_entity_roles" "a"
     JOIN "public"."entities" "e" ON (("e"."id" = "a"."entity_id")));


ALTER VIEW "public"."v_ai_agent_config" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_ai_governance_pipeline" AS
 SELECT "ca"."id" AS "corrective_action_id",
    "ca"."review_id",
    "cr"."obligation_id",
    "co"."entity_id",
    "e"."slug" AS "entity_slug",
    "e"."name" AS "entity_name",
    "ca"."action",
    "ca"."owner",
    "ca"."due_date",
    "ca"."status" AS "corrective_status",
    "gv"."id" AS "violation_id",
    "gv"."status" AS "violation_status",
    "gv"."detected_at",
    "adv"."id" AS "ai_advice_id",
    "adv"."risk_rating",
    "adv"."confidence",
    "adv"."model" AS "ai_model",
    "adv"."generated_at" AS "advice_generated_at",
    "dbg"."event" AS "last_ai_event",
    "dbg"."new_status" AS "last_ai_status",
    "dbg"."created_at" AS "last_ai_event_at"
   FROM (((((("public"."corrective_actions" "ca"
     LEFT JOIN "public"."compliance_reviews" "cr" ON (("cr"."id" = "ca"."review_id")))
     LEFT JOIN "public"."compliance_obligations" "co" ON (("co"."id" = "cr"."obligation_id")))
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "co"."entity_id")))
     LEFT JOIN "public"."governance_violations" "gv" ON (("gv"."corrective_action_id" = "ca"."id")))
     LEFT JOIN "public"."ai_advice" "adv" ON (("adv"."corrective_action_id" = "ca"."id")))
     LEFT JOIN LATERAL ( SELECT "d"."id",
            "d"."advice_id",
            "d"."record_id",
            "d"."rows_updated",
            "d"."created_at",
            "d"."event",
            "d"."old_status",
            "d"."new_status",
            "d"."details"
           FROM "public"."ai_status_debug" "d"
          WHERE ("d"."advice_id" = "adv"."id")
          ORDER BY "d"."created_at" DESC
         LIMIT 1) "dbg" ON (true));


ALTER VIEW "public"."v_ai_governance_pipeline" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_ai_matrix" AS
 SELECT "e"."slug" AS "entity",
    "f"."ai_enabled",
    "f"."auto_summarize",
    "jsonb_object_agg"("b"."role_id", "b"."is_enabled" ORDER BY "b"."role_id") AS "roles_enabled"
   FROM (("public"."entities" "e"
     LEFT JOIN "public"."ai_feature_flags" "f" ON (("f"."entity_slug" = "e"."slug")))
     LEFT JOIN "public"."ai_agent_bindings" "b" ON (("b"."entity_slug" = "e"."slug")))
  GROUP BY "e"."slug", "f"."ai_enabled", "f"."auto_summarize"
  ORDER BY "e"."slug";


ALTER VIEW "public"."v_ai_matrix" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_compliance_obligation_health" AS
 SELECT "o"."id" AS "obligation_id",
    "o"."entity_id",
    "o"."description",
    "o"."status" AS "obligation_status",
    "r"."id" AS "latest_review_id",
    "r"."review_date",
    COALESCE("r"."overall_status", 'no_review'::"text") AS "overall_status",
    COALESCE("r"."compliant", false) AS "compliant",
    COALESCE("r"."risk_level", 'unknown'::"text") AS "risk_level",
    "r"."approved_by",
    "r"."approved_at",
        CASE
            WHEN ((COALESCE("r"."overall_status", ''::"text") = 'compliant'::"text") AND (COALESCE("r"."compliant", false) = true) AND (COALESCE("r"."risk_level", ''::"text") = 'low'::"text")) THEN '🟢 Healthy'::"text"
            WHEN ((COALESCE("r"."overall_status", ''::"text") = ANY (ARRAY['pending'::"text", 'at_risk'::"text"])) OR (COALESCE("r"."risk_level", ''::"text") = 'medium'::"text")) THEN '🟡 Watch'::"text"
            WHEN ((COALESCE("r"."overall_status", ''::"text") = ANY (ARRAY['non_compliant'::"text", 'critical'::"text"])) OR (COALESCE("r"."risk_level", ''::"text") = 'high'::"text")) THEN '🔴 Critical'::"text"
            ELSE '⚪ Unknown'::"text"
        END AS "traffic_light"
   FROM ("public"."compliance_obligations" "o"
     LEFT JOIN LATERAL ( SELECT "cr"."id",
            "cr"."obligation_id",
            "cr"."review_date",
            "cr"."compliant",
            "cr"."risk_level",
            "cr"."ai_summary",
            "cr"."resolution_id",
            "cr"."review_day",
            "cr"."issues",
            "cr"."actions",
            "cr"."notes",
            "cr"."overall_status",
            "cr"."checked_at",
            "cr"."ai_source",
            "cr"."model_id",
            "cr"."model",
            "cr"."model_hash",
            "cr"."confidence",
            "cr"."raw_response",
            "cr"."record_id",
            "cr"."source_table",
            "cr"."summary",
            "cr"."created_at",
            "cr"."updated_at",
            "cr"."approved_by",
            "cr"."approved_at"
           FROM "public"."compliance_reviews" "cr"
          WHERE ("cr"."obligation_id" = "o"."id")
          ORDER BY "cr"."review_date" DESC
         LIMIT 1) "r" ON (true));


ALTER VIEW "public"."v_compliance_obligation_health" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_ai_sentinel_dashboard" AS
 SELECT "e"."id" AS "entity_id",
    "e"."name" AS "entity_name",
    "count"(*) FILTER (WHERE ("h"."traffic_light" = '🟢 Healthy'::"text")) AS "green_count",
    "count"(*) FILTER (WHERE ("h"."traffic_light" = '🟡 Watch'::"text")) AS "yellow_count",
    "count"(*) FILTER (WHERE ("h"."traffic_light" = '🔴 Critical'::"text")) AS "red_count",
    "count"(*) FILTER (WHERE ("h"."traffic_light" = '⚪ Unknown'::"text")) AS "unknown_count",
    "max"("h"."review_date") AS "last_review_at",
        CASE
            WHEN ("count"(*) FILTER (WHERE ("h"."traffic_light" = '🔴 Critical'::"text")) > 0) THEN '🔴 Critical'::"text"
            WHEN ("count"(*) FILTER (WHERE ("h"."traffic_light" = '🟡 Watch'::"text")) > 0) THEN '🟡 Watch'::"text"
            WHEN ("count"(*) FILTER (WHERE ("h"."traffic_light" = '🟢 Healthy'::"text")) = "count"(*)) THEN '🟢 Healthy'::"text"
            ELSE '⚪ Unknown'::"text"
        END AS "entity_traffic_light"
   FROM ("public"."v_compliance_obligation_health" "h"
     JOIN "public"."entities" "e" ON (("e"."id" = "h"."entity_id")))
  GROUP BY "e"."id", "e"."name";


ALTER VIEW "public"."v_ai_sentinel_dashboard" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_ai_sentinel_status" AS
 WITH "beats" AS (
         SELECT "compliance_audit_log"."id",
            "compliance_audit_log"."changed_at",
            COALESCE(("compliance_audit_log"."context" ->> 'source'::"text"), 'ai-sentinel'::"text") AS "source"
           FROM "public"."compliance_audit_log"
          WHERE ("lower"(COALESCE(("compliance_audit_log"."context" ->> 'source'::"text"), ''::"text")) = 'ai-sentinel'::"text")
        )
 SELECT ("now"() AT TIME ZONE 'utc'::"text") AS "now_utc",
    ( SELECT "max"("beats"."changed_at") AS "max"
           FROM "beats") AS "last_beat_utc",
    (EXTRACT(epoch FROM ((("now"() AT TIME ZONE 'utc'::"text"))::timestamp with time zone - ( SELECT "max"("beats"."changed_at") AS "max"
           FROM "beats"))) / 3600.0) AS "hours_since_last_beat",
        CASE
            WHEN (( SELECT "max"("beats"."changed_at") AS "max"
               FROM "beats") IS NULL) THEN 'unknown'::"text"
            WHEN ((EXTRACT(epoch FROM ((("now"() AT TIME ZONE 'utc'::"text"))::timestamp with time zone - ( SELECT "max"("beats"."changed_at") AS "max"
               FROM "beats"))) / 3600.0) <= (24)::numeric) THEN 'healthy'::"text"
            WHEN ((EXTRACT(epoch FROM ((("now"() AT TIME ZONE 'utc'::"text"))::timestamp with time zone - ( SELECT "max"("beats"."changed_at") AS "max"
               FROM "beats"))) / 3600.0) <= (36)::numeric) THEN 'warning'::"text"
            ELSE 'critical'::"text"
        END AS "status";


ALTER VIEW "public"."v_ai_sentinel_status" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_all_corporate_documents" AS
 SELECT 'governance_document'::"text" AS "source",
    "gl"."entity_id",
    NULL::"text" AS "entity_key",
    "e"."slug" AS "entity_slug",
    NULL::"uuid" AS "entry_id",
    "gd"."record_id",
    "gd"."envelope_id",
    "gd"."file_name",
    "gd"."storage_path",
    "gd"."doc_type",
    "gd"."mime_type",
    "gd"."file_size",
    "gd"."file_hash",
    "gd"."version",
    "gd"."expires_at",
    "gd"."retention_policy",
    ("gd"."ocr_text" IS NOT NULL) AS "has_ocr",
    "gd"."uploaded_by",
    "gd"."created_at" AS "uploaded_at",
    "gl"."title" AS "entry_title",
    ("gl"."created_at")::"date" AS "entry_date",
    NULL::"text" AS "section_name"
   FROM (("public"."governance_documents" "gd"
     JOIN "public"."governance_ledger" "gl" ON (("gl"."id" = "gd"."record_id")))
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "gl"."entity_id")))
UNION ALL
 SELECT 'minute_book_supporting'::"text" AS "source",
    NULL::"uuid" AS "entity_id",
    ("sd"."entity_key")::"text" AS "entity_key",
    NULL::"text" AS "entity_slug",
    "sd"."entry_id",
    NULL::"uuid" AS "record_id",
    "sd"."signature_envelope_id" AS "envelope_id",
    "sd"."file_name",
    "sd"."file_path" AS "storage_path",
    "sd"."doc_type",
    "sd"."mime_type",
    "sd"."file_size",
    "sd"."file_hash",
    "sd"."version",
    "sd"."expires_at",
    "sd"."retention_policy",
    ("sd"."ocr_text" IS NOT NULL) AS "has_ocr",
    "sd"."uploaded_by",
    "sd"."uploaded_at",
    "mbe"."title" AS "entry_title",
    "mbe"."entry_date",
    ("sd"."section")::"text" AS "section_name"
   FROM ("public"."supporting_documents" "sd"
     JOIN "public"."minute_book_entries" "mbe" ON (("mbe"."id" = "sd"."entry_id")))
UNION ALL
 SELECT 'minute_book_entry'::"text" AS "source",
    NULL::"uuid" AS "entity_id",
    ("mbe"."entity_key")::"text" AS "entity_key",
    NULL::"text" AS "entity_slug",
    "mbe"."id" AS "entry_id",
    NULL::"uuid" AS "record_id",
    NULL::"uuid" AS "envelope_id",
    "mbe"."file_name",
    "mbe"."storage_path",
    NULL::"text" AS "doc_type",
    NULL::"text" AS "mime_type",
    NULL::bigint AS "file_size",
    NULL::"text" AS "file_hash",
    NULL::integer AS "version",
    NULL::timestamp with time zone AS "expires_at",
    NULL::"text" AS "retention_policy",
    false AS "has_ocr",
    "mbe"."owner_id" AS "uploaded_by",
    "mbe"."created_at" AS "uploaded_at",
    "mbe"."title" AS "entry_title",
    "mbe"."entry_date",
    "mbe"."section_name"
   FROM "public"."minute_book_entries" "mbe";


ALTER VIEW "public"."v_all_corporate_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_governance_all_documents" AS
 SELECT "id" AS "document_id",
    "record_id",
    "file_name",
    "doc_type",
    "storage_path",
    "mime_type",
    "envelope_id",
    "created_at",
    "metadata"
   FROM "public"."governance_documents" "d"
  ORDER BY "created_at" DESC;


ALTER VIEW "public"."v_governance_all_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_archive_documents" AS
 SELECT "d"."document_id",
    "d"."record_id",
    "d"."file_name",
    "d"."doc_type",
    "d"."storage_path",
    "split_part"("d"."storage_path", '/'::"text", 1) AS "entity_code",
    "d"."mime_type",
    "d"."envelope_id",
    "e"."status" AS "envelope_status",
    "e"."completed_at" AS "signed_at",
    "g"."file_size",
    "g"."file_hash",
    "d"."created_at" AS "uploaded_at",
    "d"."metadata"
   FROM (("public"."v_governance_all_documents" "d"
     LEFT JOIN "public"."signature_envelopes" "e" ON (("e"."id" = "d"."envelope_id")))
     LEFT JOIN "public"."governance_documents" "g" ON (("g"."id" = "d"."document_id")));


ALTER VIEW "public"."v_archive_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_audit_feed" AS
 SELECT "occurred_at",
    "entity_id",
    "table_name",
    "action",
    "row_pk",
    "actor",
    "prev_hash",
    "hash",
    "payload"
   FROM "public"."audit_logs";


ALTER VIEW "public"."v_audit_feed" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_ci_alchemy_drafts" AS
 SELECT "r"."id" AS "resolution_id",
    "r"."entity_id",
    "e"."slug" AS "entity_slug",
    "r"."title",
    "r"."status",
    "r"."version_int",
    "r"."created_at",
    "r"."updated_at",
    "r"."test_tag",
    "r"."compliance_status",
    "r"."signature_envelope_id",
    "gl"."id" AS "record_id",
    "gl"."record_type",
    "gl"."ai_status",
    "gl"."compliance_status" AS "record_compliance_status"
   FROM (("public"."resolutions" "r"
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "r"."entity_id")))
     LEFT JOIN "public"."governance_ledger" "gl" ON (("gl"."id" = "r"."minute_book_id")))
  WHERE ("r"."status" = ANY (ARRAY['draft'::"text", 'review_required'::"text", 'pending'::"text"]));


ALTER VIEW "public"."v_ci_alchemy_drafts" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_ci_archive_documents" AS
 SELECT 'governance'::"text" AS "source",
    "gd"."id" AS "document_id",
    "gd"."record_id",
    "gd"."envelope_id",
    "gd"."storage_path",
    "gd"."file_name",
    "gd"."doc_type",
    "gd"."mime_type",
    "gd"."file_size",
    "gd"."created_at",
    "gd"."version",
    "gd"."has_ocr",
    "gd"."ocr_lang",
    "gd"."expires_at",
    "gd"."retention_policy"
   FROM "public"."governance_documents" "gd"
UNION ALL
 SELECT 'supporting'::"text" AS "source",
    "sd"."id" AS "document_id",
    "sd"."entry_id" AS "record_id",
    "sd"."signature_envelope_id" AS "envelope_id",
    "sd"."file_path" AS "storage_path",
    "sd"."file_name",
    "sd"."doc_type",
    "sd"."mime_type",
    "sd"."file_size",
    "sd"."uploaded_at" AS "created_at",
    "sd"."version",
    "sd"."has_ocr",
    NULL::"text" AS "ocr_lang",
    "sd"."expires_at",
    "sd"."retention_policy"
   FROM "public"."supporting_documents" "sd";


ALTER VIEW "public"."v_ci_archive_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_ci_forge_envelopes" AS
 SELECT "se"."id" AS "envelope_id",
    "se"."entity_id",
    "e"."slug" AS "entity_slug",
    "gl"."id" AS "record_id",
    "gl"."title" AS "record_title",
    "gl"."record_type",
    "se"."title" AS "envelope_title",
    "se"."status" AS "envelope_status",
    "se"."created_at",
    "se"."completed_at",
    "se"."expires_at",
    "se"."signing_mode",
    "count"("sp"."id") AS "total_parties",
    "count"(*) FILTER (WHERE ("sp"."status" = 'signed'::"text")) AS "signed_parties",
    "count"(*) FILTER (WHERE ("sp"."status" = 'pending'::"text")) AS "pending_parties"
   FROM ((("public"."signature_envelopes" "se"
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "se"."entity_id")))
     LEFT JOIN "public"."governance_ledger" "gl" ON (("gl"."id" = "se"."record_id")))
     LEFT JOIN "public"."signature_parties" "sp" ON (("sp"."envelope_id" = "se"."id")))
  GROUP BY "se"."id", "se"."entity_id", "e"."slug", "gl"."id", "gl"."title", "gl"."record_type", "se"."title", "se"."status", "se"."created_at", "se"."completed_at", "se"."expires_at", "se"."signing_mode";


ALTER VIEW "public"."v_ci_forge_envelopes" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_ci_oracle_reviews" AS
 SELECT "gl"."id" AS "record_id",
    "gl"."entity_id",
    "e"."slug" AS "entity_slug",
    "gl"."title" AS "record_title",
    "gl"."record_type",
    "gl"."created_at" AS "record_created_at",
    "gl"."ai_status",
    "s"."id" AS "summary_id",
    "s"."generated_at" AS "summary_generated_at",
    "s"."model" AS "summary_model",
    "s"."confidence" AS "summary_confidence",
    "a"."id" AS "analysis_id",
    "a"."generated_at" AS "analysis_generated_at",
    "a"."model" AS "analysis_model",
    "a"."confidence" AS "analysis_confidence"
   FROM ((("public"."governance_ledger" "gl"
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "gl"."entity_id")))
     LEFT JOIN "public"."ai_summaries" "s" ON (("s"."record_id" = "gl"."id")))
     LEFT JOIN "public"."ai_analyses" "a" ON (("a"."record_id" = "gl"."id")));


ALTER VIEW "public"."v_ci_oracle_reviews" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_ci_sentinel_obligation_health" AS
 SELECT "co"."id" AS "obligation_id",
    "co"."entity_id",
    "e"."slug" AS "entity_slug",
    "co"."description" AS "obligation_description",
    "co"."status" AS "obligation_status",
    "co"."next_review_date",
    "cr"."id" AS "last_review_id",
    "cr"."review_date",
    "cr"."compliant",
    "cr"."risk_level",
    "cr"."overall_status",
    "cr"."confidence" AS "ai_confidence"
   FROM (("public"."compliance_obligations" "co"
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "co"."entity_id")))
     LEFT JOIN LATERAL ( SELECT "r"."id",
            "r"."obligation_id",
            "r"."review_date",
            "r"."compliant",
            "r"."risk_level",
            "r"."ai_summary",
            "r"."resolution_id",
            "r"."review_day",
            "r"."issues",
            "r"."actions",
            "r"."notes",
            "r"."overall_status",
            "r"."checked_at",
            "r"."ai_source",
            "r"."model_id",
            "r"."model",
            "r"."model_hash",
            "r"."confidence",
            "r"."raw_response",
            "r"."record_id",
            "r"."source_table",
            "r"."summary",
            "r"."created_at",
            "r"."updated_at",
            "r"."approved_by",
            "r"."approved_at"
           FROM "public"."compliance_reviews" "r"
          WHERE ("r"."obligation_id" = "co"."id")
          ORDER BY "r"."review_date" DESC
         LIMIT 1) "cr" ON (true));


ALTER VIEW "public"."v_ci_sentinel_obligation_health" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_ci_suite_map" AS
 SELECT "t"."module_key",
    COALESCE("m"."label", "t"."module_key") AS "module_label",
    "t"."ci_name",
    "t"."table_name",
    "t"."created_at"
   FROM ("public"."ci_tables_registry" "t"
     LEFT JOIN "public"."ci_modules_registry" "m" ON (("m"."key" = "t"."module_key")))
  ORDER BY "t"."module_key", "t"."ci_name";


ALTER VIEW "public"."v_ci_suite_map" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_compliance_audit_feed" AS
 SELECT "a"."changed_at",
    "a"."resolution_id",
    "r"."title",
    "a"."old_status",
    "a"."new_status",
    "a"."actor_type",
    "a"."reviewer",
    "a"."context"
   FROM ("public"."compliance_audit_log" "a"
     LEFT JOIN "public"."resolutions" "r" ON (("r"."id" = "a"."resolution_id")))
  ORDER BY "a"."changed_at" DESC;


ALTER VIEW "public"."v_compliance_audit_feed" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_latest_reviews" AS
 WITH "ranked" AS (
         SELECT "r"."id" AS "resolution_id",
            "cr"."risk_level",
            "cr"."compliant",
            "cr"."review_date",
            "row_number"() OVER (PARTITION BY "r"."id" ORDER BY "cr"."review_date" DESC) AS "rn"
           FROM ("public"."resolutions" "r"
             LEFT JOIN "public"."compliance_reviews" "cr" ON (("cr"."resolution_id" = "r"."id")))
        )
 SELECT "resolution_id",
    "risk_level",
    "compliant",
    "review_date"
   FROM "ranked"
  WHERE ("rn" = 1);


ALTER VIEW "public"."v_latest_reviews" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_compliance_kpis" AS
 SELECT "count"(*) AS "total_resolutions",
    COALESCE("sum"(
        CASE
            WHEN ("lr"."risk_level" = 'low'::"text") THEN 1
            ELSE 0
        END), (0)::bigint) AS "low_risk",
    COALESCE("sum"(
        CASE
            WHEN ("lr"."risk_level" = 'medium'::"text") THEN 1
            ELSE 0
        END), (0)::bigint) AS "medium_risk",
    COALESCE("sum"(
        CASE
            WHEN ("lr"."risk_level" = 'high'::"text") THEN 1
            ELSE 0
        END), (0)::bigint) AS "high_risk",
    COALESCE("round"(((100.0 * ("sum"(
        CASE
            WHEN ("lr"."compliant" IS TRUE) THEN 1
            ELSE 0
        END))::numeric) / (NULLIF("count"(*), 0))::numeric), 1), 0.0) AS "percent_compliant"
   FROM ("public"."resolutions" "r"
     LEFT JOIN "public"."v_latest_reviews" "lr" ON (("lr"."resolution_id" = "r"."id")));


ALTER VIEW "public"."v_compliance_kpis" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_compliance_reviews_with_policies" AS
 SELECT "cr"."id" AS "review_id",
    "cr"."obligation_id",
    "cr"."risk_level",
    "cr"."compliant",
    "cr"."summary",
    "cr"."ai_summary",
    "cr"."created_at",
    "cr"."updated_at",
    "rs"."id" AS "rule_set_id",
    "rs"."code" AS "rule_set_code",
    "rs"."name" AS "rule_set_name",
    "rs"."version" AS "rule_set_version",
    "rs"."scope" AS "rule_set_scope",
    "ap"."id" AS "ai_policy_id",
    "ap"."engine_name",
    "ap"."policy_code",
    "ap"."version" AS "ai_policy_version",
    "ap"."model" AS "ai_model",
    "rs"."definition_json",
    "ap"."prompt_profile",
    "ap"."guardrails_json"
   FROM (("public"."compliance_reviews" "cr"
     LEFT JOIN "public"."compliance_rule_sets" "rs" ON (("rs"."id" = "cr"."rule_set_id")))
     LEFT JOIN "public"."ai_policy_versions" "ap" ON (("ap"."id" = "cr"."ai_policy_version_id")));


ALTER VIEW "public"."v_compliance_reviews_with_policies" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_schema_amendments" AS
 SELECT "scl"."id" AS "change_id",
    "scl"."change_key",
    "scl"."description",
    "scl"."change_type",
    "scl"."impact_scope",
    "scl"."stage",
    "scl"."is_constitutional",
    "scl"."breaking_change",
    "scl"."constitutional_object_id",
    "co"."object_type" AS "constitutional_object_type",
    "co"."object_name" AS "constitutional_object_name",
    "scl"."proposed_at",
    "scl"."approved_at",
    "scl"."applied_at",
    "scl"."rejected_at",
    "scl"."proposed_by_user_id",
    "scl"."approved_by_user_id",
    "scl"."rejected_by_user_id",
    "scl"."metadata"
   FROM ("public"."schema_change_log" "scl"
     LEFT JOIN "public"."constitutional_objects" "co" ON (("co"."id" = "scl"."constitutional_object_id")))
  ORDER BY "scl"."is_constitutional" DESC, "scl"."applied_at" DESC NULLS LAST, "scl"."approved_at" DESC NULLS LAST, "scl"."proposed_at" DESC NULLS LAST;


ALTER VIEW "public"."v_schema_amendments" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_constitutional_amendments" AS
 SELECT "change_id",
    "change_key",
    "description",
    "change_type",
    "impact_scope",
    "stage",
    "is_constitutional",
    "breaking_change",
    "constitutional_object_id",
    "constitutional_object_type",
    "constitutional_object_name",
    "proposed_at",
    "approved_at",
    "applied_at",
    "rejected_at",
    "proposed_by_user_id",
    "approved_by_user_id",
    "rejected_by_user_id",
    "metadata"
   FROM "public"."v_schema_amendments"
  WHERE ("is_constitutional" IS TRUE);


ALTER VIEW "public"."v_constitutional_amendments" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_corrective_action_ai_context" AS
 SELECT "ca"."id" AS "corrective_action_id",
    "v"."id" AS "violation_id",
    "e"."id" AS "entity_id",
    "e"."slug" AS "entity_slug",
    "e"."name" AS "entity_name",
    "gv"."rule_key",
    "gv"."name" AS "rule_name",
    "gv"."severity",
    "ca"."action",
    "ca"."owner",
    "ca"."due_date",
    "ca"."status",
    "v"."detected_at",
    "v"."details" AS "violation_details"
   FROM ((("public"."corrective_actions" "ca"
     JOIN "public"."governance_violations" "v" ON (("v"."corrective_action_id" = "ca"."id")))
     JOIN "public"."governance_validations" "gv" ON (("gv"."id" = "v"."validation_id")))
     JOIN "public"."entities" "e" ON (("e"."id" = "v"."entity_id")))
  ORDER BY "ca"."due_date", "gv"."severity" DESC, "e"."slug";


ALTER VIEW "public"."v_corrective_action_ai_context" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_corrective_action_ai_status" AS
 SELECT "ca"."id" AS "corrective_action_id",
    "ca"."review_id",
    "ca"."action",
    "ca"."owner",
    "ca"."due_date",
    "ca"."status" AS "corrective_status",
    "gv"."id" AS "violation_id",
    "gv"."status" AS "violation_status",
    "gv"."detected_at",
    "gv"."details" AS "violation_details",
    "e"."id" AS "entity_id",
    "e"."slug" AS "entity_slug",
    "e"."name" AS "entity_name",
    "aa"."id" AS "ai_advice_id",
    "aa"."recommendation",
    "aa"."advice",
    "aa"."risk_rating",
    "aa"."confidence",
    "aa"."generated_at",
    "aa"."model",
        CASE
            WHEN ("aa"."advice" IS NOT NULL) THEN 'complete'::"text"
            WHEN ("aa"."id" IS NOT NULL) THEN 'pending_ai_text'::"text"
            ELSE 'no_ai'::"text"
        END AS "ai_state"
   FROM ((("public"."corrective_actions" "ca"
     LEFT JOIN "public"."governance_violations" "gv" ON (("gv"."corrective_action_id" = "ca"."id")))
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "gv"."entity_id")))
     LEFT JOIN "public"."ai_advice" "aa" ON (("aa"."corrective_action_id" = "ca"."id")));


ALTER VIEW "public"."v_corrective_action_ai_status" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_corrective_action_queue" AS
 SELECT "ca"."id" AS "corrective_action_id",
    "v"."id" AS "violation_id",
    "e"."slug" AS "entity_slug",
    "e"."name" AS "entity_name",
    "gv"."rule_key",
    "gv"."severity",
    "ca"."action",
    "ca"."owner",
    "ca"."due_date",
    "ca"."status",
    "v"."detected_at",
    "v"."details"
   FROM ((("public"."corrective_actions" "ca"
     JOIN "public"."governance_violations" "v" ON (("v"."corrective_action_id" = "ca"."id")))
     JOIN "public"."governance_validations" "gv" ON (("gv"."id" = "v"."validation_id")))
     JOIN "public"."entities" "e" ON (("e"."id" = "v"."entity_id")))
  ORDER BY "ca"."due_date", "gv"."severity" DESC;


ALTER VIEW "public"."v_corrective_action_queue" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_corrective_actions_needing_ai" AS
 SELECT "cctx"."corrective_action_id",
    "cctx"."violation_id",
    "cctx"."entity_id",
    "cctx"."entity_slug",
    "cctx"."entity_name",
    "cctx"."rule_key",
    "cctx"."rule_name",
    "cctx"."severity",
    "cctx"."action",
    "cctx"."owner",
    "cctx"."due_date",
    "cctx"."status",
    "cctx"."detected_at",
    "cctx"."violation_details"
   FROM ("public"."v_corrective_action_ai_context" "cctx"
     LEFT JOIN "public"."ai_advice" "aa" ON (("aa"."corrective_action_id" = "cctx"."corrective_action_id")))
  WHERE ("aa"."id" IS NULL);


ALTER VIEW "public"."v_corrective_actions_needing_ai" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_council_feed" AS
 WITH "signature_events_feed" AS (
         SELECT "se"."event_time" AS "occurred_at",
            'forge'::"text" AS "module",
            'signature_event'::"text" AS "event_type",
                CASE
                    WHEN ("se"."event_type" = 'signed'::"text") THEN 'success'::"text"
                    WHEN ("se"."event_type" = 'viewed'::"text") THEN 'info'::"text"
                    WHEN ("se"."event_type" = 'sent'::"text") THEN 'info'::"text"
                    WHEN ("se"."event_type" = 'declined'::"text") THEN 'error'::"text"
                    WHEN ("se"."event_type" = 'bounced'::"text") THEN 'error'::"text"
                    WHEN ("se"."event_type" = 'expired'::"text") THEN 'warning'::"text"
                    ELSE 'info'::"text"
                END AS "severity",
            "env"."entity_id",
            "e"."slug" AS "entity_slug",
            "e"."name" AS "entity_name",
            ("se"."envelope_id")::"text" AS "primary_ref",
            COALESCE("env"."title", 'Signature Envelope'::"text") AS "title",
            "se"."event_type" AS "action",
            "jsonb_build_object"('envelope_id', "se"."envelope_id", 'party_id', "se"."party_id", 'event_type', "se"."event_type", 'ip_address', "se"."ip_address", 'user_agent', "se"."user_agent") AS "details"
           FROM (("public"."signature_events" "se"
             JOIN "public"."signature_envelopes" "env" ON (("env"."id" = "se"."envelope_id")))
             LEFT JOIN "public"."entities" "e" ON (("e"."id" = "env"."entity_id")))
        ), "ledger_created_feed" AS (
         SELECT "gl"."created_at" AS "occurred_at",
            'ledger'::"text" AS "module",
            'ledger_record_created'::"text" AS "event_type",
            'success'::"text" AS "severity",
            "gl"."entity_id",
            "e"."slug" AS "entity_slug",
            "e"."name" AS "entity_name",
            ("gl"."id")::"text" AS "primary_ref",
            COALESCE("gl"."title", 'Ledger Record'::"text") AS "title",
            COALESCE("gl"."record_type", 'record'::"text") AS "action",
            "jsonb_build_object"('record_id', "gl"."id", 'record_type', "gl"."record_type", 'created_by', "gl"."created_by", 'provisional', "gl"."provisional", 'ai_status', "gl"."ai_status", 'compliance_status', "gl"."compliance_status") AS "details"
           FROM ("public"."governance_ledger" "gl"
             LEFT JOIN "public"."entities" "e" ON (("e"."id" = "gl"."entity_id")))
        ), "minute_book_entries_feed" AS (
         SELECT "mbe"."created_at" AS "occurred_at",
            'archive'::"text" AS "module",
            'minute_book_entry'::"text" AS "event_type",
            'info'::"text" AS "severity",
            NULL::"uuid" AS "entity_id",
            ("mbe"."entity_key")::"text" AS "entity_slug",
            NULL::"text" AS "entity_name",
            ("mbe"."id")::"text" AS "primary_ref",
            COALESCE("mbe"."title", 'Minute Book Entry'::"text") AS "title",
            ("mbe"."entry_type")::"text" AS "action",
            "jsonb_build_object"('entry_id', "mbe"."id", 'entity_key', "mbe"."entity_key", 'entry_date', "mbe"."entry_date", 'entry_type', "mbe"."entry_type", 'section_name', "mbe"."section_name", 'file_name', "mbe"."file_name") AS "details"
           FROM "public"."minute_book_entries" "mbe"
        ), "supporting_documents_feed" AS (
         SELECT "sd"."uploaded_at" AS "occurred_at",
            'archive'::"text" AS "module",
            'document_uploaded'::"text" AS "event_type",
            'success'::"text" AS "severity",
            NULL::"uuid" AS "entity_id",
            ("sd"."entity_key")::"text" AS "entity_slug",
            NULL::"text" AS "entity_name",
            ("sd"."id")::"text" AS "primary_ref",
            COALESCE("sd"."file_name", 'Supporting Document'::"text") AS "title",
            COALESCE("sd"."doc_type", 'document'::"text") AS "action",
            "jsonb_build_object"('entry_id', "sd"."entry_id", 'entity_key', "sd"."entity_key", 'file_path', "sd"."file_path", 'file_name', "sd"."file_name", 'doc_type', "sd"."doc_type", 'file_size', "sd"."file_size", 'mime_type', "sd"."mime_type") AS "details"
           FROM "public"."supporting_documents" "sd"
        ), "ai_analyses_feed" AS (
         SELECT "aa"."generated_at" AS "occurred_at",
            'oracle'::"text" AS "module",
            'ai_analysis'::"text" AS "event_type",
            'info'::"text" AS "severity",
            "gl"."entity_id",
            "e"."slug" AS "entity_slug",
            "e"."name" AS "entity_name",
            ("aa"."id")::"text" AS "primary_ref",
            COALESCE("gl"."title", 'AI Analysis'::"text") AS "title",
            COALESCE("aa"."model", "aa"."model_id", 'ai_model'::"text") AS "action",
            "jsonb_build_object"('analysis_id', "aa"."id", 'record_id', "aa"."record_id", 'model', "aa"."model", 'model_id', "aa"."model_id", 'confidence', "aa"."confidence") AS "details"
           FROM (("public"."ai_analyses" "aa"
             LEFT JOIN "public"."governance_ledger" "gl" ON (("gl"."id" = "aa"."record_id")))
             LEFT JOIN "public"."entities" "e" ON (("e"."id" = "gl"."entity_id")))
        ), "compliance_audit_feed" AS (
         SELECT "cal"."changed_at" AS "occurred_at",
            'sentinel'::"text" AS "module",
            'compliance_change'::"text" AS "event_type",
                CASE
                    WHEN ("cal"."new_status" = ANY (ARRAY['at_risk'::"text", 'escalated'::"text"])) THEN 'error'::"text"
                    WHEN ("cal"."new_status" = 'review_required'::"text") THEN 'warning'::"text"
                    WHEN ("cal"."new_status" = ANY (ARRAY['compliant'::"text", 'resolved'::"text", 'reviewed'::"text"])) THEN 'success'::"text"
                    ELSE 'info'::"text"
                END AS "severity",
            "r"."entity_id",
            "e"."slug" AS "entity_slug",
            "e"."name" AS "entity_name",
            ("cal"."id")::"text" AS "primary_ref",
            COALESCE("r"."title", 'Compliance Event'::"text") AS "title",
            COALESCE("cal"."new_status", 'status_change'::"text") AS "action",
            "jsonb_build_object"('resolution_id', "cal"."resolution_id", 'old_status', "cal"."old_status", 'new_status', "cal"."new_status", 'reviewer', "cal"."reviewer", 'actor_type', "cal"."actor_type") AS "details"
           FROM (("public"."compliance_audit_log" "cal"
             LEFT JOIN "public"."resolutions" "r" ON (("r"."id" = "cal"."resolution_id")))
             LEFT JOIN "public"."entities" "e" ON (("e"."id" = "r"."entity_id")))
        ), "audit_logs_feed" AS (
         SELECT "al"."occurred_at",
            'kernel'::"text" AS "module",
            'audit_log'::"text" AS "event_type",
                CASE
                    WHEN ("al"."action" = ANY (ARRAY['delete'::"text", 'adopt'::"text"])) THEN 'warning'::"text"
                    ELSE 'info'::"text"
                END AS "severity",
            "al"."entity_id",
            "e"."slug" AS "entity_slug",
            "e"."name" AS "entity_name",
            ("al"."id")::"text" AS "primary_ref",
            "concat"('Audit: ', "al"."table_name") AS "title",
            "al"."action",
            "jsonb_build_object"('table_name', "al"."table_name", 'row_pk', "al"."row_pk", 'action', "al"."action", 'prev_hash', "al"."prev_hash", 'hash', "al"."hash") AS "details"
           FROM ("public"."audit_logs" "al"
             LEFT JOIN "public"."entities" "e" ON (("e"."id" = "al"."entity_id")))
        )
 SELECT "signature_events_feed"."occurred_at",
    "signature_events_feed"."module",
    "signature_events_feed"."event_type",
    "signature_events_feed"."severity",
    "signature_events_feed"."entity_id",
    "signature_events_feed"."entity_slug",
    "signature_events_feed"."entity_name",
    "signature_events_feed"."primary_ref",
    "signature_events_feed"."title",
    "signature_events_feed"."action",
    "signature_events_feed"."details"
   FROM "signature_events_feed"
UNION ALL
 SELECT "ledger_created_feed"."occurred_at",
    "ledger_created_feed"."module",
    "ledger_created_feed"."event_type",
    "ledger_created_feed"."severity",
    "ledger_created_feed"."entity_id",
    "ledger_created_feed"."entity_slug",
    "ledger_created_feed"."entity_name",
    "ledger_created_feed"."primary_ref",
    "ledger_created_feed"."title",
    "ledger_created_feed"."action",
    "ledger_created_feed"."details"
   FROM "ledger_created_feed"
UNION ALL
 SELECT "minute_book_entries_feed"."occurred_at",
    "minute_book_entries_feed"."module",
    "minute_book_entries_feed"."event_type",
    "minute_book_entries_feed"."severity",
    "minute_book_entries_feed"."entity_id",
    "minute_book_entries_feed"."entity_slug",
    "minute_book_entries_feed"."entity_name",
    "minute_book_entries_feed"."primary_ref",
    "minute_book_entries_feed"."title",
    "minute_book_entries_feed"."action",
    "minute_book_entries_feed"."details"
   FROM "minute_book_entries_feed"
UNION ALL
 SELECT "supporting_documents_feed"."occurred_at",
    "supporting_documents_feed"."module",
    "supporting_documents_feed"."event_type",
    "supporting_documents_feed"."severity",
    "supporting_documents_feed"."entity_id",
    "supporting_documents_feed"."entity_slug",
    "supporting_documents_feed"."entity_name",
    "supporting_documents_feed"."primary_ref",
    "supporting_documents_feed"."title",
    "supporting_documents_feed"."action",
    "supporting_documents_feed"."details"
   FROM "supporting_documents_feed"
UNION ALL
 SELECT "ai_analyses_feed"."occurred_at",
    "ai_analyses_feed"."module",
    "ai_analyses_feed"."event_type",
    "ai_analyses_feed"."severity",
    "ai_analyses_feed"."entity_id",
    "ai_analyses_feed"."entity_slug",
    "ai_analyses_feed"."entity_name",
    "ai_analyses_feed"."primary_ref",
    "ai_analyses_feed"."title",
    "ai_analyses_feed"."action",
    "ai_analyses_feed"."details"
   FROM "ai_analyses_feed"
UNION ALL
 SELECT "compliance_audit_feed"."occurred_at",
    "compliance_audit_feed"."module",
    "compliance_audit_feed"."event_type",
    "compliance_audit_feed"."severity",
    "compliance_audit_feed"."entity_id",
    "compliance_audit_feed"."entity_slug",
    "compliance_audit_feed"."entity_name",
    "compliance_audit_feed"."primary_ref",
    "compliance_audit_feed"."title",
    "compliance_audit_feed"."action",
    "compliance_audit_feed"."details"
   FROM "compliance_audit_feed"
UNION ALL
 SELECT "audit_logs_feed"."occurred_at",
    "audit_logs_feed"."module",
    "audit_logs_feed"."event_type",
    "audit_logs_feed"."severity",
    "audit_logs_feed"."entity_id",
    "audit_logs_feed"."entity_slug",
    "audit_logs_feed"."entity_name",
    "audit_logs_feed"."primary_ref",
    "audit_logs_feed"."title",
    "audit_logs_feed"."action",
    "audit_logs_feed"."details"
   FROM "audit_logs_feed"
  ORDER BY 1 DESC;


ALTER VIEW "public"."v_council_feed" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_council_feed_colored" AS
 SELECT "occurred_at",
    "module",
    "event_type",
    "severity",
        CASE
            WHEN ("severity" = 'error'::"text") THEN 'red'::"text"
            WHEN ("severity" = 'warning'::"text") THEN 'yellow'::"text"
            WHEN ("severity" = 'success'::"text") THEN 'green'::"text"
            ELSE 'blue'::"text"
        END AS "council_color",
    "entity_id",
    "entity_slug",
    "entity_name",
    "primary_ref",
    "title"
   FROM "public"."v_council_feed"
  ORDER BY "occurred_at" DESC;


ALTER VIEW "public"."v_council_feed_colored" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_current_user_entities" AS
 SELECT "e"."id" AS "entity_id",
    "e"."slug",
    "e"."name",
    "e"."kind",
    "m"."role",
    "m"."is_admin"
   FROM (("auth"."users" "u"
     JOIN "public"."memberships" "m" ON (("m"."user_id" = "u"."id")))
     JOIN "public"."entities" "e" ON (("e"."id" = "m"."entity_id")))
  WHERE ("u"."id" = "auth"."uid"());


ALTER VIEW "public"."v_current_user_entities" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_doc_sections_with_pillar" AS
 SELECT ("s"."section")::"text" AS "section",
    ("p"."pillar")::"text" AS "pillar",
    COALESCE("p"."description", ''::"text") AS "description"
   FROM ("unnest"("enum_range"(NULL::"public"."doc_section_enum")) "s"("section")
     LEFT JOIN "public"."doc_section_pillars" "p" ON (("p"."section" = "s"."section")));


ALTER VIEW "public"."v_doc_sections_with_pillar" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_entity_compliance_health" AS
 WITH "violations_by_entity" AS (
         SELECT "gv"."entity_id",
            "count"(*) FILTER (WHERE ("gv"."status" = 'open'::"text")) AS "open_violations",
            "count"(*) FILTER (WHERE (("gv"."status" = 'open'::"text") AND ("val"."severity" = 'critical'::"text"))) AS "open_critical_violations",
            "count"(*) FILTER (WHERE (("gv"."status" = 'open'::"text") AND ("val"."severity" = 'error'::"text"))) AS "open_error_violations"
           FROM ("public"."governance_violations" "gv"
             JOIN "public"."governance_validations" "val" ON (("val"."id" = "gv"."validation_id")))
          GROUP BY "gv"."entity_id"
        ), "corrective_by_entity" AS (
         SELECT "gv"."entity_id",
            "count"(*) FILTER (WHERE ("ca"."status" = 'open'::"text")) AS "open_corrective_actions",
            "count"(*) FILTER (WHERE (("ca"."status" = 'open'::"text") AND ("ca"."due_date" < CURRENT_DATE))) AS "past_due_actions"
           FROM ("public"."corrective_actions" "ca"
             JOIN "public"."governance_violations" "gv" ON (("gv"."corrective_action_id" = "ca"."id")))
          GROUP BY "gv"."entity_id"
        ), "ai_by_entity" AS (
         SELECT "gv"."entity_id",
            "count"(*) FILTER (WHERE ("aa"."advice" IS NOT NULL)) AS "completed_ai_advice",
            "count"(*) FILTER (WHERE (("aa"."id" IS NOT NULL) AND ("aa"."advice" IS NULL))) AS "pending_ai_advice"
           FROM (("public"."ai_advice" "aa"
             JOIN "public"."corrective_actions" "ca" ON (("ca"."id" = "aa"."corrective_action_id")))
             JOIN "public"."governance_violations" "gv" ON (("gv"."corrective_action_id" = "ca"."id")))
          GROUP BY "gv"."entity_id"
        ), "base" AS (
         SELECT "e"."id" AS "entity_id",
            "e"."slug" AS "entity_slug",
            "e"."name" AS "entity_name",
            COALESCE("v"."open_violations", (0)::bigint) AS "open_violations",
            COALESCE("v"."open_critical_violations", (0)::bigint) AS "open_critical_violations",
            COALESCE("v"."open_error_violations", (0)::bigint) AS "open_error_violations",
            COALESCE("c"."open_corrective_actions", (0)::bigint) AS "open_corrective_actions",
            COALESCE("c"."past_due_actions", (0)::bigint) AS "past_due_actions",
            COALESCE("a"."completed_ai_advice", (0)::bigint) AS "completed_ai_advice",
            COALESCE("a"."pending_ai_advice", (0)::bigint) AS "pending_ai_advice",
            (GREATEST((0)::bigint, (((100 - (COALESCE("v"."open_critical_violations", (0)::bigint) * 20)) - (COALESCE("v"."open_error_violations", (0)::bigint) * 10)) - (COALESCE("c"."past_due_actions", (0)::bigint) * 15))))::integer AS "compliance_score"
           FROM ((("public"."entities" "e"
             LEFT JOIN "violations_by_entity" "v" ON (("v"."entity_id" = "e"."id")))
             LEFT JOIN "corrective_by_entity" "c" ON (("c"."entity_id" = "e"."id")))
             LEFT JOIN "ai_by_entity" "a" ON (("a"."entity_id" = "e"."id")))
        )
 SELECT "entity_id",
    "entity_slug",
    "entity_name",
    "open_violations",
    "open_critical_violations",
    "open_error_violations",
    "open_corrective_actions",
    "past_due_actions",
    "completed_ai_advice",
    "pending_ai_advice",
    "compliance_score",
        CASE
            WHEN ("compliance_score" >= 80) THEN 'green'::"text"
            WHEN ("compliance_score" >= 50) THEN 'yellow'::"text"
            ELSE 'red'::"text"
        END AS "status_color"
   FROM "base";


ALTER VIEW "public"."v_entity_compliance_health" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_entity_compliance_overview" AS
 WITH "latest_reviews" AS (
         SELECT "cr"."id",
            "cr"."obligation_id",
            "cr"."review_date",
            "cr"."compliant",
            "cr"."risk_level",
            "cr"."ai_summary",
            "cr"."resolution_id",
            "cr"."review_day",
            "cr"."issues",
            "cr"."actions",
            "cr"."notes",
            "cr"."overall_status",
            "cr"."checked_at",
            "cr"."ai_source",
            "cr"."model_id",
            "cr"."model",
            "cr"."model_hash",
            "cr"."confidence",
            "cr"."raw_response",
            "cr"."record_id",
            "cr"."source_table",
            "cr"."summary",
            "cr"."created_at",
            "cr"."updated_at",
            "row_number"() OVER (PARTITION BY "cr"."obligation_id" ORDER BY "cr"."review_date" DESC) AS "rn"
           FROM "public"."compliance_reviews" "cr"
        )
 SELECT "e"."id" AS "entity_id",
    "e"."slug" AS "entity_slug",
    "e"."name" AS "entity_name",
    "co"."id" AS "obligation_id",
    "co"."description" AS "obligation_description",
    "co"."status" AS "obligation_status",
    "co"."next_review_date",
    "gs"."code" AS "standard_code",
    "gs"."name" AS "standard_name",
    "gr"."requirement_code",
    "gr"."title" AS "requirement_title",
    "lr"."compliant" AS "last_compliant",
    "lr"."risk_level" AS "last_risk_level",
    "lr"."review_date" AS "last_review_date",
    "lr"."overall_status" AS "last_overall_status",
    "lr"."ai_summary" AS "last_ai_summary"
   FROM (((("public"."compliance_obligations" "co"
     JOIN "public"."entities" "e" ON (("co"."entity_id" = "e"."id")))
     LEFT JOIN "public"."governance_requirements" "gr" ON (("co"."requirement_id" = "gr"."id")))
     LEFT JOIN "public"."governance_standards" "gs" ON (("gr"."standard_id" = "gs"."id")))
     LEFT JOIN "latest_reviews" "lr" ON ((("lr"."obligation_id" = "co"."id") AND ("lr"."rn" = 1))));


ALTER VIEW "public"."v_entity_compliance_overview" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_entity_compliance_reviews" AS
 SELECT 'compliance_review'::"text" AS "source",
    "gl"."entity_id",
    "e"."slug" AS "entity_slug",
    "cr"."id" AS "review_id",
    "cr"."review_date",
    "cr"."overall_status",
    "cr"."risk_level",
    "cr"."compliant",
    "cr"."summary",
    "cr"."issues",
    "cr"."actions",
    "cr"."ai_source",
    "cr"."model_id",
    "cr"."model",
    "cr"."confidence",
    "cr"."created_at",
    "cr"."updated_at"
   FROM (("public"."compliance_reviews" "cr"
     LEFT JOIN "public"."governance_ledger" "gl" ON (("cr"."record_id" = "gl"."id")))
     LEFT JOIN "public"."entities" "e" ON (("gl"."entity_id" = "e"."id")))
  ORDER BY "cr"."review_date" DESC, "cr"."created_at" DESC;


ALTER VIEW "public"."v_entity_compliance_reviews" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_entity_documents" AS
 SELECT "d"."id" AS "document_id",
    "e"."slug" AS "entity_slug",
    "e"."name" AS "entity_name",
    "d"."record_id",
    "d"."file_name",
    "d"."doc_type",
    "d"."storage_path",
    "d"."mime_type",
    "d"."envelope_id",
    "d"."created_at",
    "d"."metadata"
   FROM (("public"."governance_documents" "d"
     LEFT JOIN "public"."governance_ledger" "g" ON (("g"."id" = "d"."record_id")))
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "g"."entity_id")))
  ORDER BY "d"."created_at" DESC;


ALTER VIEW "public"."v_entity_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_entity_obligations_matrix" AS
 SELECT "e"."id" AS "entity_id",
    "e"."slug" AS "entity_slug",
    "e"."name" AS "entity_name",
    "co"."id" AS "obligation_id",
    "co"."description" AS "obligation_description",
    "co"."control_owner",
    "co"."review_frequency",
    "co"."next_review_date",
    "co"."status" AS "obligation_status",
    "co"."iso_clause_id",
    "co"."requirement_id",
    "gr"."requirement_code",
    "gr"."title" AS "requirement_title",
    "gr"."description" AS "requirement_description",
    "gr"."applies_to",
    "gr"."frequency" AS "requirement_frequency",
    "gr"."trigger_event",
    "gr"."severity" AS "requirement_severity",
    "gs"."code" AS "standard_code",
    "gs"."name" AS "standard_name",
    "gs"."jurisdiction"
   FROM ((("public"."compliance_obligations" "co"
     JOIN "public"."entities" "e" ON (("co"."entity_id" = "e"."id")))
     LEFT JOIN "public"."governance_requirements" "gr" ON (("co"."requirement_id" = "gr"."id")))
     LEFT JOIN "public"."governance_standards" "gs" ON (("gr"."standard_id" = "gs"."id")));


ALTER VIEW "public"."v_entity_obligations_matrix" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_entity_structure" AS
 SELECT "er"."id",
    "parent"."slug" AS "parent_slug",
    "child"."slug" AS "child_slug",
    "er"."relationship_type",
    "er"."ownership_percent",
    "parent"."name" AS "parent_name",
    "child"."name" AS "child_name",
    "er"."notes",
    "er"."created_at"
   FROM (("public"."entity_relationships" "er"
     JOIN "public"."entities" "parent" ON (("parent"."id" = "er"."parent_entity_id")))
     JOIN "public"."entities" "child" ON (("child"."id" = "er"."child_entity_id")));


ALTER VIEW "public"."v_entity_structure" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_entity_violation_overview" AS
 SELECT "e"."id" AS "entity_id",
    "e"."slug" AS "entity_slug",
    "e"."name" AS "entity_name",
    "gv2"."severity",
    "count"(*) AS "open_violations"
   FROM (("public"."governance_violations" "v"
     JOIN "public"."governance_validations" "gv2" ON (("gv2"."id" = "v"."validation_id")))
     JOIN "public"."entities" "e" ON (("e"."id" = "v"."entity_id")))
  WHERE ("v"."status" = ANY (ARRAY['open'::"text", 'in_review'::"text"]))
  GROUP BY "e"."id", "e"."slug", "e"."name", "gv2"."severity"
  ORDER BY "e"."slug", "gv2"."severity";


ALTER VIEW "public"."v_entity_violation_overview" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_envelope_status" AS
 SELECT "e"."id" AS "envelope_id",
    "e"."title" AS "envelope_title",
    "e"."status" AS "envelope_status",
    "p"."id" AS "party_id",
    "p"."signing_order",
    "p"."display_name",
    "p"."email",
    "p"."role",
    "p"."status" AS "party_status",
    "p"."signed_at"
   FROM ("public"."signature_envelopes" "e"
     LEFT JOIN "public"."signature_parties" "p" ON (("p"."envelope_id" = "e"."id")))
  ORDER BY "e"."created_at", "p"."signing_order";


ALTER VIEW "public"."v_envelope_status" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_forge_queue" AS
 SELECT "gl"."id" AS "ledger_id",
    "gl"."title",
    "gl"."status" AS "ledger_status",
    "gl"."created_at",
    "e"."id" AS "entity_id",
    "e"."name" AS "entity_name",
    "e"."slug" AS "entity_slug",
    "se"."id" AS "envelope_id",
    "count"("sp"."id") AS "parties_total",
    "count"("sp"."signed_at") AS "parties_signed",
    "max"("sp"."signed_at") AS "last_signed_at",
    EXTRACT(day FROM ("now"() - "max"("sp"."signed_at"))) AS "days_since_last_signature",
        CASE
            WHEN ("count"("sp"."id") = 0) THEN NULL::"text"
            WHEN ("count"("sp"."id") = "count"("sp"."signed_at")) THEN 'completed'::"text"
            ELSE 'pending'::"text"
        END AS "envelope_status"
   FROM ((("public"."governance_ledger" "gl"
     JOIN "public"."entities" "e" ON (("e"."id" = "gl"."entity_id")))
     LEFT JOIN "public"."signature_envelopes" "se" ON ((("se"."record_id" = "gl"."id") AND ("se"."entity_id" = "gl"."entity_id"))))
     LEFT JOIN "public"."signature_parties" "sp" ON (("sp"."envelope_id" = "se"."id")))
  WHERE ("gl"."status" = 'APPROVED'::"text")
  GROUP BY "gl"."id", "gl"."title", "gl"."status", "gl"."created_at", "e"."id", "e"."name", "e"."slug", "se"."id";


ALTER VIEW "public"."v_forge_queue" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_forge_queue_latest" AS
 SELECT "ledger_id",
    "title",
    "ledger_status",
    "created_at",
    "entity_id",
    "entity_name",
    "entity_slug",
    "envelope_id",
    "parties_total",
    "parties_signed",
    "last_signed_at",
    "days_since_last_signature",
    "envelope_status",
    "rn"
   FROM ( SELECT "q_1"."ledger_id",
            "q_1"."title",
            "q_1"."ledger_status",
            "q_1"."created_at",
            "q_1"."entity_id",
            "q_1"."entity_name",
            "q_1"."entity_slug",
            "q_1"."envelope_id",
            "q_1"."parties_total",
            "q_1"."parties_signed",
            "q_1"."last_signed_at",
            "q_1"."days_since_last_signature",
            "q_1"."envelope_status",
            "row_number"() OVER (PARTITION BY "q_1"."ledger_id" ORDER BY ("q_1"."last_signed_at" IS NULL), "q_1"."last_signed_at" DESC, "q_1"."created_at" DESC) AS "rn"
           FROM "public"."v_forge_queue" "q_1") "q"
  WHERE ("rn" = 1);


ALTER VIEW "public"."v_forge_queue_latest" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_forge_execution_risk" AS
 SELECT "ledger_id",
    "envelope_id",
    "entity_id",
    "entity_slug",
    "title",
    "ledger_status",
    "envelope_status",
    "created_at",
    "last_signed_at",
    "days_since_last_signature",
    "parties_total",
    "parties_signed",
        CASE
            WHEN ("envelope_status" = 'completed'::"text") THEN 'GREEN'::"text"
            WHEN (("envelope_status" = 'pending'::"text") AND (("days_since_last_signature" IS NOT NULL) AND ("days_since_last_signature" >= (7)::numeric))) THEN 'RED'::"text"
            WHEN (("envelope_status" IS NULL) AND (("now"() - "created_at") >= '7 days'::interval)) THEN 'RED'::"text"
            WHEN (("envelope_status" = 'pending'::"text") AND (("days_since_last_signature" IS NOT NULL) AND (("days_since_last_signature" >= (3)::numeric) AND ("days_since_last_signature" <= (6)::numeric)))) THEN 'YELLOW'::"text"
            WHEN (("envelope_status" IS NULL) AND ((("now"() - "created_at") >= '3 days'::interval) AND (("now"() - "created_at") <= '7 days'::interval))) THEN 'YELLOW'::"text"
            ELSE 'GREEN'::"text"
        END AS "risk_level"
   FROM "public"."v_forge_queue_latest" "q";


ALTER VIEW "public"."v_forge_execution_risk" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_forge_pipeline" AS
 WITH "primary_party" AS (
         SELECT "sp"."envelope_id",
            "sp"."email" AS "primary_party_email",
            "sp"."display_name" AS "primary_party_name",
            "sp"."status" AS "primary_party_status",
            "row_number"() OVER (PARTITION BY "sp"."envelope_id" ORDER BY "sp"."signing_order", "sp"."created_at", "sp"."id") AS "rn"
           FROM "public"."signature_parties" "sp"
        ), "latest_email" AS (
         SELECT "q"."envelope_id",
            "q"."to_email",
            "q"."status" AS "last_email_status",
            "q"."sent_at" AS "last_email_sent_at",
            "row_number"() OVER (PARTITION BY "q"."envelope_id" ORDER BY "q"."created_at" DESC, "q"."id" DESC) AS "rn"
           FROM "public"."signature_email_queue" "q"
        )
 SELECT "gl"."id" AS "ledger_id",
    "gl"."title",
    "gl"."entity_id",
    "gl"."status" AS "ledger_status",
    "gl"."record_type",
    "gl"."created_at" AS "ledger_created_at",
    COALESCE("gl"."archived", false) AS "archived",
    "se"."id" AS "envelope_id",
    "se"."status" AS "raw_envelope_status",
    "se"."created_at" AS "envelope_created_at",
        CASE
            WHEN ("se"."id" IS NULL) THEN 'NOT_STARTED'::"text"
            WHEN ("se"."status" = 'pending'::"text") THEN 'PENDING_SIGNATURES'::"text"
            WHEN ("se"."status" = 'completed'::"text") THEN 'COMPLETED'::"text"
            ELSE COALESCE("se"."status", 'UNKNOWN'::"text")
        END AS "envelope_status",
    "pp"."primary_party_email",
    "pp"."primary_party_name",
    "pp"."primary_party_status",
    "le"."last_email_status",
    "le"."last_email_sent_at"
   FROM (((("public"."governance_ledger" "gl"
     JOIN "public"."entities" "e" ON (("e"."id" = "gl"."entity_id")))
     LEFT JOIN "public"."signature_envelopes" "se" ON (("se"."record_id" = "gl"."id")))
     LEFT JOIN "primary_party" "pp" ON ((("pp"."envelope_id" = "se"."id") AND ("pp"."rn" = 1))))
     LEFT JOIN "latest_email" "le" ON ((("le"."envelope_id" = "se"."id") AND ("le"."rn" = 1))))
  WHERE (COALESCE("gl"."archived", false) = false);


ALTER VIEW "public"."v_forge_pipeline" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_governance_ai_last_runs" AS
 SELECT "created_at",
    "event",
    "details",
    "rows_updated",
    "old_status",
    "new_status"
   FROM "public"."ai_status_debug" "d"
  WHERE ("created_at" >= ("now"() - '30 days'::interval))
  ORDER BY "created_at" DESC;


ALTER VIEW "public"."v_governance_ai_last_runs" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_governance_drafts_for_signing" AS
 SELECT "g"."id" AS "ledger_id",
    "g"."entity_id",
    "g"."title",
    "g"."record_type",
    "g"."status",
    "g"."source",
    "g"."created_at",
    "g"."body",
    "e"."slug" AS "entity_slug",
    "e"."name" AS "entity_name"
   FROM ("public"."governance_ledger" "g"
     JOIN "public"."entities" "e" ON (("e"."id" = "g"."entity_id")))
  WHERE ("g"."status" = 'draft'::"text")
  ORDER BY "g"."created_at" DESC;


ALTER VIEW "public"."v_governance_drafts_for_signing" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_governance_record_documents" AS
 SELECT "gl"."id" AS "record_id",
    "gl"."entity_id",
    "e"."slug" AS "entity_slug",
    "gl"."title" AS "record_title",
    "gl"."record_type",
    "gl"."created_at" AS "record_created_at",
    "d"."id" AS "document_id",
    "d"."file_name",
    "d"."doc_type",
    "d"."mime_type",
    "d"."storage_path",
    "d"."envelope_id",
    "d"."created_at" AS "document_created_at",
    "d"."metadata"
   FROM (("public"."governance_ledger" "gl"
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "gl"."entity_id")))
     LEFT JOIN "public"."governance_documents" "d" ON (("d"."record_id" = "gl"."id")))
  ORDER BY "gl"."created_at" DESC, "d"."created_at" DESC;


ALTER VIEW "public"."v_governance_record_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_iso_audit_feed" AS
 SELECT "cr"."id" AS "review_id",
    "cr"."review_date",
    "cr"."review_day",
    "cr"."overall_status",
    "cr"."risk_level",
    "cr"."compliant",
    "cr"."notes" AS "review_notes",
    "o"."id" AS "obligation_id",
    "o"."description" AS "obligation_description",
    "o"."control_owner",
    "e"."id" AS "entity_id",
    "e"."name" AS "entity_name",
    "ic"."standard" AS "iso_standard",
    "ic"."clause" AS "iso_clause",
    "ic"."title" AS "iso_clause_title",
    "cal"."id" AS "status_change_id",
    "cal"."old_status" AS "prev_compliance_status",
    "cal"."new_status" AS "new_compliance_status",
    "cal"."changed_at" AS "status_changed_at",
    "cal"."reviewer",
    "cal"."actor_type",
    "cal"."context"
   FROM (((("public"."compliance_reviews" "cr"
     LEFT JOIN "public"."compliance_obligations" "o" ON (("o"."id" = "cr"."obligation_id")))
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "o"."entity_id")))
     LEFT JOIN "public"."iso_clauses" "ic" ON (("ic"."id" = "o"."iso_clause_id")))
     LEFT JOIN "public"."compliance_audit_log" "cal" ON (("cal"."resolution_id" = "cr"."resolution_id")))
  ORDER BY "cr"."review_date" DESC, "cal"."changed_at" DESC NULLS LAST;


ALTER VIEW "public"."v_iso_audit_feed" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_iso_clause_gaps" AS
 SELECT "e"."id" AS "entity_id",
    "e"."name" AS "entity_name",
    "ic"."standard",
    "ic"."clause" AS "clause_ref",
    "ic"."title" AS "clause_title",
    "ic"."summary" AS "clause_summary"
   FROM (("public"."entities" "e"
     CROSS JOIN "public"."iso_clauses" "ic")
     LEFT JOIN "public"."compliance_obligations" "o" ON ((("o"."entity_id" = "e"."id") AND ("o"."iso_clause_id" = "ic"."id") AND ("o"."status" <> 'retired'::"text"))))
  WHERE ("o"."id" IS NULL);


ALTER VIEW "public"."v_iso_clause_gaps" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_iso_compliance_overview" AS
 SELECT "o"."id" AS "obligation_id",
    "o"."entity_id",
    "e"."name" AS "entity_name",
    "o"."iso_clause_id",
    "ic"."standard" AS "iso_standard",
    "ic"."clause" AS "iso_clause",
    "ic"."title" AS "iso_clause_title",
    "o"."description" AS "obligation_description",
    "o"."control_owner",
    "o"."review_frequency",
    "o"."next_review_date",
    "o"."status" AS "obligation_status",
    "cr"."id" AS "last_review_id",
    "cr"."review_date" AS "last_review_at",
    "cr"."compliant" AS "last_compliant",
    "cr"."risk_level" AS "last_risk_level",
    "cr"."overall_status" AS "last_overall_status",
        CASE
            WHEN (("o"."status" = 'compliant'::"text") AND (("cr"."risk_level" IS NULL) OR ("cr"."risk_level" = 'low'::"text"))) THEN '🟢 Healthy'::"text"
            WHEN (("o"."status" = 'at_risk'::"text") OR ("cr"."risk_level" = 'high'::"text") OR ("cr"."overall_status" = ANY (ARRAY['escalated'::"text", 'resolved'::"text"]))) THEN '🔴 Critical'::"text"
            ELSE '🟡 Warning'::"text"
        END AS "traffic_light_status"
   FROM ((("public"."compliance_obligations" "o"
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "o"."entity_id")))
     LEFT JOIN "public"."iso_clauses" "ic" ON (("ic"."id" = "o"."iso_clause_id")))
     LEFT JOIN LATERAL ( SELECT "cr_1"."id",
            "cr_1"."obligation_id",
            "cr_1"."review_date",
            "cr_1"."compliant",
            "cr_1"."risk_level",
            "cr_1"."ai_summary",
            "cr_1"."resolution_id",
            "cr_1"."review_day",
            "cr_1"."issues",
            "cr_1"."actions",
            "cr_1"."notes",
            "cr_1"."overall_status",
            "cr_1"."checked_at",
            "cr_1"."ai_source",
            "cr_1"."model_id",
            "cr_1"."model",
            "cr_1"."model_hash",
            "cr_1"."confidence",
            "cr_1"."raw_response",
            "cr_1"."record_id",
            "cr_1"."source_table",
            "cr_1"."summary",
            "cr_1"."created_at",
            "cr_1"."updated_at"
           FROM "public"."compliance_reviews" "cr_1"
          WHERE ("cr_1"."obligation_id" = "o"."id")
          ORDER BY "cr_1"."review_date" DESC
         LIMIT 1) "cr" ON (true));


ALTER VIEW "public"."v_iso_compliance_overview" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_iso_control_schedule" AS
 SELECT "o"."id" AS "obligation_id",
    "e"."id" AS "entity_id",
    "e"."name" AS "entity_name",
    "ic"."standard" AS "iso_standard",
    "ic"."clause" AS "iso_clause",
    "ic"."title" AS "iso_clause_title",
    "o"."description" AS "obligation_description",
    "o"."control_owner",
    "o"."review_frequency",
    "o"."next_review_date",
    "r"."review_date" AS "last_review_at",
    "r"."overall_status" AS "last_overall_status",
        CASE
            WHEN ("o"."next_review_date" IS NULL) THEN 'unscheduled'::"text"
            WHEN ("o"."next_review_date" < CURRENT_DATE) THEN 'overdue'::"text"
            WHEN (("o"."next_review_date" >= CURRENT_DATE) AND ("o"."next_review_date" <= (CURRENT_DATE + '30 days'::interval))) THEN 'due_soon'::"text"
            ELSE 'scheduled'::"text"
        END AS "schedule_status"
   FROM ((("public"."compliance_obligations" "o"
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "o"."entity_id")))
     LEFT JOIN "public"."iso_clauses" "ic" ON (("ic"."id" = "o"."iso_clause_id")))
     LEFT JOIN LATERAL ( SELECT "cr"."id",
            "cr"."obligation_id",
            "cr"."review_date",
            "cr"."compliant",
            "cr"."risk_level",
            "cr"."ai_summary",
            "cr"."resolution_id",
            "cr"."review_day",
            "cr"."issues",
            "cr"."actions",
            "cr"."notes",
            "cr"."overall_status",
            "cr"."checked_at",
            "cr"."ai_source",
            "cr"."model_id",
            "cr"."model",
            "cr"."model_hash",
            "cr"."confidence",
            "cr"."raw_response",
            "cr"."record_id",
            "cr"."source_table",
            "cr"."summary",
            "cr"."created_at",
            "cr"."updated_at"
           FROM "public"."compliance_reviews" "cr"
          WHERE ("cr"."obligation_id" = "o"."id")
          ORDER BY "cr"."review_date" DESC
         LIMIT 1) "r" ON (true));


ALTER VIEW "public"."v_iso_control_schedule" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_iso_obligations_dashboard" AS
 SELECT "o"."id" AS "obligation_id",
    "e"."id" AS "entity_id",
    "e"."name" AS "entity_name",
    "ic"."standard",
    "ic"."clause" AS "clause_ref",
    "ic"."title" AS "clause_title",
    "o"."description" AS "control_description",
    "o"."control_owner",
    "o"."status" AS "obligation_status",
    "o"."review_frequency",
    "o"."next_review_date",
    "r"."review_date" AS "last_review_at",
    "r"."compliant" AS "last_compliant",
    "r"."risk_level" AS "last_risk_level",
    "r"."overall_status" AS "last_overall_status"
   FROM ((("public"."compliance_obligations" "o"
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "o"."entity_id")))
     LEFT JOIN "public"."iso_clauses" "ic" ON (("ic"."id" = "o"."iso_clause_id")))
     LEFT JOIN LATERAL ( SELECT "cr"."id",
            "cr"."obligation_id",
            "cr"."review_date",
            "cr"."compliant",
            "cr"."risk_level",
            "cr"."ai_summary",
            "cr"."resolution_id",
            "cr"."review_day",
            "cr"."issues",
            "cr"."actions",
            "cr"."notes",
            "cr"."overall_status",
            "cr"."checked_at",
            "cr"."ai_source",
            "cr"."model_id",
            "cr"."model",
            "cr"."model_hash",
            "cr"."confidence",
            "cr"."raw_response",
            "cr"."record_id",
            "cr"."source_table",
            "cr"."summary",
            "cr"."created_at",
            "cr"."updated_at"
           FROM "public"."compliance_reviews" "cr"
          WHERE ("cr"."obligation_id" = "o"."id")
          ORDER BY "cr"."review_date" DESC
         LIMIT 1) "r" ON (true));


ALTER VIEW "public"."v_iso_obligations_dashboard" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_iso_obligations_status" AS
 SELECT "o"."id" AS "obligation_id",
    "e"."slug" AS "entity_slug",
    "e"."name" AS "entity_name",
    "ic"."standard",
    "ic"."clause",
    "ic"."title" AS "iso_title",
    "o"."description",
    "o"."control_owner",
    "o"."review_frequency",
    "o"."next_review_date",
    "o"."status" AS "obligation_status",
    ("o"."next_review_date" - CURRENT_DATE) AS "days_until_due",
        CASE
            WHEN ("o"."next_review_date" < CURRENT_DATE) THEN 'overdue'::"text"
            WHEN ("o"."next_review_date" = CURRENT_DATE) THEN 'due_today'::"text"
            WHEN ("o"."next_review_date" <= (CURRENT_DATE + '7 days'::interval)) THEN 'due_soon'::"text"
            ELSE 'scheduled'::"text"
        END AS "due_bucket"
   FROM (("public"."compliance_obligations" "o"
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "o"."entity_id")))
     LEFT JOIN "public"."iso_clauses" "ic" ON (("ic"."id" = "o"."iso_clause_id")));


ALTER VIEW "public"."v_iso_obligations_status" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_iso_risk_matrix" AS
 SELECT "e"."id" AS "entity_id",
    "e"."name" AS "entity_name",
    "ic"."standard" AS "iso_standard",
    "ic"."clause" AS "iso_clause",
    "cr"."risk_level",
    "count"(*) AS "review_count",
    "count"(*) FILTER (WHERE "cr"."compliant") AS "compliant_count",
    "count"(*) FILTER (WHERE (NOT "cr"."compliant")) AS "non_compliant_count"
   FROM ((("public"."compliance_reviews" "cr"
     LEFT JOIN "public"."compliance_obligations" "o" ON (("o"."id" = "cr"."obligation_id")))
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "o"."entity_id")))
     LEFT JOIN "public"."iso_clauses" "ic" ON (("ic"."id" = "o"."iso_clause_id")))
  GROUP BY "e"."id", "e"."name", "ic"."standard", "ic"."clause", "cr"."risk_level";


ALTER VIEW "public"."v_iso_risk_matrix" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_latest_notes" AS
 SELECT "n"."id",
    "n"."scope_type",
    "n"."scope_id",
    "n"."note_type",
    "n"."title",
    "n"."content",
    "n"."model",
    "n"."tokens_used",
    "n"."source_doc_ids",
    "n"."created_by",
    "n"."created_at",
    "s"."name" AS "section_name",
    "b"."book_name",
    "e"."name" AS "entity_name"
   FROM ((("public"."ai_notes" "n"
     LEFT JOIN "public"."sections" "s" ON ((("n"."scope_type" = 'section'::"public"."note_scope_type") AND ("s"."id" = "n"."scope_id"))))
     LEFT JOIN "public"."books" "b" ON (("b"."id" = "s"."entity_id")))
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "b"."entity_id")));


ALTER VIEW "public"."v_latest_notes" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_legal_briefs" AS
 SELECT "code_name",
    "concat"("code_name", ' ', "citation", ' — ', "summary") AS "brief",
    "jurisdiction"
   FROM "public"."legal_sources";


ALTER VIEW "public"."v_legal_briefs" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_menu_categories" WITH ("security_invoker"='on') AS
 SELECT "category",
    "count"(*) AS "item_count"
   FROM "public"."menu_publish_items"
  WHERE ("is_published" IS TRUE)
  GROUP BY "category"
  ORDER BY "category";


ALTER VIEW "public"."v_menu_categories" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_menu_item_ratings" AS
 SELECT "menu_item_id",
    "round"("avg"("rating"), 2) AS "avg_rating",
    "count"(*) AS "review_count"
   FROM "public"."reviews" "r"
  WHERE ("status" = 'approved'::"text")
  GROUP BY "menu_item_id";


ALTER VIEW "public"."v_menu_item_ratings" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_menu_list" WITH ("security_invoker"='on') AS
 SELECT "publish_id",
    "menu_item_id",
    "category",
    "name",
    "description",
    "photo_url",
    "price_minor",
    "currency",
    "round"((("price_minor")::numeric / 100.0), 2) AS "price",
    "to_char"((("price_minor")::numeric / 100.0), 'FM999,990D00'::"text") AS "formatted_price",
    "lang",
    "is_published"
   FROM "public"."menu_publish_items" "mpi"
  WHERE ("is_published" IS TRUE)
  ORDER BY "category", "name";


ALTER VIEW "public"."v_menu_list" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_menu_list_with_ratings" AS
 SELECT "l"."publish_id",
    "l"."menu_item_id",
    "l"."category",
    "l"."name",
    "l"."description",
    "l"."photo_url",
    "l"."price_minor",
    "l"."currency",
    "l"."price",
    "l"."formatted_price",
    "l"."lang",
    "l"."is_published",
    COALESCE("v"."avg_rating", (0)::numeric) AS "avg_rating",
    COALESCE("v"."review_count", (0)::bigint) AS "review_count"
   FROM ("public"."v_menu_list" "l"
     LEFT JOIN "public"."v_menu_item_ratings" "v" ON (("v"."menu_item_id" = "l"."menu_item_id")));


ALTER VIEW "public"."v_menu_list_with_ratings" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_metadata_briefs" AS
 SELECT "ref_code",
    "concat"("title", ' — ', COALESCE("jurisdiction", ''::"text")) AS "brief",
    "category",
    "source_url"
   FROM "public"."metadata_sources"
  ORDER BY "ref_code";


ALTER VIEW "public"."v_metadata_briefs" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_minute_book_all_documents" AS
 SELECT "ent"."id" AS "entity_id",
    "ent"."slug" AS "entity_slug",
    "ent"."name" AS "entity_name",
    "e"."id" AS "entry_id",
    "e"."entry_date",
    "e"."section_name" AS "entry_type",
    "e"."title" AS "entry_title",
    "e"."notes" AS "entry_notes",
    "e"."id" AS "document_id",
    "e"."section_name" AS "doc_section",
    "regexp_replace"("e"."storage_path", '^.*/'::"text", ''::"text") AS "doc_file_name",
    "e"."storage_path" AS "doc_file_path",
    "e"."created_at" AS "doc_uploaded_at",
    NULL::bigint AS "doc_file_size",
    NULL::"text" AS "doc_mime_type",
    NULL::"text" AS "doc_file_hash"
   FROM ("public"."minute_book_entries" "e"
     LEFT JOIN "public"."entities" "ent" ON (("ent"."slug" = ("e"."entity_key")::"text")));


ALTER VIEW "public"."v_minute_book_all_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_minute_book_documents" AS
 SELECT "d"."id",
    "d"."record_id",
    "gl"."entity_id",
    "e"."slug" AS "entity_slug",
    "gl"."title" AS "record_title",
    "gl"."record_type",
    "d"."file_name",
    "d"."doc_type",
    "d"."mime_type",
    "d"."storage_path",
    "d"."created_at",
    "d"."metadata"
   FROM (("public"."governance_documents" "d"
     LEFT JOIN "public"."governance_ledger" "gl" ON (("gl"."id" = "d"."record_id")))
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "gl"."entity_id")))
  WHERE ("d"."storage_path" !~~ '%/signing/envelopes/%'::"text");


ALTER VIEW "public"."v_minute_book_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_minute_book_entries_with_docs" AS
 SELECT "mbe"."id" AS "entry_id",
    "mbe"."entity_key",
    "mbe"."entry_date",
    "mbe"."entry_type",
    "mbe"."title" AS "entry_title",
    "mbe"."section_name",
    "mbe"."file_name" AS "primary_file_name",
    "mbe"."storage_path" AS "primary_storage_path",
    "mbe"."owner_id" AS "entry_owner_id",
    "mbe"."created_at" AS "entry_created_at",
    "mbe"."updated_at" AS "entry_updated_at",
    "sd"."id" AS "supporting_id",
    "sd"."file_name" AS "supporting_file_name",
    "sd"."file_path" AS "supporting_storage_path",
    "sd"."doc_type" AS "supporting_doc_type",
    "sd"."mime_type" AS "supporting_mime_type",
    "sd"."file_size" AS "supporting_file_size",
    "sd"."file_hash" AS "supporting_file_hash",
    "sd"."version" AS "supporting_version",
    "sd"."signature_envelope_id" AS "supporting_envelope_id",
    "sd"."uploaded_by" AS "supporting_uploaded_by",
    "sd"."uploaded_at" AS "supporting_uploaded_at",
    "sd"."metadata" AS "supporting_metadata"
   FROM ("public"."minute_book_entries" "mbe"
     LEFT JOIN "public"."supporting_documents" "sd" ON (("sd"."entry_id" = "mbe"."id")))
  ORDER BY "mbe"."entry_date" DESC, "sd"."uploaded_at" DESC NULLS LAST;


ALTER VIEW "public"."v_minute_book_entries_with_docs" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_minute_book_misplaced" AS
 SELECT "entity_key",
    "section_name",
    "file_name",
    "storage_path",
    "created_at"
   FROM "public"."minute_book_entries"
  WHERE ("substring"("section_name", '^\s*([0-9]+(?:\.[0-9]+)?)'::"text") IS NULL)
  ORDER BY "entity_key", ("lower"("section_name")), ("lower"("file_name"));


ALTER VIEW "public"."v_minute_book_misplaced" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_minute_book_ordered" AS
 SELECT "entity_key",
    "section_name",
    "file_name",
    "storage_path",
    "created_at",
    "substring"("section_name", '^\s*([0-9]+(?:\.[0-9]+)?)'::"text") AS "section_num_text",
    ("substring"("section_name", '^\s*([0-9]+(?:\.[0-9]+)?)'::"text"))::numeric AS "section_num"
   FROM "public"."minute_book_entries";


ALTER VIEW "public"."v_minute_book_ordered" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_minute_book_section_health" AS
 WITH "entries" AS (
         SELECT "minute_book_entries"."entity_key",
            "minute_book_entries"."section_name",
            "minute_book_entries"."file_name",
            "substring"("minute_book_entries"."section_name", '^\s*([0-9]+(?:\.[0-9]+)?)'::"text") AS "section_num_text",
            ("substring"("minute_book_entries"."section_name", '^\s*([0-9]+(?:\.[0-9]+)?)'::"text"))::numeric AS "section_num"
           FROM "public"."minute_book_entries"
        ), "agg" AS (
         SELECT "entries"."entity_key",
            "entries"."section_num",
            "count"(*) AS "files_count",
            "min"("entries"."section_name") AS "sample_section_name"
           FROM "entries"
          WHERE ("entries"."section_num" IS NOT NULL)
          GROUP BY "entries"."entity_key", "entries"."section_num"
        ), "expected" AS (
         SELECT "t"."section_num_expected",
            "t"."section_label"
           FROM ( VALUES (0.0,'0. Cover & Master TOC'::"text"), (1.0,'1. Certificate & Articles'::"text"), (2.0,'2. Corporate Profile'::"text"), (3.0,'3. Initial Return & Notice of Change'::"text"), (4.0,'4. Annual Returns'::"text"), (5.0,'5. Registers & Ledgers'::"text"), (6.0,'6. Resolutions'::"text"), (7.0,'7. By-Laws'::"text"), (8.0,'8. Share Certificates'::"text"), (9.0,'9. Corporate Seal'::"text"), (10.0,'10. Compliance / Operations / Misc'::"text"), (11.0,'11. Agreements & Contracts'::"text"), (12.0,'12. Trade & Supply Chain / Equitable Bank / etc'::"text"), (13.0,'13. Operational Annexes / Insurance'::"text"), (14.0,'14. Appraisals / Treasury / Domain / Branding / Menu / Uniforms / Presentation'::"text")) "t"("section_num_expected", "section_label")
        ), "entities" AS (
         SELECT DISTINCT "minute_book_entries"."entity_key"
           FROM "public"."minute_book_entries"
        )
 SELECT "e"."entity_key",
    "x"."section_num_expected",
    "x"."section_label",
    "a"."sample_section_name" AS "actual_section_name",
    COALESCE("a"."files_count", (0)::bigint) AS "files_count",
        CASE
            WHEN ("a"."section_num" IS NULL) THEN 'MISSING'::"text"
            WHEN ("a"."files_count" = 0) THEN 'EMPTY'::"text"
            ELSE 'OK'::"text"
        END AS "status"
   FROM (("entities" "e"
     CROSS JOIN "expected" "x")
     LEFT JOIN "agg" "a" ON ((("a"."entity_key" = "e"."entity_key") AND ("a"."section_num" = "x"."section_num_expected"))))
  ORDER BY "e"."entity_key", "x"."section_num_expected";


ALTER VIEW "public"."v_minute_book_section_health" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_minute_book_status" AS
 SELECT "id",
    "entity_id",
    "title",
    "record_type",
    "needs_summary",
    "summarized",
    "approved",
    "archived",
    "created_at",
        CASE
            WHEN "archived" THEN 'Archived'::"text"
            WHEN "approved" THEN 'Approved'::"text"
            WHEN "summarized" THEN 'Summarized'::"text"
            WHEN "needs_summary" THEN 'Pending Summary'::"text"
            ELSE 'Draft'::"text"
        END AS "status_label"
   FROM "public"."governance_ledger"
  ORDER BY "created_at" DESC;


ALTER VIEW "public"."v_minute_book_status" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_minute_book_with_documents" AS
 SELECT "mbe"."id" AS "entry_id",
    "mbe"."entity_key",
    "mbe"."entry_type",
    "mbe"."entry_date",
    "mbe"."title",
    "mbe"."notes",
    "mbe"."owner_id",
    "mbe"."created_at",
    "mbe"."updated_at",
    "mbe"."file_name" AS "entry_file_name",
    "mbe"."storage_path" AS "entry_storage_path",
    "mbe"."section_name" AS "entry_section_name",
    "sd"."id" AS "supporting_document_id",
    "sd"."file_name" AS "supporting_file_name",
    "sd"."file_path" AS "supporting_file_path",
    "sd"."doc_type" AS "supporting_doc_type",
    "sd"."mime_type" AS "supporting_mime_type",
    "sd"."file_size" AS "supporting_file_size",
    "sd"."uploaded_at" AS "supporting_uploaded_at",
    "sd"."uploaded_by" AS "supporting_uploaded_by",
    "sd"."section" AS "supporting_section",
    "sd"."version" AS "supporting_version",
    "sd"."signature_envelope_id" AS "supporting_envelope_id",
    "sd"."metadata" AS "supporting_metadata"
   FROM ("public"."minute_book_entries" "mbe"
     LEFT JOIN "public"."supporting_documents" "sd" ON (("sd"."entry_id" = "mbe"."id")))
  ORDER BY "mbe"."entry_date" DESC, "sd"."uploaded_at" DESC;


ALTER VIEW "public"."v_minute_book_with_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_oasis_all_documents" AS
 SELECT 'minute_book_entry'::"text" AS "source",
    NULL::"uuid" AS "entity_id",
    ("mbe"."entity_key")::"text" AS "entity_key",
    NULL::"text" AS "entity_slug",
    "mbe"."id" AS "entry_id",
    NULL::"uuid" AS "record_id",
    NULL::"uuid" AS "envelope_id",
    "mbe"."file_name",
    "mbe"."storage_path",
    NULL::"text" AS "doc_type",
    NULL::"text" AS "mime_type",
    NULL::bigint AS "file_size",
    "mbe"."owner_id" AS "uploaded_by",
    "mbe"."created_at" AS "uploaded_at",
    "mbe"."title" AS "entry_title",
    "mbe"."entry_date",
    ("mbe"."entry_type")::"text" AS "entry_type",
    "mbe"."section_name",
    "mbe"."notes",
    "mbe"."created_at",
    "mbe"."updated_at",
    '{}'::"jsonb" AS "metadata"
   FROM "public"."minute_book_entries" "mbe"
UNION ALL
 SELECT 'minute_book_supporting'::"text" AS "source",
    NULL::"uuid" AS "entity_id",
    ("sd"."entity_key")::"text" AS "entity_key",
    NULL::"text" AS "entity_slug",
    "sd"."entry_id",
    NULL::"uuid" AS "record_id",
    "sd"."signature_envelope_id" AS "envelope_id",
    "sd"."file_name",
    "sd"."file_path" AS "storage_path",
    "sd"."doc_type",
    "sd"."mime_type",
    "sd"."file_size",
    "sd"."uploaded_by",
    "sd"."uploaded_at",
    "mbe"."title" AS "entry_title",
    "mbe"."entry_date",
    ("mbe"."entry_type")::"text" AS "entry_type",
    ("sd"."section")::"text" AS "section_name",
    NULL::"text" AS "notes",
    "sd"."uploaded_at" AS "created_at",
    "sd"."uploaded_at" AS "updated_at",
    '{}'::"jsonb" AS "metadata"
   FROM ("public"."supporting_documents" "sd"
     LEFT JOIN "public"."minute_book_entries" "mbe" ON (("mbe"."id" = "sd"."entry_id")))
UNION ALL
 SELECT 'governance_document'::"text" AS "source",
    "gl"."entity_id",
    NULL::"text" AS "entity_key",
    "ent"."slug" AS "entity_slug",
    "gl"."id" AS "entry_id",
    "gd"."record_id",
    "gd"."envelope_id",
    "gd"."file_name",
    "gd"."storage_path",
    "gd"."doc_type",
    "gd"."mime_type",
    "gd"."file_size",
    "gd"."uploaded_by",
    "gd"."created_at" AS "uploaded_at",
    "gl"."title" AS "entry_title",
    ("gl"."created_at")::"date" AS "entry_date",
    "gl"."record_type" AS "entry_type",
    NULL::"text" AS "section_name",
    "gl"."description" AS "notes",
    "gd"."created_at",
    "gd"."created_at" AS "updated_at",
    "gd"."metadata"
   FROM (("public"."governance_documents" "gd"
     LEFT JOIN "public"."governance_ledger" "gl" ON (("gl"."id" = "gd"."record_id")))
     LEFT JOIN "public"."entities" "ent" ON (("ent"."id" = "gl"."entity_id")));


ALTER VIEW "public"."v_oasis_all_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_orb_state" AS
 SELECT "id" AS "entity_id",
    "slug" AS "entity_slug",
        CASE
            WHEN ((EXISTS ( SELECT 1
               FROM "public"."compliance_obligations" "co"
              WHERE (("co"."entity_id" = "e"."id") AND ("co"."status" = 'at_risk'::"text")))) OR (EXISTS ( SELECT 1
               FROM ("public"."compliance_reviews" "cr"
                 JOIN "public"."compliance_obligations" "co" ON (("co"."id" = "cr"."obligation_id")))
              WHERE (("co"."entity_id" = "e"."id") AND ("cr"."overall_status" = ANY (ARRAY['at_risk'::"text", 'escalated'::"text"]))))) OR (EXISTS ( SELECT 1
               FROM "public"."governance_ledger" "gl"
              WHERE (("gl"."entity_id" = "e"."id") AND ("gl"."compliance_status" = ANY (ARRAY['at_risk'::"text", 'escalated'::"text"]))))) OR (EXISTS ( SELECT 1
               FROM "public"."signature_envelopes" "se"
              WHERE (("se"."entity_id" = "e"."id") AND ("se"."status" = ANY (ARRAY['expired'::"text", 'cancelled'::"text"]))))) OR (EXISTS ( SELECT 1
               FROM "public"."governance_violations" "gv"
              WHERE (("gv"."entity_id" = "e"."id") AND ("gv"."status" = ANY (ARRAY['open'::"text", 'in_review'::"text", 'waived'::"text"])))))) THEN 'ALERT'::"text"
            WHEN ((EXISTS ( SELECT 1
               FROM ("public"."ai_sentinel_tasks" "st"
                 JOIN "public"."governance_ledger" "gl" ON (("gl"."id" = "st"."record_id")))
              WHERE (("gl"."entity_id" = "e"."id") AND ("st"."status" = ANY (ARRAY['pending'::"text", 'error'::"text"]))))) OR (EXISTS ( SELECT 1
               FROM "public"."governance_ledger" "gl"
              WHERE (("gl"."entity_id" = "e"."id") AND ("gl"."ai_status" = ANY (ARRAY['pending'::"text", 'error'::"text"]))))) OR (EXISTS ( SELECT 1
               FROM "public"."signature_envelopes" "se"
              WHERE (("se"."entity_id" = "e"."id") AND ("se"."status" = 'pending'::"text")))) OR (EXISTS ( SELECT 1
               FROM "public"."compliance_obligations" "co"
              WHERE (("co"."entity_id" = "e"."id") AND ("co"."status" = ANY (ARRAY['open'::"text", 'in_progress'::"text", 'compliant'::"text"])))))) THEN 'THINK'::"text"
            ELSE 'REST'::"text"
        END AS "orb_state",
        CASE
            WHEN ((EXISTS ( SELECT 1
               FROM "public"."compliance_obligations" "co"
              WHERE (("co"."entity_id" = "e"."id") AND ("co"."status" = 'at_risk'::"text")))) OR (EXISTS ( SELECT 1
               FROM ("public"."compliance_reviews" "cr"
                 JOIN "public"."compliance_obligations" "co" ON (("co"."id" = "cr"."obligation_id")))
              WHERE (("co"."entity_id" = "e"."id") AND ("cr"."overall_status" = ANY (ARRAY['at_risk'::"text", 'escalated'::"text"]))))) OR (EXISTS ( SELECT 1
               FROM "public"."governance_ledger" "gl"
              WHERE (("gl"."entity_id" = "e"."id") AND ("gl"."compliance_status" = ANY (ARRAY['at_risk'::"text", 'escalated'::"text"]))))) OR (EXISTS ( SELECT 1
               FROM "public"."signature_envelopes" "se"
              WHERE (("se"."entity_id" = "e"."id") AND ("se"."status" = ANY (ARRAY['expired'::"text", 'cancelled'::"text"]))))) OR (EXISTS ( SELECT 1
               FROM "public"."governance_violations" "gv"
              WHERE (("gv"."entity_id" = "e"."id") AND ("gv"."status" = ANY (ARRAY['open'::"text", 'in_review'::"text", 'waived'::"text"])))))) THEN 2
            WHEN ((EXISTS ( SELECT 1
               FROM ("public"."ai_sentinel_tasks" "st"
                 JOIN "public"."governance_ledger" "gl" ON (("gl"."id" = "st"."record_id")))
              WHERE (("gl"."entity_id" = "e"."id") AND ("st"."status" = ANY (ARRAY['pending'::"text", 'error'::"text"]))))) OR (EXISTS ( SELECT 1
               FROM "public"."governance_ledger" "gl"
              WHERE (("gl"."entity_id" = "e"."id") AND ("gl"."ai_status" = ANY (ARRAY['pending'::"text", 'error'::"text"]))))) OR (EXISTS ( SELECT 1
               FROM "public"."signature_envelopes" "se"
              WHERE (("se"."entity_id" = "e"."id") AND ("se"."status" = 'pending'::"text")))) OR (EXISTS ( SELECT 1
               FROM "public"."compliance_obligations" "co"
              WHERE (("co"."entity_id" = "e"."id") AND ("co"."status" = ANY (ARRAY['open'::"text", 'in_progress'::"text", 'compliant'::"text"])))))) THEN 1
            ELSE 0
        END AS "orb_severity"
   FROM "public"."entities" "e";


ALTER VIEW "public"."v_orb_state" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_orb_state_global" AS
 SELECT 'global'::"text" AS "scope",
        CASE
            WHEN (EXISTS ( SELECT 1
               FROM "public"."v_orb_state" "s"
              WHERE ("s"."orb_state" = 'ALERT'::"text"))) THEN 'ALERT'::"text"
            WHEN (EXISTS ( SELECT 1
               FROM "public"."v_orb_state" "s"
              WHERE ("s"."orb_state" = 'THINK'::"text"))) THEN 'THINK'::"text"
            ELSE 'REST'::"text"
        END AS "orb_state";


ALTER VIEW "public"."v_orb_state_global" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_record_documents" AS
 SELECT "id" AS "document_id",
    "record_id",
    "file_name",
    "doc_type",
    "storage_path",
    "mime_type",
    "envelope_id",
    "created_at",
    "metadata"
   FROM "public"."governance_documents" "d"
  ORDER BY "created_at" DESC;


ALTER VIEW "public"."v_record_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_registry_ledger_entries" AS
 WITH "latest_doc" AS (
         SELECT "gd"."record_id",
            "gd"."id" AS "document_id",
            "gd"."storage_path",
            "gd"."file_name",
            "gd"."file_hash",
            "gd"."file_size",
            "gd"."status" AS "document_status",
            "gd"."executed_at",
            "row_number"() OVER (PARTITION BY "gd"."record_id" ORDER BY "gd"."version" DESC, "gd"."created_at" DESC) AS "rn"
           FROM "public"."governance_documents" "gd"
        )
 SELECT "gl"."id" AS "record_id",
    'governance_ledger'::"text" AS "source_table",
    COALESCE("gl"."record_no", ("gl"."id")::"text") AS "registry_id",
    "gl"."record_type" AS "instrument_type",
    "gl"."title",
    "gl"."description",
    "gl"."status" AS "record_status",
    "gl"."compliance_status",
    "gl"."created_at" AS "registered_at",
    "gl"."entity_id",
    "e"."slug" AS "entity_slug",
    "e"."name" AS "entity_name",
    "ld"."document_id",
    "ld"."storage_path",
    "ld"."file_name",
    "ld"."file_hash",
    "ld"."file_size",
    "ld"."document_status",
    "ld"."executed_at",
        CASE
            WHEN ("gl"."status" = 'SIGNED'::"text") THEN 'active'::"text"
            WHEN ("gl"."status" = 'ARCHIVED'::"text") THEN 'archived'::"text"
            WHEN ("gl"."status" = 'REJECTED'::"text") THEN 'void'::"text"
            ELSE "lower"("gl"."status")
        END AS "registry_status",
    (EXISTS ( SELECT 1
           FROM "public"."governance_documents" "cert"
          WHERE (("cert"."record_id" = "gl"."id") AND ("cert"."doc_type" = 'certificate'::"text")))) AS "has_certificate"
   FROM (("public"."governance_ledger" "gl"
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "gl"."entity_id")))
     LEFT JOIN "latest_doc" "ld" ON ((("ld"."record_id" = "gl"."id") AND ("ld"."rn" = 1))))
  WHERE ("gl"."record_type" = ANY (ARRAY['resolution'::"text", 'meeting'::"text", 'decision'::"text"]));


ALTER VIEW "public"."v_registry_ledger_entries" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_registry_minute_book_entries" AS
 WITH "primary_doc" AS (
         SELECT "sd"."entry_id",
            "sd"."id" AS "document_id",
            "sd"."file_path" AS "storage_path",
            "sd"."file_name",
            "sd"."file_hash",
            "sd"."file_size",
            "row_number"() OVER (PARTITION BY "sd"."entry_id" ORDER BY "sd"."version" DESC, "sd"."uploaded_at" DESC) AS "rn"
           FROM "public"."supporting_documents" "sd"
        )
 SELECT "mbe"."id" AS "record_id",
    'minute_book_entries'::"text" AS "source_table",
    ("mbe"."id")::"text" AS "registry_id",
    ("mbe"."entry_type")::"text" AS "instrument_type",
    "mbe"."title",
    "mbe"."notes" AS "description",
    'historic'::"text" AS "record_status",
    NULL::"text" AS "compliance_status",
    "mbe"."created_at" AS "registered_at",
    NULL::"uuid" AS "entity_id",
    NULL::"text" AS "entity_slug",
    ("mbe"."entity_key")::"text" AS "entity_name",
    "pd"."document_id",
    "pd"."storage_path",
    "pd"."file_name",
    "pd"."file_hash",
    "pd"."file_size",
    NULL::"text" AS "document_status",
    NULL::timestamp with time zone AS "executed_at",
    'active'::"text" AS "registry_status",
    false AS "has_certificate"
   FROM ("public"."minute_book_entries" "mbe"
     LEFT JOIN "primary_doc" "pd" ON ((("pd"."entry_id" = "mbe"."id") AND ("pd"."rn" = 1))));


ALTER VIEW "public"."v_registry_minute_book_entries" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_registry_all_entries" AS
 SELECT "re"."record_id",
    "re"."source_table",
    "re"."registry_id",
    "re"."instrument_type",
    "re"."title",
    "re"."description",
    "re"."record_status",
    "re"."compliance_status",
    "re"."registered_at",
    "re"."entity_id",
    "re"."entity_slug",
    "re"."entity_name",
    "re"."document_id",
    "re"."storage_path",
    "re"."file_name",
    "re"."file_hash",
    "re"."file_size",
    ("re"."document_status")::"text" AS "document_status",
    "re"."executed_at",
    "re"."registry_status",
    "re"."has_certificate"
   FROM "public"."v_registry_ledger_entries" "re"
UNION ALL
 SELECT "mbe"."record_id",
    "mbe"."source_table",
    "mbe"."registry_id",
    "mbe"."instrument_type",
    "mbe"."title",
    "mbe"."description",
    "mbe"."record_status",
    "mbe"."compliance_status",
    "mbe"."registered_at",
    "mbe"."entity_id",
    "mbe"."entity_slug",
    "mbe"."entity_name",
    "mbe"."document_id",
    "mbe"."storage_path",
    "mbe"."file_name",
    "mbe"."file_hash",
    "mbe"."file_size",
    "mbe"."document_status",
    "mbe"."executed_at",
    "mbe"."registry_status",
    "mbe"."has_certificate"
   FROM "public"."v_registry_minute_book_entries" "mbe";


ALTER VIEW "public"."v_registry_all_entries" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_resolution_compliance_ai" AS
 SELECT "gl"."id" AS "record_id",
    "gl"."title" AS "record_title",
    "gl"."entity_id",
    "e"."name" AS "entity_name",
    "r"."id" AS "resolution_id",
    "r"."compliance_status" AS "resolution_compliance_status",
    "ic"."standard" AS "iso_standard",
    "ic"."clause" AS "iso_clause_ref",
    "ic"."title" AS "iso_clause_title",
    "cr"."id" AS "review_id",
    "cr"."review_date",
    "cr"."risk_level",
    "cr"."compliant",
    "cr"."overall_status" AS "review_overall_status",
    "s"."summary" AS "ai_summary",
    "an"."analysis" AS "ai_analysis",
    "ad"."advice" AS "ai_advice",
    "ad"."recommendation" AS "ai_recommendation"
   FROM ((((((("public"."governance_ledger" "gl"
     LEFT JOIN "public"."entities" "e" ON (("e"."id" = "gl"."entity_id")))
     LEFT JOIN "public"."resolutions" "r" ON (("r"."id" = "gl"."id")))
     LEFT JOIN "public"."iso_clauses" "ic" ON (("ic"."id" = "r"."iso_clause_id")))
     LEFT JOIN LATERAL ( SELECT "cr_1"."id",
            "cr_1"."obligation_id",
            "cr_1"."review_date",
            "cr_1"."compliant",
            "cr_1"."risk_level",
            "cr_1"."ai_summary",
            "cr_1"."resolution_id",
            "cr_1"."review_day",
            "cr_1"."issues",
            "cr_1"."actions",
            "cr_1"."notes",
            "cr_1"."overall_status",
            "cr_1"."checked_at",
            "cr_1"."ai_source",
            "cr_1"."model_id",
            "cr_1"."model",
            "cr_1"."model_hash",
            "cr_1"."confidence",
            "cr_1"."raw_response",
            "cr_1"."record_id",
            "cr_1"."source_table",
            "cr_1"."summary",
            "cr_1"."created_at",
            "cr_1"."updated_at"
           FROM "public"."compliance_reviews" "cr_1"
          WHERE ("cr_1"."record_id" = "gl"."id")
          ORDER BY "cr_1"."review_date" DESC
         LIMIT 1) "cr" ON (true))
     LEFT JOIN LATERAL ( SELECT "s_1"."id",
            "s_1"."record_id",
            "s_1"."summary",
            "s_1"."ai_source",
            "s_1"."model_id",
            "s_1"."model_hash",
            "s_1"."generated_at",
            "s_1"."upgraded_at",
            "s_1"."confidence",
            "s_1"."source_table",
            "s_1"."model",
            "s_1"."raw_response"
           FROM "public"."ai_summaries" "s_1"
          WHERE ("s_1"."record_id" = "gl"."id")
          ORDER BY "s_1"."generated_at" DESC
         LIMIT 1) "s" ON (true))
     LEFT JOIN LATERAL ( SELECT "a"."id",
            "a"."record_id",
            "a"."analysis",
            "a"."ai_source",
            "a"."model_id",
            "a"."model_hash",
            "a"."generated_at",
            "a"."confidence",
            "a"."model",
            "a"."raw_response"
           FROM "public"."ai_analyses" "a"
          WHERE ("a"."record_id" = "gl"."id")
          ORDER BY "a"."generated_at" DESC
         LIMIT 1) "an" ON (true))
     LEFT JOIN LATERAL ( SELECT "ad_1"."id",
            "ad_1"."record_id",
            "ad_1"."recommendation",
            "ad_1"."risk_rating",
            "ad_1"."confidence",
            "ad_1"."ai_source",
            "ad_1"."model_id",
            "ad_1"."model_hash",
            "ad_1"."generated_at",
            "ad_1"."advice"
           FROM "public"."ai_advice" "ad_1"
          WHERE ("ad_1"."record_id" = "gl"."id")
          ORDER BY "ad_1"."generated_at" DESC
         LIMIT 1) "ad" ON (true));


ALTER VIEW "public"."v_resolution_compliance_ai" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_resolution_status_timeline" AS
 SELECT "h"."id" AS "history_id",
    "h"."resolution_id",
    "r"."entity_id",
    "r"."title",
    "r"."status" AS "current_status",
    "h"."old_status",
    "h"."new_status",
    "h"."reason",
    "h"."changed_by",
    "h"."changed_at",
    "h"."context",
    "r"."created_at" AS "resolution_created_at"
   FROM ("public"."resolution_status_history" "h"
     JOIN "public"."resolutions" "r" ON (("r"."id" = "h"."resolution_id")))
  ORDER BY "h"."changed_at" DESC;


ALTER VIEW "public"."v_resolution_status_timeline" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_resolutions_picklist" AS
 SELECT "id",
    "title"
   FROM "public"."resolutions"
  ORDER BY "created_at";


ALTER VIEW "public"."v_resolutions_picklist" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_resolutions_with_documents" AS
 SELECT "r"."id" AS "resolution_id",
    "r"."title" AS "resolution_title",
    "r"."status",
    "r"."entity_id",
    "gl"."id" AS "record_id",
    "gl"."title" AS "record_title",
    "d"."id" AS "document_id",
    "d"."file_name",
    "d"."doc_type",
    "d"."storage_path",
    "d"."version",
    "d"."file_hash",
    "d"."created_at" AS "document_created_at"
   FROM (("public"."resolutions" "r"
     LEFT JOIN "public"."governance_ledger" "gl" ON (("gl"."id" = "r"."minute_book_id")))
     LEFT JOIN "public"."governance_documents" "d" ON (("d"."record_id" = "gl"."id")))
  ORDER BY "r"."created_at" DESC, "d"."created_at" DESC;


ALTER VIEW "public"."v_resolutions_with_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_schema_amendments_with_approvals" AS
 SELECT "scl"."id" AS "change_id",
    "scl"."change_key",
    "scl"."description",
    "scl"."change_type",
    "scl"."impact_scope",
    "scl"."stage",
    "scl"."is_constitutional",
    "scl"."breaking_change",
    "scl"."constitutional_object_id",
    "co"."object_type" AS "constitutional_object_type",
    "co"."object_name" AS "constitutional_object_name",
    "scl"."proposed_at",
    "scl"."approved_at",
    "scl"."applied_at",
    "scl"."rejected_at",
    "scl"."proposed_by_user_id",
    "scl"."approved_by_user_id",
    "scl"."rejected_by_user_id",
    "sca"."id" AS "approval_id",
    "sca"."approver_entity_id",
    "sca"."approver_user_id",
    "sca"."approver_role",
    "sca"."decision",
    "sca"."reason" AS "approval_reason",
    "sca"."decided_at",
    "sca"."metadata" AS "approval_metadata",
    "scl"."metadata" AS "change_metadata"
   FROM (("public"."schema_change_log" "scl"
     LEFT JOIN "public"."constitutional_objects" "co" ON (("co"."id" = "scl"."constitutional_object_id")))
     LEFT JOIN "public"."schema_change_approvals" "sca" ON (("sca"."schema_change_id" = "scl"."id")))
  ORDER BY "scl"."proposed_at" DESC NULLS LAST, "sca"."decided_at" DESC NULLS LAST;


ALTER VIEW "public"."v_schema_amendments_with_approvals" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_signature_email_jobs" AS
 SELECT "q"."id",
    "q"."envelope_id",
    "q"."party_id",
    "q"."to_email",
    "q"."to_name",
    COALESCE("q"."subject", ('Signature request: '::"text" || "e"."title")) AS "subject",
    "q"."body",
    "q"."template_key",
    "q"."payload",
    "e"."title" AS "envelope_title",
    "e"."status" AS "envelope_status",
    "p"."display_name" AS "party_display_name",
    "p"."role" AS "party_role",
    "r"."title" AS "resolution_title",
    "ent"."name" AS "entity_name"
   FROM ((((("public"."signature_email_queue" "q"
     JOIN "public"."signature_envelopes" "e" ON (("e"."id" = "q"."envelope_id")))
     JOIN "public"."signature_parties" "p" ON (("p"."id" = "q"."party_id")))
     LEFT JOIN "public"."governance_ledger" "g" ON (("g"."id" = "e"."record_id")))
     LEFT JOIN "public"."entities" "ent" ON (("ent"."id" = "e"."entity_id")))
     LEFT JOIN "public"."resolutions" "r" ON (("r"."signature_envelope_id" = "e"."id")))
  WHERE ("q"."status" = 'pending'::"text");


ALTER VIEW "public"."v_signature_email_jobs" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_signature_envelope_status_timeline" AS
 SELECT "h"."id" AS "history_id",
    "h"."envelope_id",
    "e"."record_id",
    "e"."entity_id",
    "e"."status" AS "current_status",
    "h"."old_status",
    "h"."new_status",
    "h"."reason",
    "h"."changed_by",
    "h"."changed_at",
    "h"."context",
    "e"."created_at" AS "envelope_created_at"
   FROM ("public"."signature_envelope_status_history" "h"
     JOIN "public"."signature_envelopes" "e" ON (("e"."id" = "h"."envelope_id")))
  ORDER BY "h"."changed_at" DESC;


ALTER VIEW "public"."v_signature_envelope_status_timeline" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_signed_documents" AS
 SELECT "gd"."id" AS "document_id",
    "gd"."storage_path",
    "gd"."file_name",
    "gd"."doc_type",
    "gd"."mime_type",
    "gd"."created_at",
    "gd"."metadata",
    "gl"."id" AS "record_id",
    "gl"."title" AS "record_title",
    "gl"."record_type",
    "se"."id" AS "envelope_id",
    "se"."status" AS "envelope_status",
    "se"."signing_mode"
   FROM (("public"."governance_documents" "gd"
     JOIN "public"."governance_ledger" "gl" ON (("gd"."record_id" = "gl"."id")))
     LEFT JOIN "public"."signature_envelopes" "se" ON (("gd"."envelope_id" = "se"."id")));


ALTER VIEW "public"."v_signed_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_standard_requirements" AS
 SELECT "gs"."id" AS "standard_id",
    "gs"."code" AS "standard_code",
    "gs"."name" AS "standard_name",
    "gs"."jurisdiction",
    "gr"."id" AS "requirement_id",
    "gr"."requirement_code",
    "gr"."title" AS "requirement_title",
    "gr"."description" AS "requirement_description",
    "gr"."applies_to",
    "gr"."frequency",
    "gr"."trigger_event",
    "gr"."severity",
    "gr"."metadata",
    "gs"."created_at" AS "standard_created_at",
    "gr"."created_at" AS "requirement_created_at"
   FROM ("public"."governance_standards" "gs"
     JOIN "public"."governance_requirements" "gr" ON (("gr"."standard_id" = "gs"."id")));


ALTER VIEW "public"."v_standard_requirements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."verified_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid",
    "entity_slug" "text",
    "document_class" "public"."document_class" NOT NULL,
    "title" "text" NOT NULL,
    "source_table" "text",
    "source_record_id" "uuid",
    "storage_bucket" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "file_hash" "text",
    "file_size" bigint,
    "mime_type" "text" DEFAULT 'application/pdf'::"text",
    "verification_level" "public"."verification_level" DEFAULT 'draft'::"public"."verification_level" NOT NULL,
    "envelope_id" "uuid",
    "signed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "uuid",
    "is_archived" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."verified_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_verified_documents" AS
 SELECT "id",
    "entity_id",
    "entity_slug",
    "document_class",
    "verification_level",
    "title",
    "source_table",
    "source_record_id",
    "storage_bucket",
    "storage_path",
    "file_hash",
    "file_size",
    "mime_type",
    "envelope_id",
    "signed_at",
    "created_at",
    "updated_at"
   FROM "public"."verified_documents" "vd"
  WHERE (NOT "is_archived");


ALTER VIEW "public"."v_verified_documents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_verified_resolutions" AS
 SELECT "id",
    "entity_id",
    "entity_slug",
    "document_class",
    "verification_level",
    "title",
    "source_table",
    "source_record_id",
    "storage_bucket",
    "storage_path",
    "file_hash",
    "file_size",
    "mime_type",
    "envelope_id",
    "signed_at",
    "created_at",
    "updated_at"
   FROM "public"."v_verified_documents"
  WHERE ("document_class" = 'resolution'::"public"."document_class");


ALTER VIEW "public"."v_verified_resolutions" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."vb_minutebook_index" AS
 SELECT "d"."id" AS "doc_id",
    "d"."entity_key",
    "e"."entry_date",
    "e"."title",
    "d"."section",
    "d"."file_name",
    "d"."file_path",
    "d"."mime_type",
    "d"."file_size"
   FROM ("public"."supporting_documents" "d"
     JOIN "public"."minute_book_entries" "e" ON (("e"."id" = "d"."entry_id")))
  ORDER BY "e"."entry_date" DESC, "e"."title", "d"."section", "d"."file_name";


ALTER VIEW "public"."vb_minutebook_index" OWNER TO "postgres";


ALTER TABLE ONLY "public"."audit_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."audit_logs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."audit_trail" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."audit_trail_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."menu_translations" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."menu_translations_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."actions_log"
    ADD CONSTRAINT "actions_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."advisor_audit"
    ADD CONSTRAINT "advisor_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_actions"
    ADD CONSTRAINT "ai_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_advice"
    ADD CONSTRAINT "ai_advice_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_agent_bindings"
    ADD CONSTRAINT "ai_agent_bindings_pkey" PRIMARY KEY ("entity_slug", "role_id");



ALTER TABLE ONLY "public"."ai_analyses"
    ADD CONSTRAINT "ai_analyses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_entity_roles"
    ADD CONSTRAINT "ai_entity_roles_entity_id_role_id_key" UNIQUE ("entity_id", "role_id");



ALTER TABLE ONLY "public"."ai_entity_roles"
    ADD CONSTRAINT "ai_entity_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_entity_roles"
    ADD CONSTRAINT "ai_entity_roles_unique" UNIQUE ("entity_id", "role_id");



ALTER TABLE ONLY "public"."ai_feature_flags"
    ADD CONSTRAINT "ai_feature_flags_pkey" PRIMARY KEY ("entity_slug");



ALTER TABLE ONLY "public"."ai_notes"
    ADD CONSTRAINT "ai_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_policy_versions"
    ADD CONSTRAINT "ai_policy_versions_engine_version_unique" UNIQUE ("engine_name", "version");



ALTER TABLE ONLY "public"."ai_policy_versions"
    ADD CONSTRAINT "ai_policy_versions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_roles"
    ADD CONSTRAINT "ai_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_roles"
    ADD CONSTRAINT "ai_roles_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."ai_sentinel_runs"
    ADD CONSTRAINT "ai_sentinel_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_sentinel_tasks"
    ADD CONSTRAINT "ai_sentinel_tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_status_debug"
    ADD CONSTRAINT "ai_status_debug_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_summaries"
    ADD CONSTRAINT "ai_summaries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."audit_trail"
    ADD CONSTRAINT "audit_trail_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."books"
    ADD CONSTRAINT "books_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."certificate_jobs"
    ADD CONSTRAINT "certificate_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ci_edge_functions"
    ADD CONSTRAINT "ci_edge_functions_pkey" PRIMARY KEY ("supabase_name");



ALTER TABLE ONLY "public"."ci_genesis_documents"
    ADD CONSTRAINT "ci_genesis_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ci_genesis_members"
    ADD CONSTRAINT "ci_genesis_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ci_genesis_sessions"
    ADD CONSTRAINT "ci_genesis_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ci_modules_registry"
    ADD CONSTRAINT "ci_modules_registry_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."ci_orb_events"
    ADD CONSTRAINT "ci_orb_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ci_orb_logs"
    ADD CONSTRAINT "ci_orb_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ci_orb_state"
    ADD CONSTRAINT "ci_orb_state_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ci_suite_modules"
    ADD CONSTRAINT "ci_suite_modules_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."ci_tables_registry"
    ADD CONSTRAINT "ci_tables_registry_pkey" PRIMARY KEY ("ci_name");



ALTER TABLE ONLY "public"."compliance_audit_log"
    ADD CONSTRAINT "compliance_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."compliance_obligations"
    ADD CONSTRAINT "compliance_obligations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."compliance_reviews"
    ADD CONSTRAINT "compliance_reviews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."compliance_rule_sets"
    ADD CONSTRAINT "compliance_rule_sets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."constitutional_objects"
    ADD CONSTRAINT "constitutional_objects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."corrections"
    ADD CONSTRAINT "corrections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."corrective_actions"
    ADD CONSTRAINT "corrective_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."doc_section_pillars"
    ADD CONSTRAINT "doc_section_pillars_pkey" PRIMARY KEY ("section");



ALTER TABLE ONLY "public"."document_links"
    ADD CONSTRAINT "document_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."document_retention_policies"
    ADD CONSTRAINT "document_retention_policies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."document_retention_policies"
    ADD CONSTRAINT "document_retention_policies_policy_key_key" UNIQUE ("policy_key");



ALTER TABLE ONLY "public"."entities"
    ADD CONSTRAINT "entities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."entities"
    ADD CONSTRAINT "entities_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."entity_companies"
    ADD CONSTRAINT "entity_companies_key_key" UNIQUE ("key");



ALTER TABLE ONLY "public"."entity_companies"
    ADD CONSTRAINT "entity_companies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."entity_relationships"
    ADD CONSTRAINT "entity_relationships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."entity_relationships"
    ADD CONSTRAINT "entity_relationships_unique" UNIQUE ("parent_entity_id", "child_entity_id", "relationship_type");



ALTER TABLE ONLY "public"."entry_signers"
    ADD CONSTRAINT "entry_signers_pkey" PRIMARY KEY ("entry_id", "signer_id");



ALTER TABLE ONLY "public"."entry_type_default_section"
    ADD CONSTRAINT "entry_type_default_section_pkey" PRIMARY KEY ("entry_type");



ALTER TABLE ONLY "public"."financial_events"
    ADD CONSTRAINT "financial_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."governance_approvals"
    ADD CONSTRAINT "governance_approvals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."governance_documents"
    ADD CONSTRAINT "governance_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."governance_drafts"
    ADD CONSTRAINT "governance_drafts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."governance_ledger"
    ADD CONSTRAINT "governance_ledger_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."governance_policies"
    ADD CONSTRAINT "governance_policies_entity_unique" UNIQUE ("entity_id");



ALTER TABLE ONLY "public"."governance_policies"
    ADD CONSTRAINT "governance_policies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."governance_requirements"
    ADD CONSTRAINT "governance_requirements_code_unique" UNIQUE ("standard_id", "requirement_code");



ALTER TABLE ONLY "public"."governance_requirements"
    ADD CONSTRAINT "governance_requirements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."governance_standards"
    ADD CONSTRAINT "governance_standards_code_unique" UNIQUE ("code");



ALTER TABLE ONLY "public"."governance_standards"
    ADD CONSTRAINT "governance_standards_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."governance_templates"
    ADD CONSTRAINT "governance_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."governance_validations"
    ADD CONSTRAINT "governance_validations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."governance_validations"
    ADD CONSTRAINT "governance_validations_rule_unique" UNIQUE ("target_type", "rule_key");



ALTER TABLE ONLY "public"."governance_violations"
    ADD CONSTRAINT "governance_violations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."iso_clauses"
    ADD CONSTRAINT "iso_clauses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."legal_policy_links"
    ADD CONSTRAINT "legal_policy_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."legal_record_links"
    ADD CONSTRAINT "legal_record_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."legal_sources"
    ADD CONSTRAINT "legal_sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meetings"
    ADD CONSTRAINT "meetings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_pkey" PRIMARY KEY ("user_id", "entity_id");



ALTER TABLE ONLY "public"."menu_items"
    ADD CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."menu_publish_items"
    ADD CONSTRAINT "menu_publish_items_pkey" PRIMARY KEY ("publish_id", "menu_item_id", "lang");



ALTER TABLE ONLY "public"."menu_publish"
    ADD CONSTRAINT "menu_publish_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."menu_translations"
    ADD CONSTRAINT "menu_translations_menu_item_id_lang_key" UNIQUE ("menu_item_id", "lang");



ALTER TABLE ONLY "public"."menu_translations"
    ADD CONSTRAINT "menu_translations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."metadata_sources"
    ADD CONSTRAINT "metadata_sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."minute_book_entries"
    ADD CONSTRAINT "minute_book_entries_entity_key_entry_date_title_key" UNIQUE ("entity_key", "entry_date", "title");



ALTER TABLE ONLY "public"."minute_book_entries"
    ADD CONSTRAINT "minute_book_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."minute_book_members"
    ADD CONSTRAINT "minute_book_members_pkey" PRIMARY KEY ("user_id", "entity_key");



ALTER TABLE ONLY "public"."minute_books"
    ADD CONSTRAINT "minute_books_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."obligations"
    ADD CONSTRAINT "obligations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."people"
    ADD CONSTRAINT "people_auth_user_id_key" UNIQUE ("auth_user_id");



ALTER TABLE ONLY "public"."people"
    ADD CONSTRAINT "people_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."policy_rules"
    ADD CONSTRAINT "policy_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."reasoning_traces"
    ADD CONSTRAINT "reasoning_traces_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."resolution_status_history"
    ADD CONSTRAINT "resolution_status_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."resolutions"
    ADD CONSTRAINT "resolutions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schema_change_approvals"
    ADD CONSTRAINT "schema_change_approvals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schema_change_log"
    ADD CONSTRAINT "schema_change_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sections"
    ADD CONSTRAINT "sections_entity_name_key" UNIQUE ("entity_id", "name");



ALTER TABLE ONLY "public"."sections"
    ADD CONSTRAINT "sections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signatories"
    ADD CONSTRAINT "signatories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signature_audit_log"
    ADD CONSTRAINT "signature_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signature_email_queue"
    ADD CONSTRAINT "signature_email_queue_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signature_envelope_status_history"
    ADD CONSTRAINT "signature_envelope_status_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signature_envelopes"
    ADD CONSTRAINT "signature_envelopes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signature_events"
    ADD CONSTRAINT "signature_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signature_parties"
    ADD CONSTRAINT "signature_parties_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."supporting_documents"
    ADD CONSTRAINT "supporting_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."system_config"
    ADD CONSTRAINT "system_config_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."verified_documents"
    ADD CONSTRAINT "verified_documents_pkey" PRIMARY KEY ("id");



CREATE INDEX "actions_log_created_idx" ON "public"."actions_log" USING "btree" ("created_at" DESC);



CREATE INDEX "advisor_audit_entity_created_idx" ON "public"."advisor_audit" USING "btree" ("entity_slug", "created_at" DESC);



CREATE INDEX "advisor_audit_record_idx" ON "public"."advisor_audit" USING "btree" ("record_id", "created_at" DESC);



CREATE INDEX "ai_entity_roles_entity_idx" ON "public"."ai_entity_roles" USING "btree" ("entity_id");



CREATE INDEX "ai_entity_roles_role_idx" ON "public"."ai_entity_roles" USING "btree" ("role_id");



CREATE INDEX "ai_notes_scope_idx" ON "public"."ai_notes" USING "btree" ("scope_type", "scope_id");



CREATE INDEX "ai_notes_tsv_idx" ON "public"."ai_notes" USING "gin" ("to_tsvector"('"english"'::"regconfig", ((COALESCE("title", ''::"text") || ' '::"text") || COALESCE("content", ''::"text"))));



CREATE INDEX "certificate_jobs_envelope_id_idx" ON "public"."certificate_jobs" USING "btree" ("envelope_id");



CREATE INDEX "certificate_jobs_status_idx" ON "public"."certificate_jobs" USING "btree" ("status");



CREATE INDEX "governance_approvals_ledger_id_decided_at_idx" ON "public"."governance_approvals" USING "btree" ("ledger_id", "decided_at" DESC);



CREATE INDEX "idx_actions_actor" ON "public"."actions_log" USING "btree" ("actor_uid");



CREATE INDEX "idx_actions_target" ON "public"."actions_log" USING "btree" ("target_table", "target_id");



CREATE INDEX "idx_ai_advice_record_id" ON "public"."ai_advice" USING "btree" ("record_id");



CREATE INDEX "idx_ai_notes_created_by" ON "public"."ai_notes" USING "btree" ("created_by");



CREATE INDEX "idx_ai_notes_scope" ON "public"."ai_notes" USING "btree" ("scope_type", "scope_id");



CREATE INDEX "idx_ai_policy_versions_engine_version" ON "public"."ai_policy_versions" USING "btree" ("engine_name", "version");



CREATE INDEX "idx_audit_entity_time" ON "public"."audit_logs" USING "btree" ("entity_id", "occurred_at" DESC);



CREATE INDEX "idx_compliance_reviews_ai_policy_version_id" ON "public"."compliance_reviews" USING "btree" ("ai_policy_version_id");



CREATE INDEX "idx_compliance_reviews_rule_set_id" ON "public"."compliance_reviews" USING "btree" ("rule_set_id");



CREATE UNIQUE INDEX "idx_compliance_rule_sets_code_version" ON "public"."compliance_rule_sets" USING "btree" ("code", "version");



CREATE UNIQUE INDEX "idx_constitutional_objects_unique" ON "public"."constitutional_objects" USING "btree" ("object_type", "object_name");



CREATE INDEX "idx_docs_entity_section" ON "public"."supporting_documents" USING "btree" ("entity_key", "section");



CREATE INDEX "idx_docs_entry" ON "public"."supporting_documents" USING "btree" ("entry_id");



CREATE INDEX "idx_docs_hash" ON "public"."supporting_documents" USING "btree" ("file_hash");



CREATE INDEX "idx_document_links_obligation_id" ON "public"."document_links" USING "btree" ("obligation_id");



CREATE INDEX "idx_document_links_resolution_id" ON "public"."document_links" USING "btree" ("resolution_id");



CREATE INDEX "idx_governance_documents_expires_at" ON "public"."governance_documents" USING "btree" ("expires_at");



CREATE INDEX "idx_governance_documents_ocr_tsv" ON "public"."governance_documents" USING "gin" ("ocr_tsv");



CREATE INDEX "idx_governance_documents_record_id" ON "public"."governance_documents" USING "btree" ("record_id");



CREATE INDEX "idx_governance_ledger_status" ON "public"."governance_ledger" USING "btree" ("status");



CREATE INDEX "idx_ledger_created_by" ON "public"."governance_ledger" USING "btree" ("created_by");



CREATE INDEX "idx_ledger_entity" ON "public"."governance_ledger" USING "btree" ("entity_id");



CREATE INDEX "idx_mb_entity" ON "public"."minute_books" USING "btree" ("entity_id");



CREATE INDEX "idx_mbe_entity_date" ON "public"."minute_book_entries" USING "btree" ("entity_key", "entry_date" DESC);



CREATE INDEX "idx_mbe_source_envelope_id" ON "public"."minute_book_entries" USING "btree" ("source_envelope_id");



CREATE INDEX "idx_mbe_source_record_id" ON "public"."minute_book_entries" USING "btree" ("source_record_id");



CREATE INDEX "idx_meet_entity" ON "public"."meetings" USING "btree" ("entity_id");



CREATE INDEX "idx_res_entity" ON "public"."resolutions" USING "btree" ("entity_id");



CREATE INDEX "idx_resolution_status_history_resolution_id" ON "public"."resolution_status_history" USING "btree" ("resolution_id", "changed_at" DESC);



CREATE INDEX "idx_resolutions_section" ON "public"."resolutions" USING "btree" ("section_id");



CREATE INDEX "idx_reviews_approved" ON "public"."reviews" USING "btree" ("status", "menu_item_id");



CREATE INDEX "idx_reviews_created" ON "public"."reviews" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_reviews_entity" ON "public"."reviews" USING "btree" ("entity_slug");



CREATE INDEX "idx_reviews_item" ON "public"."reviews" USING "btree" ("menu_item_id");



CREATE INDEX "idx_schema_change_approvals_change_id" ON "public"."schema_change_approvals" USING "btree" ("schema_change_id", "decided_at" DESC);



CREATE INDEX "idx_schema_change_log_applied_at" ON "public"."schema_change_log" USING "btree" ("applied_at" DESC);



CREATE INDEX "idx_schema_change_log_change_key" ON "public"."schema_change_log" USING "btree" ("change_key");



CREATE INDEX "idx_sections_book" ON "public"."sections" USING "btree" ("entity_id");



CREATE INDEX "idx_sections_entity" ON "public"."sections" USING "btree" ("entity_id");



CREATE INDEX "idx_signature_envelope_status_history_envelope_id" ON "public"."signature_envelope_status_history" USING "btree" ("envelope_id", "changed_at" DESC);



CREATE INDEX "idx_supporting_documents_entry_id" ON "public"."supporting_documents" USING "btree" ("entry_id");



CREATE INDEX "idx_supporting_documents_expires_at" ON "public"."supporting_documents" USING "btree" ("expires_at");



CREATE INDEX "ix_reviews_resolution_date" ON "public"."compliance_reviews" USING "btree" ("resolution_id", "review_date" DESC);



CREATE INDEX "ix_reviews_risk" ON "public"."compliance_reviews" USING "btree" ("resolution_id", "risk_level");



CREATE INDEX "people_auth_user_id_idx" ON "public"."people" USING "btree" ("auth_user_id");



CREATE UNIQUE INDEX "policy_rules_unique" ON "public"."policy_rules" USING "btree" ("entity_slug", "domain", "name", "version");



CREATE INDEX "signature_audit_log_envelope_id_idx" ON "public"."signature_audit_log" USING "btree" ("envelope_id");



CREATE INDEX "signature_audit_log_record_id_idx" ON "public"."signature_audit_log" USING "btree" ("record_id");



CREATE INDEX "signature_email_queue_status_idx" ON "public"."signature_email_queue" USING "btree" ("status", "created_at");



CREATE UNIQUE INDEX "uniq_menu_name_lang" ON "public"."menu_publish_items" USING "btree" ("lower"("name"), "lang");



CREATE UNIQUE INDEX "ux_minute_book_entries_unique" ON "public"."minute_book_entries" USING "btree" ("entity_key", "storage_path");



CREATE UNIQUE INDEX "ux_reviews_resolution_day" ON "public"."compliance_reviews" USING "btree" ("resolution_id", "review_day");



CREATE OR REPLACE TRIGGER "ai_status_update_on_ai_advice" AFTER INSERT ON "public"."ai_advice" FOR EACH ROW EXECUTE FUNCTION "public"."update_ai_status"();



CREATE OR REPLACE TRIGGER "t_aud_mb_iud" AFTER INSERT OR DELETE OR UPDATE ON "public"."minute_books" FOR EACH ROW EXECUTE FUNCTION "public"."audit_row"();



CREATE OR REPLACE TRIGGER "t_aud_meet_iud" AFTER INSERT OR DELETE OR UPDATE ON "public"."meetings" FOR EACH ROW EXECUTE FUNCTION "public"."audit_row"();



CREATE OR REPLACE TRIGGER "t_aud_res_iud" AFTER INSERT OR DELETE OR UPDATE ON "public"."resolutions" FOR EACH ROW EXECUTE FUNCTION "public"."audit_row"();



CREATE OR REPLACE TRIGGER "t_guard_res" BEFORE UPDATE ON "public"."resolutions" FOR EACH ROW EXECUTE FUNCTION "public"."guard_adopt_resolution"();



CREATE OR REPLACE TRIGGER "t_hash_audit" BEFORE INSERT ON "public"."audit_logs" FOR EACH ROW EXECUTE FUNCTION "public"."audit_insert"();



CREATE OR REPLACE TRIGGER "t_no_ud_audit" BEFORE DELETE OR UPDATE ON "public"."audit_logs" FOR EACH ROW EXECUTE FUNCTION "public"."block_audit_mutations"();



CREATE OR REPLACE TRIGGER "t_res_status_guard" BEFORE UPDATE OF "status" ON "public"."resolutions" FOR EACH ROW EXECUTE FUNCTION "public"."guard_resolution_transitions"();



CREATE OR REPLACE TRIGGER "trg_audit_compliance_change" AFTER UPDATE ON "public"."resolutions" FOR EACH ROW EXECUTE FUNCTION "public"."trg_audit_compliance_change"();



CREATE OR REPLACE TRIGGER "trg_block_party_delete_if_envelope_completed" BEFORE DELETE ON "public"."signature_parties" FOR EACH ROW EXECUTE FUNCTION "public"."block_party_changes_if_envelope_completed"();



CREATE OR REPLACE TRIGGER "trg_block_party_insert_if_envelope_completed" BEFORE INSERT ON "public"."signature_parties" FOR EACH ROW EXECUTE FUNCTION "public"."block_party_changes_if_envelope_completed"();



CREATE OR REPLACE TRIGGER "trg_block_party_update_if_envelope_completed" BEFORE UPDATE ON "public"."signature_parties" FOR EACH ROW EXECUTE FUNCTION "public"."block_party_changes_if_envelope_completed"();



CREATE OR REPLACE TRIGGER "trg_ci_genesis_touch_session" BEFORE UPDATE ON "public"."ci_genesis_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."ci_genesis_touch_session"();



CREATE OR REPLACE TRIGGER "trg_compliance_reviews_set_updated_at" BEFORE UPDATE ON "public"."compliance_reviews" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_compliance_status" AFTER UPDATE OF "compliance_status" ON "public"."resolutions" FOR EACH ROW WHEN (("old"."compliance_status" IS DISTINCT FROM "new"."compliance_status")) EXECUTE FUNCTION "public"."compliance_status_trigger"();



CREATE OR REPLACE TRIGGER "trg_enforce_completed_envelope_immutability" BEFORE UPDATE ON "public"."signature_envelopes" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_completed_envelope_immutability"();



CREATE OR REPLACE TRIGGER "trg_enforce_council_before_ready_for_signature" BEFORE UPDATE ON "public"."governance_documents" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_council_before_ready_for_signature"();



CREATE OR REPLACE TRIGGER "trg_governance_documents_ai" AFTER INSERT ON "public"."governance_documents" FOR EACH ROW EXECUTE FUNCTION "public"."trg_governance_documents_after_ins"();



CREATE OR REPLACE TRIGGER "trg_governance_documents_bi" BEFORE INSERT ON "public"."governance_documents" FOR EACH ROW EXECUTE FUNCTION "public"."trg_governance_documents_before_ins"();



CREATE OR REPLACE TRIGGER "trg_governance_documents_ocr_tsv" BEFORE INSERT OR UPDATE OF "ocr_text", "file_name" ON "public"."governance_documents" FOR EACH ROW EXECUTE FUNCTION "public"."update_governance_documents_ocr_tsv"();



CREATE OR REPLACE TRIGGER "trg_governance_documents_retention" BEFORE INSERT OR UPDATE OF "retention_policy_id" ON "public"."governance_documents" FOR EACH ROW EXECUTE FUNCTION "public"."apply_retention_expiry"();



CREATE OR REPLACE TRIGGER "trg_log_compliance_change" AFTER UPDATE OF "compliance_status" ON "public"."resolutions" FOR EACH ROW EXECUTE FUNCTION "public"."trg_log_compliance_change"();



CREATE OR REPLACE TRIGGER "trg_log_minute_book_entry_to_verified" AFTER INSERT ON "public"."minute_book_entries" FOR EACH ROW EXECUTE FUNCTION "public"."log_minute_book_entry_to_verified"();



CREATE OR REPLACE TRIGGER "trg_log_minute_book_update_to_verified" AFTER UPDATE ON "public"."minute_book_entries" FOR EACH ROW EXECUTE FUNCTION "public"."log_minute_book_update_to_verified"();



CREATE OR REPLACE TRIGGER "trg_log_minute_upload" AFTER INSERT ON "public"."minute_book_entries" FOR EACH ROW EXECUTE FUNCTION "public"."log_minute_book_upload"();



CREATE OR REPLACE TRIGGER "trg_log_resolution_status_change" AFTER UPDATE OF "status" ON "public"."resolutions" FOR EACH ROW EXECUTE FUNCTION "public"."log_resolution_status_change"();



CREATE OR REPLACE TRIGGER "trg_log_signature_envelope_status_change" AFTER UPDATE OF "status" ON "public"."signature_envelopes" FOR EACH ROW EXECUTE FUNCTION "public"."log_signature_envelope_status_change"();



CREATE OR REPLACE TRIGGER "trg_mbe_updated_at" BEFORE UPDATE ON "public"."minute_book_entries" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_resolutions_hash" BEFORE INSERT OR UPDATE ON "public"."resolutions" FOR EACH ROW EXECUTE FUNCTION "public"."tg_resolutions_hash"();



CREATE OR REPLACE TRIGGER "trg_reviews_normalize" BEFORE INSERT ON "public"."compliance_reviews" FOR EACH ROW EXECUTE FUNCTION "public"."trg_normalize_low_to_compliant"();



CREATE OR REPLACE TRIGGER "trg_reviews_set_status" AFTER INSERT ON "public"."compliance_reviews" FOR EACH ROW EXECUTE FUNCTION "public"."trg_set_status"();



CREATE OR REPLACE TRIGGER "trg_signature_parties_enqueue_email" AFTER INSERT ON "public"."signature_parties" FOR EACH ROW EXECUTE FUNCTION "public"."enqueue_signature_email_for_party"();



CREATE OR REPLACE TRIGGER "trg_supporting_documents_bi" BEFORE INSERT ON "public"."supporting_documents" FOR EACH ROW EXECUTE FUNCTION "public"."trg_supporting_documents_before_ins"();



CREATE OR REPLACE TRIGGER "trg_supporting_documents_retention" BEFORE INSERT OR UPDATE OF "retention_policy_id" ON "public"."supporting_documents" FOR EACH ROW EXECUTE FUNCTION "public"."apply_retention_expiry"();



CREATE OR REPLACE TRIGGER "trg_sync_obligation_from_review" AFTER INSERT OR UPDATE OF "compliant", "risk_level", "overall_status", "review_day" ON "public"."compliance_reviews" FOR EACH ROW EXECUTE FUNCTION "public"."sync_obligation_from_review"();



CREATE OR REPLACE TRIGGER "trg_touch_governance_draft_updated_at" BEFORE UPDATE ON "public"."governance_drafts" FOR EACH ROW EXECUTE FUNCTION "public"."touch_governance_draft_updated_at"();



CREATE OR REPLACE TRIGGER "trg_touch_governance_policies" BEFORE UPDATE ON "public"."governance_policies" FOR EACH ROW EXECUTE FUNCTION "public"."touch_governance_policies_updated_at"();



CREATE OR REPLACE TRIGGER "trg_touch_resolutions" BEFORE UPDATE ON "public"."resolutions" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "trg_update_resolution_status" AFTER INSERT ON "public"."compliance_reviews" FOR EACH ROW EXECUTE FUNCTION "public"."fn_update_resolution_status_from_review"();



CREATE OR REPLACE TRIGGER "trg_verified_documents_set_updated_at" BEFORE UPDATE ON "public"."verified_documents" FOR EACH ROW EXECUTE FUNCTION "public"."set_verified_documents_updated_at"();



ALTER TABLE ONLY "public"."ai_advice"
    ADD CONSTRAINT "ai_advice_corrective_action_fk" FOREIGN KEY ("corrective_action_id") REFERENCES "public"."corrective_actions"("id");



ALTER TABLE ONLY "public"."ai_advice"
    ADD CONSTRAINT "ai_advice_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "public"."governance_ledger"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_agent_bindings"
    ADD CONSTRAINT "ai_agent_bindings_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."ai_roles"("id");



ALTER TABLE ONLY "public"."ai_analyses"
    ADD CONSTRAINT "ai_analyses_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "public"."governance_ledger"("id");



ALTER TABLE ONLY "public"."ai_entity_roles"
    ADD CONSTRAINT "ai_entity_roles_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_entity_roles"
    ADD CONSTRAINT "ai_entity_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."ai_roles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_sentinel_tasks"
    ADD CONSTRAINT "ai_sentinel_tasks_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "public"."governance_ledger"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_sentinel_tasks"
    ADD CONSTRAINT "ai_sentinel_tasks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."ai_sentinel_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_summaries"
    ADD CONSTRAINT "ai_summaries_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "public"."governance_ledger"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."books"
    ADD CONSTRAINT "books_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."certificate_jobs"
    ADD CONSTRAINT "certificate_jobs_envelope_id_fkey" FOREIGN KEY ("envelope_id") REFERENCES "public"."signature_envelopes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."certificate_jobs"
    ADD CONSTRAINT "certificate_jobs_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "public"."governance_ledger"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ci_edge_functions"
    ADD CONSTRAINT "ci_edge_functions_module_fk" FOREIGN KEY ("module_key") REFERENCES "public"."ci_suite_modules"("key");



ALTER TABLE ONLY "public"."ci_genesis_documents"
    ADD CONSTRAINT "ci_genesis_documents_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."ci_genesis_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ci_genesis_members"
    ADD CONSTRAINT "ci_genesis_members_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."ci_genesis_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ci_genesis_sessions"
    ADD CONSTRAINT "ci_genesis_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."compliance_audit_log"
    ADD CONSTRAINT "compliance_audit_log_resolution_id_fkey" FOREIGN KEY ("resolution_id") REFERENCES "public"."resolutions"("id");



ALTER TABLE ONLY "public"."compliance_obligations"
    ADD CONSTRAINT "compliance_obligations_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id");



ALTER TABLE ONLY "public"."compliance_obligations"
    ADD CONSTRAINT "compliance_obligations_iso_clause_id_fkey" FOREIGN KEY ("iso_clause_id") REFERENCES "public"."iso_clauses"("id");



ALTER TABLE ONLY "public"."compliance_obligations"
    ADD CONSTRAINT "compliance_obligations_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "public"."governance_requirements"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."compliance_reviews"
    ADD CONSTRAINT "compliance_reviews_ai_policy_version_id_fkey" FOREIGN KEY ("ai_policy_version_id") REFERENCES "public"."ai_policy_versions"("id");



ALTER TABLE ONLY "public"."compliance_reviews"
    ADD CONSTRAINT "compliance_reviews_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."compliance_reviews"
    ADD CONSTRAINT "compliance_reviews_obligation_id_fkey" FOREIGN KEY ("obligation_id") REFERENCES "public"."compliance_obligations"("id");



ALTER TABLE ONLY "public"."compliance_reviews"
    ADD CONSTRAINT "compliance_reviews_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "public"."governance_ledger"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."compliance_reviews"
    ADD CONSTRAINT "compliance_reviews_resolution_id_fkey" FOREIGN KEY ("resolution_id") REFERENCES "public"."resolutions"("id");



ALTER TABLE ONLY "public"."compliance_reviews"
    ADD CONSTRAINT "compliance_reviews_rule_set_id_fkey" FOREIGN KEY ("rule_set_id") REFERENCES "public"."compliance_rule_sets"("id");



ALTER TABLE ONLY "public"."corrections"
    ADD CONSTRAINT "corrections_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "public"."governance_ledger"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."corrective_actions"
    ADD CONSTRAINT "corrective_actions_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "public"."compliance_reviews"("id");



ALTER TABLE ONLY "public"."document_links"
    ADD CONSTRAINT "document_links_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."governance_documents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_links"
    ADD CONSTRAINT "document_links_obligation_id_fkey" FOREIGN KEY ("obligation_id") REFERENCES "public"."compliance_obligations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."document_links"
    ADD CONSTRAINT "document_links_resolution_id_fkey" FOREIGN KEY ("resolution_id") REFERENCES "public"."resolutions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."entity_relationships"
    ADD CONSTRAINT "entity_relationships_child_fk" FOREIGN KEY ("child_entity_id") REFERENCES "public"."entities"("id");



ALTER TABLE ONLY "public"."entity_relationships"
    ADD CONSTRAINT "entity_relationships_parent_fk" FOREIGN KEY ("parent_entity_id") REFERENCES "public"."entities"("id");



ALTER TABLE ONLY "public"."entry_signers"
    ADD CONSTRAINT "entry_signers_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "public"."minute_book_entries"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."entry_signers"
    ADD CONSTRAINT "entry_signers_signer_id_fkey" FOREIGN KEY ("signer_id") REFERENCES "public"."signatories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financial_events"
    ADD CONSTRAINT "financial_events_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financial_events"
    ADD CONSTRAINT "financial_events_related_record_id_fkey" FOREIGN KEY ("related_record_id") REFERENCES "public"."governance_ledger"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."governance_approvals"
    ADD CONSTRAINT "governance_approvals_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "public"."governance_ledger"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."governance_documents"
    ADD CONSTRAINT "governance_documents_envelope_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."signature_envelopes"("id");



ALTER TABLE ONLY "public"."governance_documents"
    ADD CONSTRAINT "governance_documents_record_fk" FOREIGN KEY ("record_id") REFERENCES "public"."governance_ledger"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."governance_documents"
    ADD CONSTRAINT "governance_documents_retention_policy_id_fkey" FOREIGN KEY ("retention_policy_id") REFERENCES "public"."document_retention_policies"("id");



ALTER TABLE ONLY "public"."governance_ledger"
    ADD CONSTRAINT "governance_ledger_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."governance_policies"
    ADD CONSTRAINT "governance_policies_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."governance_requirements"
    ADD CONSTRAINT "governance_requirements_standard_fk" FOREIGN KEY ("standard_id") REFERENCES "public"."governance_standards"("id");



ALTER TABLE ONLY "public"."governance_standards"
    ADD CONSTRAINT "governance_standards_legal_source_fk" FOREIGN KEY ("source_legal_source_id") REFERENCES "public"."legal_sources"("id");



ALTER TABLE ONLY "public"."governance_validations"
    ADD CONSTRAINT "governance_validations_policy_rule_fk" FOREIGN KEY ("policy_rule_id") REFERENCES "public"."policy_rules"("id");



ALTER TABLE ONLY "public"."governance_validations"
    ADD CONSTRAINT "governance_validations_requirement_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."governance_requirements"("id");



ALTER TABLE ONLY "public"."governance_violations"
    ADD CONSTRAINT "governance_violations_corrective_action_fk" FOREIGN KEY ("corrective_action_id") REFERENCES "public"."corrective_actions"("id");



ALTER TABLE ONLY "public"."governance_violations"
    ADD CONSTRAINT "governance_violations_entity_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id");



ALTER TABLE ONLY "public"."governance_violations"
    ADD CONSTRAINT "governance_violations_obligation_fk" FOREIGN KEY ("obligation_id") REFERENCES "public"."compliance_obligations"("id");



ALTER TABLE ONLY "public"."governance_violations"
    ADD CONSTRAINT "governance_violations_record_fk" FOREIGN KEY ("record_id") REFERENCES "public"."governance_ledger"("id");



ALTER TABLE ONLY "public"."governance_violations"
    ADD CONSTRAINT "governance_violations_resolution_fk" FOREIGN KEY ("resolution_id") REFERENCES "public"."resolutions"("id");



ALTER TABLE ONLY "public"."governance_violations"
    ADD CONSTRAINT "governance_violations_validation_fk" FOREIGN KEY ("validation_id") REFERENCES "public"."governance_validations"("id");



ALTER TABLE ONLY "public"."meetings"
    ADD CONSTRAINT "meetings_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."menu_items"
    ADD CONSTRAINT "menu_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."menu_items"
    ADD CONSTRAINT "menu_items_entity_slug_fkey" FOREIGN KEY ("entity_slug") REFERENCES "public"."entities"("slug");



ALTER TABLE ONLY "public"."menu_publish"
    ADD CONSTRAINT "menu_publish_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."menu_publish"
    ADD CONSTRAINT "menu_publish_entity_slug_fkey" FOREIGN KEY ("entity_slug") REFERENCES "public"."entities"("slug");



ALTER TABLE ONLY "public"."menu_publish_items"
    ADD CONSTRAINT "menu_publish_items_publish_id_fkey" FOREIGN KEY ("publish_id") REFERENCES "public"."menu_publish"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."menu_translations"
    ADD CONSTRAINT "menu_translations_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."minute_book_members"
    ADD CONSTRAINT "minute_book_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."minute_books"
    ADD CONSTRAINT "minute_books_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."obligations"
    ADD CONSTRAINT "obligations_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "public"."governance_ledger"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_entity_slug_fkey" FOREIGN KEY ("entity_slug") REFERENCES "public"."entities"("slug");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reasoning_traces"
    ADD CONSTRAINT "reasoning_traces_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "public"."governance_ledger"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."resolution_status_history"
    ADD CONSTRAINT "resolution_status_history_resolution_id_fkey" FOREIGN KEY ("resolution_id") REFERENCES "public"."resolutions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."resolutions"
    ADD CONSTRAINT "resolutions_drafted_by_fkey" FOREIGN KEY ("drafted_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."resolutions"
    ADD CONSTRAINT "resolutions_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id");



ALTER TABLE ONLY "public"."resolutions"
    ADD CONSTRAINT "resolutions_iso_clause_id_fkey" FOREIGN KEY ("iso_clause_id") REFERENCES "public"."iso_clauses"("id");



ALTER TABLE ONLY "public"."resolutions"
    ADD CONSTRAINT "resolutions_minute_book_id_fkey" FOREIGN KEY ("minute_book_id") REFERENCES "public"."minute_books"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."resolutions"
    ADD CONSTRAINT "resolutions_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."resolutions"
    ADD CONSTRAINT "resolutions_signature_envelope_id_fkey" FOREIGN KEY ("signature_envelope_id") REFERENCES "public"."signature_envelopes"("id");



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."schema_change_approvals"
    ADD CONSTRAINT "schema_change_approvals_schema_change_id_fkey" FOREIGN KEY ("schema_change_id") REFERENCES "public"."schema_change_log"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schema_change_log"
    ADD CONSTRAINT "schema_change_log_constitutional_object_id_fkey" FOREIGN KEY ("constitutional_object_id") REFERENCES "public"."constitutional_objects"("id");



ALTER TABLE ONLY "public"."sections"
    ADD CONSTRAINT "sections_entity_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."signatories"
    ADD CONSTRAINT "signatories_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id");



ALTER TABLE ONLY "public"."signature_audit_log"
    ADD CONSTRAINT "signature_audit_log_envelope_id_fkey" FOREIGN KEY ("envelope_id") REFERENCES "public"."signature_envelopes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."signature_audit_log"
    ADD CONSTRAINT "signature_audit_log_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "public"."governance_ledger"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."signature_email_queue"
    ADD CONSTRAINT "signature_email_queue_envelope_id_fkey" FOREIGN KEY ("envelope_id") REFERENCES "public"."signature_envelopes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."signature_email_queue"
    ADD CONSTRAINT "signature_email_queue_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "public"."signature_parties"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."signature_envelope_status_history"
    ADD CONSTRAINT "signature_envelope_status_history_envelope_id_fkey" FOREIGN KEY ("envelope_id") REFERENCES "public"."signature_envelopes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."signature_envelopes"
    ADD CONSTRAINT "signature_envelopes_entity_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id");



ALTER TABLE ONLY "public"."signature_envelopes"
    ADD CONSTRAINT "signature_envelopes_record_fk" FOREIGN KEY ("record_id") REFERENCES "public"."governance_ledger"("id");



ALTER TABLE ONLY "public"."signature_events"
    ADD CONSTRAINT "signature_events_envelope_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."signature_envelopes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."signature_events"
    ADD CONSTRAINT "signature_events_party_fk" FOREIGN KEY ("party_id") REFERENCES "public"."signature_parties"("id");



ALTER TABLE ONLY "public"."signature_parties"
    ADD CONSTRAINT "signature_parties_envelope_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."signature_envelopes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."signature_parties"
    ADD CONSTRAINT "signature_parties_signatory_fk" FOREIGN KEY ("signatory_id") REFERENCES "public"."signatories"("id");



ALTER TABLE ONLY "public"."supporting_documents"
    ADD CONSTRAINT "supporting_documents_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "public"."minute_book_entries"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supporting_documents"
    ADD CONSTRAINT "supporting_documents_retention_policy_id_fkey" FOREIGN KEY ("retention_policy_id") REFERENCES "public"."document_retention_policies"("id");



ALTER TABLE ONLY "public"."supporting_documents"
    ADD CONSTRAINT "supporting_documents_signature_envelope_id_fkey" FOREIGN KEY ("signature_envelope_id") REFERENCES "public"."signature_envelopes"("id");



CREATE POLICY "Authenticated can read entities" ON "public"."entities" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Council can read approvals" ON "public"."governance_approvals" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Council can read draft ledger" ON "public"."governance_ledger" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Forge can read Alchemy drafts" ON "public"."governance_ledger" FOR SELECT TO "authenticated" USING ((("status" = 'draft'::"text") AND ("source" = 'ci-alchemy'::"text")));



CREATE POLICY "Forge can see entities for Alchemy drafts" ON "public"."entities" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."governance_ledger" "g"
  WHERE (("g"."entity_id" = "entities"."id") AND ("g"."status" = 'draft'::"text") AND ("g"."source" = 'ci-alchemy'::"text")))));



CREATE POLICY "Governance members can read own records" ON "public"."governance_ledger" FOR SELECT USING (("auth"."uid"() = "created_by"));



CREATE POLICY "Members read own" ON "public"."governance_ledger" FOR SELECT USING (("auth"."uid"() = "created_by"));



CREATE POLICY "actions_board_full" ON "public"."corrective_actions" USING ((EXISTS ( SELECT 1
   FROM (("public"."compliance_reviews" "r"
     JOIN "public"."compliance_obligations" "o" ON (("o"."id" = "r"."obligation_id")))
     JOIN "public"."memberships" "m" ON (("m"."entity_id" = "o"."entity_id")))
  WHERE (("r"."id" = "corrective_actions"."review_id") AND ("m"."user_id" = "auth"."uid"()) AND ("m"."role" = ANY (ARRAY['owner'::"text", 'director'::"text", 'auditor'::"text"])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM (("public"."compliance_reviews" "r"
     JOIN "public"."compliance_obligations" "o" ON (("o"."id" = "r"."obligation_id")))
     JOIN "public"."memberships" "m" ON (("m"."entity_id" = "o"."entity_id")))
  WHERE (("r"."id" = "corrective_actions"."review_id") AND ("m"."user_id" = "auth"."uid"()) AND ("m"."role" = ANY (ARRAY['owner'::"text", 'director'::"text", 'auditor'::"text"]))))));



CREATE POLICY "actions_control_owner_read" ON "public"."corrective_actions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ((("public"."compliance_reviews" "r"
     JOIN "public"."compliance_obligations" "o" ON (("o"."id" = "r"."obligation_id")))
     JOIN "public"."entities" "e" ON (("e"."id" = "o"."entity_id")))
     JOIN "public"."profiles" "p" ON (("p"."entity_slug" = "e"."slug")))
  WHERE (("r"."id" = "corrective_actions"."review_id") AND ("p"."user_id" = "auth"."uid"()) AND ("p"."full_name" = "o"."control_owner")))));



ALTER TABLE "public"."actions_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "actions_log_owner_insert" ON "public"."actions_log" FOR INSERT WITH CHECK (("actor_uid" = "auth"."uid"()));



CREATE POLICY "actions_log_owner_select" ON "public"."actions_log" FOR SELECT USING (("actor_uid" = "auth"."uid"()));



CREATE POLICY "admin can update reviews" ON "public"."reviews" FOR UPDATE TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "admin full access" ON "public"."entities" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "admin full access" ON "public"."governance_ledger" USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."ai_entity_roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_entity_roles_delete_admin" ON "public"."ai_entity_roles" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."user_id" = "auth"."uid"()) AND ("m"."entity_id" = "ai_entity_roles"."entity_id") AND (("m"."is_admin" = true) OR ("m"."role" = 'owner'::"text"))))));



CREATE POLICY "ai_entity_roles_insert_admin" ON "public"."ai_entity_roles" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."user_id" = "auth"."uid"()) AND ("m"."entity_id" = "ai_entity_roles"."entity_id") AND (("m"."is_admin" = true) OR ("m"."role" = 'owner'::"text"))))));



CREATE POLICY "ai_entity_roles_read" ON "public"."ai_entity_roles" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."user_id" = "auth"."uid"()) AND ("m"."entity_id" = "ai_entity_roles"."entity_id")))));



CREATE POLICY "ai_entity_roles_update" ON "public"."ai_entity_roles" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."user_id" = "auth"."uid"()) AND ("m"."entity_id" = "ai_entity_roles"."entity_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."user_id" = "auth"."uid"()) AND ("m"."entity_id" = "ai_entity_roles"."entity_id")))));



CREATE POLICY "ai_entity_roles_write" ON "public"."ai_entity_roles" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."user_id" = "auth"."uid"()) AND ("m"."entity_id" = "ai_entity_roles"."entity_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."user_id" = "auth"."uid"()) AND ("m"."entity_id" = "ai_entity_roles"."entity_id")))));



ALTER TABLE "public"."ai_notes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_notes_owner_insert" ON "public"."ai_notes" FOR INSERT WITH CHECK (("created_by" = "auth"."uid"()));



CREATE POLICY "ai_notes_owner_select" ON "public"."ai_notes" FOR SELECT USING (("created_by" = "auth"."uid"()));



CREATE POLICY "ai_notes_owner_update" ON "public"."ai_notes" FOR UPDATE USING (("created_by" = "auth"."uid"())) WITH CHECK (("created_by" = "auth"."uid"()));



ALTER TABLE "public"."ai_summaries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "allow resolution access for adopt" ON "public"."resolutions" FOR SELECT USING (true);



CREATE POLICY "anon read menu items" ON "public"."menu_items" FOR SELECT TO "anon" USING (true);



CREATE POLICY "anon read menu_items" ON "public"."menu_items" FOR SELECT TO "anon" USING (true);



CREATE POLICY "anon read menu_translations" ON "public"."menu_translations" FOR SELECT TO "anon" USING (true);



CREATE POLICY "anon read publish" ON "public"."menu_publish" FOR SELECT TO "anon" USING (true);



CREATE POLICY "audit_log_board_read" ON "public"."compliance_audit_log" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (("public"."resolutions" "r"
     JOIN "public"."entities" "e" ON (("e"."id" = "r"."entity_id")))
     JOIN "public"."memberships" "m" ON (("m"."entity_id" = "e"."id")))
  WHERE (("r"."id" = "compliance_audit_log"."resolution_id") AND ("m"."user_id" = "auth"."uid"()) AND ("m"."role" = ANY (ARRAY['owner'::"text", 'director'::"text", 'auditor'::"text"]))))));



CREATE POLICY "audit_log_own_events_read" ON "public"."compliance_audit_log" FOR SELECT USING (((("context" ->> 'reviewer_id'::"text"))::"uuid" = "auth"."uid"()));



ALTER TABLE "public"."books" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."certificate_jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ci_genesis_documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ci_genesis_documents_all" ON "public"."ci_genesis_documents" USING (("session_id" IN ( SELECT "ci_genesis_sessions"."id"
   FROM "public"."ci_genesis_sessions"
  WHERE ("ci_genesis_sessions"."created_by" = "auth"."uid"())))) WITH CHECK (("session_id" IN ( SELECT "ci_genesis_sessions"."id"
   FROM "public"."ci_genesis_sessions"
  WHERE ("ci_genesis_sessions"."created_by" = "auth"."uid"()))));



ALTER TABLE "public"."ci_genesis_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ci_genesis_members_all" ON "public"."ci_genesis_members" USING (("session_id" IN ( SELECT "ci_genesis_sessions"."id"
   FROM "public"."ci_genesis_sessions"
  WHERE ("ci_genesis_sessions"."created_by" = "auth"."uid"())))) WITH CHECK (("session_id" IN ( SELECT "ci_genesis_sessions"."id"
   FROM "public"."ci_genesis_sessions"
  WHERE ("ci_genesis_sessions"."created_by" = "auth"."uid"()))));



ALTER TABLE "public"."ci_genesis_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ci_genesis_sessions_insert" ON "public"."ci_genesis_sessions" FOR INSERT WITH CHECK (("created_by" = "auth"."uid"()));



CREATE POLICY "ci_genesis_sessions_select" ON "public"."ci_genesis_sessions" FOR SELECT USING (("created_by" = "auth"."uid"()));



CREATE POLICY "ci_genesis_sessions_update" ON "public"."ci_genesis_sessions" FOR UPDATE USING (("created_by" = "auth"."uid"())) WITH CHECK (("created_by" = "auth"."uid"()));



ALTER TABLE "public"."ci_orb_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."compliance_audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."compliance_obligations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."compliance_reviews" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."corrections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."corrective_actions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "del_ledger_by_owner" ON "public"."governance_ledger" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "created_by"));



ALTER TABLE "public"."entities" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "entities_select_by_membership" ON "public"."entities" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."entity_id" = "entities"."id") AND ("m"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."financial_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "gov_docs_select_by_record_entity_membership" ON "public"."governance_documents" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."governance_ledger" "gl"
     JOIN "public"."memberships" "m" ON (("m"."entity_id" = "gl"."entity_id")))
  WHERE (("gl"."id" = "governance_documents"."record_id") AND ("m"."user_id" = "auth"."uid"())))));



CREATE POLICY "gov_ledger_insert_by_membership" ON "public"."governance_ledger" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."entity_id" = "governance_ledger"."entity_id") AND ("m"."user_id" = "auth"."uid"())))));



CREATE POLICY "gov_ledger_select_by_entity_membership" ON "public"."governance_ledger" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."entity_id" = "governance_ledger"."entity_id") AND ("m"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."governance_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."governance_ledger" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ins_actions_by_actor" ON "public"."actions_log" FOR INSERT TO "authenticated" WITH CHECK (("actor_uid" = "auth"."uid"()));



CREATE POLICY "ins_ai_notes_by_owner_or_null" ON "public"."ai_notes" FOR INSERT TO "authenticated" WITH CHECK ((("created_by" IS NULL) OR ("created_by" = "auth"."uid"())));



CREATE POLICY "ins_books_auth" ON "public"."books" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."entities" "e"
  WHERE ("e"."id" = "books"."entity_id"))));



CREATE POLICY "ins_ledger_by_auth" ON "public"."governance_ledger" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "created_by"));



CREATE POLICY "ins_resolutions_by_owner" ON "public"."resolutions" FOR INSERT TO "authenticated" WITH CHECK (("drafted_by" = "auth"."uid"()));



CREATE POLICY "ins_sections_auth" ON "public"."sections" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."books" "b"
  WHERE ("b"."id" = "sections"."entity_id"))));



CREATE POLICY "mb_read" ON "public"."minute_books" FOR SELECT USING ("public"."is_member_of"("entity_id"));



CREATE POLICY "mb_update" ON "public"."minute_books" FOR UPDATE USING ("public"."has_role"("entity_id", ARRAY['owner'::"text", 'director'::"text", 'clerk'::"text"])) WITH CHECK ("public"."has_role"("entity_id", ARRAY['owner'::"text", 'director'::"text", 'clerk'::"text"]));



CREATE POLICY "mb_write" ON "public"."minute_books" FOR INSERT WITH CHECK ("public"."has_role"("entity_id", ARRAY['owner'::"text", 'director'::"text", 'clerk'::"text"]));



CREATE POLICY "meet_read" ON "public"."meetings" FOR SELECT USING ("public"."is_member_of"("entity_id"));



CREATE POLICY "meet_update" ON "public"."meetings" FOR UPDATE USING ("public"."has_role"("entity_id", ARRAY['owner'::"text", 'director'::"text", 'clerk'::"text"])) WITH CHECK ("public"."has_role"("entity_id", ARRAY['owner'::"text", 'director'::"text", 'clerk'::"text"]));



CREATE POLICY "meet_write" ON "public"."meetings" FOR INSERT WITH CHECK ("public"."has_role"("entity_id", ARRAY['owner'::"text", 'director'::"text", 'clerk'::"text"]));



ALTER TABLE "public"."meetings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "meetings_select_by_entity_membership" ON "public"."meetings" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."entity_id" = "meetings"."entity_id") AND ("m"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."memberships" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "memberships_select_own" ON "public"."memberships" FOR SELECT USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."menu_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."menu_publish" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."menu_publish_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."menu_publish_items_backup" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."menu_translations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "minute_book insert" ON "public"."minute_book_entries" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."minute_book_members" "m"
  WHERE (("m"."user_id" = "auth"."uid"()) AND ("m"."entity_key" = ("minute_book_entries"."entity_key")::"text")))));



CREATE POLICY "minute_book read" ON "public"."minute_book_entries" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."minute_book_members" "m"
  WHERE (("m"."user_id" = "auth"."uid"()) AND ("m"."entity_key" = ("minute_book_entries"."entity_key")::"text")))));



ALTER TABLE "public"."minute_book_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."minute_book_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."minute_books" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "minute_books_select_by_entity_membership" ON "public"."minute_books" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."entity_id" = "minute_books"."entity_id") AND ("m"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."obligations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "obligations_board_full" ON "public"."compliance_obligations" USING ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."user_id" = "auth"."uid"()) AND ("m"."entity_id" = "compliance_obligations"."entity_id") AND ("m"."role" = ANY (ARRAY['owner'::"text", 'director'::"text", 'auditor'::"text"])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."user_id" = "auth"."uid"()) AND ("m"."entity_id" = "compliance_obligations"."entity_id") AND ("m"."role" = ANY (ARRAY['owner'::"text", 'director'::"text", 'auditor'::"text"]))))));



CREATE POLICY "obligations_control_owner_read" ON "public"."compliance_obligations" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."entities" "e" ON (("e"."slug" = "p"."entity_slug")))
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("e"."id" = "compliance_obligations"."entity_id") AND ("p"."full_name" = "compliance_obligations"."control_owner")))));



CREATE POLICY "obligations_delete_members" ON "public"."compliance_obligations" FOR DELETE TO "authenticated" USING (("entity_id" IN ( SELECT "m"."entity_id"
   FROM "public"."memberships" "m"
  WHERE ("m"."user_id" = "auth"."uid"()))));



CREATE POLICY "obligations_insert_members" ON "public"."compliance_obligations" FOR INSERT TO "authenticated" WITH CHECK (("entity_id" IN ( SELECT "m"."entity_id"
   FROM "public"."memberships" "m"
  WHERE ("m"."user_id" = "auth"."uid"()))));



CREATE POLICY "obligations_select_members" ON "public"."compliance_obligations" FOR SELECT TO "authenticated" USING (("entity_id" IN ( SELECT "m"."entity_id"
   FROM "public"."memberships" "m"
  WHERE ("m"."user_id" = "auth"."uid"()))));



CREATE POLICY "obligations_update_members" ON "public"."compliance_obligations" FOR UPDATE TO "authenticated" USING (("entity_id" IN ( SELECT "m"."entity_id"
   FROM "public"."memberships" "m"
  WHERE ("m"."user_id" = "auth"."uid"())))) WITH CHECK (("entity_id" IN ( SELECT "m"."entity_id"
   FROM "public"."memberships" "m"
  WHERE ("m"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."policy_rules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "public can create pending reviews" ON "public"."reviews" FOR INSERT TO "authenticated", "anon" WITH CHECK ((("status" = 'pending'::"text") AND (("rating" >= 1) AND ("rating" <= 5))));



CREATE POLICY "public can read approved reviews" ON "public"."reviews" FOR SELECT TO "authenticated", "anon" USING (("status" = 'approved'::"text"));



CREATE POLICY "public can read published items" ON "public"."menu_publish_items" FOR SELECT TO "authenticated", "anon" USING (("is_published" IS TRUE));



CREATE POLICY "public read menu" ON "public"."menu_publish_items" FOR SELECT TO "anon" USING (true);



CREATE POLICY "public read orb state" ON "public"."ci_orb_state" FOR SELECT USING (true);



CREATE POLICY "qr_read_publish" ON "public"."menu_publish" FOR SELECT USING (true);



CREATE POLICY "read_resolutions" ON "public"."resolutions" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "read_reviews" ON "public"."compliance_reviews" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."reasoning_traces" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "res_read" ON "public"."resolutions" FOR SELECT USING ("public"."is_member_of"("entity_id"));



CREATE POLICY "res_update" ON "public"."resolutions" FOR UPDATE USING ("public"."has_role"("entity_id", ARRAY['owner'::"text", 'director'::"text"])) WITH CHECK ("public"."has_role"("entity_id", ARRAY['owner'::"text", 'director'::"text"]));



CREATE POLICY "res_write" ON "public"."resolutions" FOR INSERT WITH CHECK ("public"."has_role"("entity_id", ARRAY['owner'::"text", 'director'::"text"]));



ALTER TABLE "public"."resolutions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "resolutions_insert_by_membership" ON "public"."resolutions" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."entity_id" = "resolutions"."entity_id") AND ("m"."user_id" = "auth"."uid"())))));



CREATE POLICY "resolutions_select_by_entity_membership" ON "public"."resolutions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."entity_id" = "resolutions"."entity_id") AND ("m"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."reviews" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reviews_board_full" ON "public"."compliance_reviews" USING ((EXISTS ( SELECT 1
   FROM ("public"."compliance_obligations" "o"
     JOIN "public"."memberships" "m" ON (("m"."entity_id" = "o"."entity_id")))
  WHERE (("o"."id" = "compliance_reviews"."obligation_id") AND ("m"."user_id" = "auth"."uid"()) AND ("m"."role" = ANY (ARRAY['owner'::"text", 'director'::"text", 'auditor'::"text"])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."compliance_obligations" "o"
     JOIN "public"."memberships" "m" ON (("m"."entity_id" = "o"."entity_id")))
  WHERE (("o"."id" = "compliance_reviews"."obligation_id") AND ("m"."user_id" = "auth"."uid"()) AND ("m"."role" = ANY (ARRAY['owner'::"text", 'director'::"text", 'auditor'::"text"]))))));



CREATE POLICY "reviews_control_owner_read" ON "public"."compliance_reviews" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (("public"."compliance_obligations" "o"
     JOIN "public"."entities" "e" ON (("e"."id" = "o"."entity_id")))
     JOIN "public"."profiles" "p" ON (("p"."entity_slug" = "e"."slug")))
  WHERE (("o"."id" = "compliance_reviews"."obligation_id") AND ("p"."user_id" = "auth"."uid"()) AND ("p"."full_name" = "o"."control_owner")))));



ALTER TABLE "public"."sections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sel_actions_any_auth" ON "public"."actions_log" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "sel_ai_notes_any_auth" ON "public"."ai_notes" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "sel_ledger_any_auth" ON "public"."governance_ledger" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "sel_resolutions_any_auth" ON "public"."resolutions" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "select audit by membership" ON "public"."signature_audit_log" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."signature_envelopes" "se"
     JOIN "public"."memberships" "m" ON (("m"."entity_id" = "se"."entity_id")))
  WHERE (("se"."id" = "signature_audit_log"."envelope_id") AND ("m"."user_id" = "auth"."uid"())))));



CREATE POLICY "select envelopes by membership" ON "public"."signature_envelopes" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."user_id" = "auth"."uid"()) AND ("m"."entity_id" = "signature_envelopes"."entity_id")))));



CREATE POLICY "select parties for visible envelopes" ON "public"."signature_parties" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."signature_envelopes" "se"
     JOIN "public"."memberships" "m" ON (("m"."entity_id" = "se"."entity_id")))
  WHERE (("se"."id" = "signature_parties"."envelope_id") AND ("m"."user_id" = "auth"."uid"())))));



CREATE POLICY "service-only access to certificate_jobs" ON "public"."certificate_jobs" TO "authenticated" USING (false) WITH CHECK (false);



CREATE POLICY "sig_envelopes_insert_by_membership" ON "public"."signature_envelopes" FOR INSERT WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."entity_id" = "signature_envelopes"."entity_id") AND ("m"."user_id" = "auth"."uid"())))) AND (EXISTS ( SELECT 1
   FROM "public"."governance_ledger" "gl"
  WHERE (("gl"."id" = "signature_envelopes"."record_id") AND ("gl"."entity_id" = "signature_envelopes"."entity_id"))))));



CREATE POLICY "sig_envelopes_select_by_entity_membership" ON "public"."signature_envelopes" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."entity_id" = "signature_envelopes"."entity_id") AND ("m"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."signature_audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."signature_email_queue" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."signature_envelope_status_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."signature_envelopes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."signature_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."signature_parties" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "upd_ledger_by_owner" ON "public"."governance_ledger" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "created_by"));



CREATE POLICY "upd_resolutions_by_owner" ON "public"."resolutions" FOR UPDATE TO "authenticated" USING (("drafted_by" = "auth"."uid"()));



CREATE POLICY "update orb state via function" ON "public"."ci_orb_state" FOR UPDATE USING (("auth"."role"() = 'service_role'::"text"));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";









GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



































































































































































































GRANT ALL ON FUNCTION "public"."_first_approved_attachment"("p_attachments" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."_first_approved_attachment"("p_attachments" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."_first_approved_attachment"("p_attachments" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."add_minute_book_doc"("p_entity_key" "text", "p_section" "text", "p_entry_type" "text", "p_storage_path" "text", "p_file_name" "text", "p_mime_type" "text", "p_file_size" bigint, "p_file_hash" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."add_minute_book_doc"("p_entity_key" "text", "p_section" "text", "p_entry_type" "text", "p_storage_path" "text", "p_file_name" "text", "p_mime_type" "text", "p_file_size" bigint, "p_file_hash" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."add_minute_book_doc"("p_entity_key" "text", "p_section" "text", "p_entry_type" "text", "p_storage_path" "text", "p_file_name" "text", "p_mime_type" "text", "p_file_size" bigint, "p_file_hash" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."adopt_resolution"("p_entity" "uuid", "p_resolution" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."adopt_resolution"("p_entity" "uuid", "p_resolution" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."adopt_resolution"("p_entity" "uuid", "p_resolution" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."advisor_check_and_log"("p_entity_slug" "text", "p_title" "text", "p_amount" numeric, "p_currency" "text", "p_attachment" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."advisor_check_and_log"("p_entity_slug" "text", "p_title" "text", "p_amount" numeric, "p_currency" "text", "p_attachment" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."advisor_check_and_log"("p_entity_slug" "text", "p_title" "text", "p_amount" numeric, "p_currency" "text", "p_attachment" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."advisor_check_basic"("p_entity_slug" "text", "p_title" "text", "p_amount" numeric, "p_currency" "text", "p_attachment" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."advisor_check_basic"("p_entity_slug" "text", "p_title" "text", "p_amount" numeric, "p_currency" "text", "p_attachment" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."advisor_check_basic"("p_entity_slug" "text", "p_title" "text", "p_amount" numeric, "p_currency" "text", "p_attachment" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."advisor_check_for_record"("p_record_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."advisor_check_for_record"("p_record_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."advisor_check_for_record"("p_record_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."apply_ai_advice_and_resolve"("p_max" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."apply_ai_advice_and_resolve"("p_max" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_ai_advice_and_resolve"("p_max" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."apply_retention_expiry"() TO "anon";
GRANT ALL ON FUNCTION "public"."apply_retention_expiry"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_retention_expiry"() TO "service_role";



GRANT ALL ON FUNCTION "public"."approve_compliance_review"("p_review_id" "uuid", "p_mark_compliant" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."approve_compliance_review"("p_review_id" "uuid", "p_mark_compliant" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."approve_compliance_review"("p_review_id" "uuid", "p_mark_compliant" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."approve_governance_ledger"("p_ledger_id" "uuid", "p_approver_name" "text", "p_approver_email" "text", "p_approver_role" "text", "p_decision" "text", "p_comment" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."approve_governance_ledger"("p_ledger_id" "uuid", "p_approver_name" "text", "p_approver_email" "text", "p_approver_role" "text", "p_decision" "text", "p_comment" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."approve_governance_ledger"("p_ledger_id" "uuid", "p_approver_name" "text", "p_approver_email" "text", "p_approver_role" "text", "p_decision" "text", "p_comment" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."approve_latest_obligation_review"("p_obligation_id" "uuid", "p_mark_compliant" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."approve_latest_obligation_review"("p_obligation_id" "uuid", "p_mark_compliant" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."approve_latest_obligation_review"("p_obligation_id" "uuid", "p_mark_compliant" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."audit_insert"() TO "anon";
GRANT ALL ON FUNCTION "public"."audit_insert"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."audit_insert"() TO "service_role";



GRANT ALL ON FUNCTION "public"."audit_row"() TO "anon";
GRANT ALL ON FUNCTION "public"."audit_row"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."audit_row"() TO "service_role";



GRANT ALL ON FUNCTION "public"."auto_create_corrective_actions_for_open_violations"() TO "anon";
GRANT ALL ON FUNCTION "public"."auto_create_corrective_actions_for_open_violations"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auto_create_corrective_actions_for_open_violations"() TO "service_role";



GRANT ALL ON FUNCTION "public"."block_audit_mutations"() TO "anon";
GRANT ALL ON FUNCTION "public"."block_audit_mutations"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."block_audit_mutations"() TO "service_role";



GRANT ALL ON FUNCTION "public"."block_party_changes_if_envelope_completed"() TO "anon";
GRANT ALL ON FUNCTION "public"."block_party_changes_if_envelope_completed"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."block_party_changes_if_envelope_completed"() TO "service_role";



GRANT ALL ON FUNCTION "public"."build_storage_path"("p_entity_slug" "text", "p_section" "text", "p_year" integer, "p_file_name" "text", "p_subfolder" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."build_storage_path"("p_entity_slug" "text", "p_section" "text", "p_year" integer, "p_file_name" "text", "p_subfolder" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."build_storage_path"("p_entity_slug" "text", "p_section" "text", "p_year" integer, "p_file_name" "text", "p_subfolder" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."bump_document_version"("p_record_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."bump_document_version"("p_record_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."bump_document_version"("p_record_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."can_role"("p_entity_slug" "text", "p_role_id" "text", "p_capability" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."can_role"("p_entity_slug" "text", "p_role_id" "text", "p_capability" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_role"("p_entity_slug" "text", "p_role_id" "text", "p_capability" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."can_role_debug"("p_entity_slug" "text", "p_role_id" "text", "p_capability" "text", "p_user" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."can_role_debug"("p_entity_slug" "text", "p_role_id" "text", "p_capability" "text", "p_user" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_role_debug"("p_entity_slug" "text", "p_role_id" "text", "p_capability" "text", "p_user" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."ci_genesis_finalize"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."ci_genesis_finalize"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ci_genesis_finalize"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."ci_genesis_start"("p_entity_name" "text", "p_primary_email" "text", "p_jurisdiction" "text", "p_actor_role" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."ci_genesis_start"("p_entity_name" "text", "p_primary_email" "text", "p_jurisdiction" "text", "p_actor_role" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ci_genesis_start"("p_entity_name" "text", "p_primary_email" "text", "p_jurisdiction" "text", "p_actor_role" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."ci_genesis_touch_session"() TO "anon";
GRANT ALL ON FUNCTION "public"."ci_genesis_touch_session"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."ci_genesis_touch_session"() TO "service_role";



GRANT ALL ON FUNCTION "public"."compliance_status_trigger"() TO "anon";
GRANT ALL ON FUNCTION "public"."compliance_status_trigger"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."compliance_status_trigger"() TO "service_role";



GRANT ALL ON FUNCTION "public"."compute_resolution_hash"("p_prior" "text", "p_title" "text", "p_body" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."compute_resolution_hash"("p_prior" "text", "p_title" "text", "p_body" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."compute_resolution_hash"("p_prior" "text", "p_title" "text", "p_body" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_resolution"("p_entity" "uuid", "p_minute_book" "uuid", "p_body" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_resolution"("p_entity" "uuid", "p_minute_book" "uuid", "p_body" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_resolution"("p_entity" "uuid", "p_minute_book" "uuid", "p_body" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_revised_governance_draft"("p_original_draft_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."create_revised_governance_draft"("p_original_draft_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_revised_governance_draft"("p_original_draft_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."draft_annual_board_approval"("p_entity_id" "uuid", "p_entity_name" "text", "p_fiscal_year" "text", "p_fiscal_year_end" "text", "p_meeting_date" "date", "p_directors" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."draft_annual_board_approval"("p_entity_id" "uuid", "p_entity_name" "text", "p_fiscal_year" "text", "p_fiscal_year_end" "text", "p_meeting_date" "date", "p_directors" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."draft_annual_board_approval"("p_entity_id" "uuid", "p_entity_name" "text", "p_fiscal_year" "text", "p_fiscal_year_end" "text", "p_meeting_date" "date", "p_directors" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."enforce_completed_envelope_immutability"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_completed_envelope_immutability"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_completed_envelope_immutability"() TO "service_role";



GRANT ALL ON FUNCTION "public"."enforce_council_before_ready_for_signature"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_council_before_ready_for_signature"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_council_before_ready_for_signature"() TO "service_role";



GRANT ALL ON FUNCTION "public"."enqueue_signature_email_for_party"() TO "anon";
GRANT ALL ON FUNCTION "public"."enqueue_signature_email_for_party"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enqueue_signature_email_for_party"() TO "service_role";



GRANT ALL ON FUNCTION "public"."entity_key_to_slug"("p_entity_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."entity_key_to_slug"("p_entity_key" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."entity_key_to_slug"("p_entity_key" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."finalize_governance_draft"("p_draft_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."finalize_governance_draft"("p_draft_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."finalize_governance_draft"("p_draft_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_update_resolution_status_from_review"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_update_resolution_status_from_review"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_update_resolution_status_from_review"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_all_missing_ai_advice"("p_model" "text", "p_risk_rating" numeric, "p_confidence" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."generate_all_missing_ai_advice"("p_model" "text", "p_risk_rating" numeric, "p_confidence" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_all_missing_ai_advice"("p_model" "text", "p_risk_rating" numeric, "p_confidence" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_entity_slug_for_record"("p_record_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_entity_slug_for_record"("p_record_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_entity_slug_for_record"("p_record_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."governance_ai_daily_cycle"("p_model" "text", "p_risk_rating" numeric, "p_confidence" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."governance_ai_daily_cycle"("p_model" "text", "p_risk_rating" numeric, "p_confidence" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."governance_ai_daily_cycle"("p_model" "text", "p_risk_rating" numeric, "p_confidence" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_adopt_resolution"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_adopt_resolution"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_adopt_resolution"() TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_resolution_transitions"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_resolution_transitions"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_resolution_transitions"() TO "service_role";



GRANT ALL ON FUNCTION "public"."has_role"("entity" "uuid", "roles" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."has_role"("entity" "uuid", "roles" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_role"("entity" "uuid", "roles" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."is_member_of"("entity" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_member_of"("entity" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_member_of"("entity" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."log_ai_sentinel_check"() TO "anon";
GRANT ALL ON FUNCTION "public"."log_ai_sentinel_check"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_ai_sentinel_check"() TO "service_role";



GRANT ALL ON FUNCTION "public"."log_ai_sentinel_heartbeat"() TO "anon";
GRANT ALL ON FUNCTION "public"."log_ai_sentinel_heartbeat"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_ai_sentinel_heartbeat"() TO "service_role";



GRANT ALL ON FUNCTION "public"."log_minute_book_entry_to_verified"() TO "anon";
GRANT ALL ON FUNCTION "public"."log_minute_book_entry_to_verified"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_minute_book_entry_to_verified"() TO "service_role";



GRANT ALL ON FUNCTION "public"."log_minute_book_update_to_verified"() TO "anon";
GRANT ALL ON FUNCTION "public"."log_minute_book_update_to_verified"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_minute_book_update_to_verified"() TO "service_role";



GRANT ALL ON FUNCTION "public"."log_minute_book_upload"() TO "anon";
GRANT ALL ON FUNCTION "public"."log_minute_book_upload"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_minute_book_upload"() TO "service_role";



GRANT ALL ON FUNCTION "public"."log_orb_event"("p_source" "text", "p_message" "text", "p_mode" "text", "p_meta" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."log_orb_event"("p_source" "text", "p_message" "text", "p_mode" "text", "p_meta" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_orb_event"("p_source" "text", "p_message" "text", "p_mode" "text", "p_meta" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."log_resolution_status_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."log_resolution_status_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_resolution_status_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."log_signature_envelope_status_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."log_signature_envelope_status_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_signature_envelope_status_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."mb_map_section"("src" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."mb_map_section"("src" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."mb_map_section"("src" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."mb_parse_filename"("fname" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."mb_parse_filename"("fname" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."mb_parse_filename"("fname" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_jsonb"("j" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_jsonb"("j" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_jsonb"("j" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."onboard_entity_for_user"("p_slug" "text", "p_name" "text", "p_user_email" "text", "p_kind" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."onboard_entity_for_user"("p_slug" "text", "p_name" "text", "p_user_email" "text", "p_kind" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."onboard_entity_for_user"("p_slug" "text", "p_name" "text", "p_user_email" "text", "p_kind" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."record_corrective_action_ai_advice"("p_risk_rating" numeric, "p_confidence" numeric, "p_model" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."record_corrective_action_ai_advice"("p_risk_rating" numeric, "p_confidence" numeric, "p_model" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_corrective_action_ai_advice"("p_risk_rating" numeric, "p_confidence" numeric, "p_model" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."record_corrective_action_ai_advice"("p_corrective_action_id" "uuid", "p_recommendation" "text", "p_risk_rating" numeric, "p_confidence" numeric, "p_model" "text", "p_ai_source" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."record_corrective_action_ai_advice"("p_corrective_action_id" "uuid", "p_recommendation" "text", "p_risk_rating" numeric, "p_confidence" numeric, "p_model" "text", "p_ai_source" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_corrective_action_ai_advice"("p_corrective_action_id" "uuid", "p_recommendation" "text", "p_risk_rating" numeric, "p_confidence" numeric, "p_model" "text", "p_ai_source" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."resolution_body_normalized"("p_body" "jsonb", "p_whereas" "jsonb", "p_resolve" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."resolution_body_normalized"("p_body" "jsonb", "p_whereas" "jsonb", "p_resolve" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolution_body_normalized"("p_body" "jsonb", "p_whereas" "jsonb", "p_resolve" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."resolution_chain_head"("p_entity" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."resolution_chain_head"("p_entity" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolution_chain_head"("p_entity" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."run_all_governance_validations"() TO "anon";
GRANT ALL ON FUNCTION "public"."run_all_governance_validations"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."run_all_governance_validations"() TO "service_role";



GRANT ALL ON FUNCTION "public"."run_validation_agm_annual"() TO "anon";
GRANT ALL ON FUNCTION "public"."run_validation_agm_annual"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."run_validation_agm_annual"() TO "service_role";



GRANT ALL ON FUNCTION "public"."run_validation_financial_statements_tabled"() TO "anon";
GRANT ALL ON FUNCTION "public"."run_validation_financial_statements_tabled"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."run_validation_financial_statements_tabled"() TO "service_role";



GRANT ALL ON FUNCTION "public"."run_validation_material_event_resolutions"() TO "anon";
GRANT ALL ON FUNCTION "public"."run_validation_material_event_resolutions"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."run_validation_material_event_resolutions"() TO "service_role";



GRANT ALL ON FUNCTION "public"."run_validation_minute_book_exists"() TO "anon";
GRANT ALL ON FUNCTION "public"."run_validation_minute_book_exists"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."run_validation_minute_book_exists"() TO "service_role";



GRANT ALL ON FUNCTION "public"."run_validation_parent_approval_for_child_material_events"() TO "anon";
GRANT ALL ON FUNCTION "public"."run_validation_parent_approval_for_child_material_events"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."run_validation_parent_approval_for_child_material_events"() TO "service_role";



GRANT ALL ON FUNCTION "public"."run_validation_t2_obligation"() TO "anon";
GRANT ALL ON FUNCTION "public"."run_validation_t2_obligation"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."run_validation_t2_obligation"() TO "service_role";



GRANT ALL ON FUNCTION "public"."schedule_due_compliance_reviews"() TO "anon";
GRANT ALL ON FUNCTION "public"."schedule_due_compliance_reviews"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."schedule_due_compliance_reviews"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_resolution_status_from_review"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_resolution_status_from_review"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_resolution_status_from_review"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_verified_documents_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_verified_documents_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_verified_documents_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_obligation_from_review"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_obligation_from_review"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_obligation_from_review"() TO "service_role";



GRANT ALL ON FUNCTION "public"."tg_resolutions_hash"() TO "anon";
GRANT ALL ON FUNCTION "public"."tg_resolutions_hash"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."tg_resolutions_hash"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_governance_draft_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_governance_draft_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_governance_draft_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_governance_policies_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_governance_policies_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_governance_policies_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_audit_compliance_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_audit_compliance_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_audit_compliance_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_governance_documents_after_ins"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_governance_documents_after_ins"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_governance_documents_after_ins"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_governance_documents_before_ins"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_governance_documents_before_ins"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_governance_documents_before_ins"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_log_compliance_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_log_compliance_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_log_compliance_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_normalize_low_to_compliant"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_normalize_low_to_compliant"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_normalize_low_to_compliant"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_set_status"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_set_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_set_status"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_supporting_documents_before_ins"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_supporting_documents_before_ins"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_supporting_documents_before_ins"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_ai_status"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_ai_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_ai_status"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_governance_documents_ocr_tsv"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_governance_documents_ocr_tsv"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_governance_documents_ocr_tsv"() TO "service_role";



GRANT ALL ON FUNCTION "public"."upload_minute_book_document"("p_entity_key" "public"."entity_key_enum", "p_entry_type" "public"."entry_type_enum", "p_title" "text", "p_notes" "text", "p_file_name" "text", "p_storage_path" "text", "p_file_hash" "text", "p_file_size" bigint, "p_mime_type" "text", "p_owner_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."upload_minute_book_document"("p_entity_key" "public"."entity_key_enum", "p_entry_type" "public"."entry_type_enum", "p_title" "text", "p_notes" "text", "p_file_name" "text", "p_storage_path" "text", "p_file_hash" "text", "p_file_size" bigint, "p_mime_type" "text", "p_owner_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."upload_minute_book_document"("p_entity_key" "public"."entity_key_enum", "p_entry_type" "public"."entry_type_enum", "p_title" "text", "p_notes" "text", "p_file_name" "text", "p_storage_path" "text", "p_file_hash" "text", "p_file_size" bigint, "p_mime_type" "text", "p_owner_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."upload_minute_book_document"("p_entity_key" "public"."entity_key_enum", "p_entry_type" "public"."entry_type_enum", "p_section" "public"."doc_section_enum", "p_title" "text", "p_notes" "text", "p_file_name" "text", "p_storage_path" "text", "p_file_hash" "text", "p_file_size" bigint, "p_mime_type" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."upload_minute_book_document"("p_entity_key" "public"."entity_key_enum", "p_entry_type" "public"."entry_type_enum", "p_section" "public"."doc_section_enum", "p_title" "text", "p_notes" "text", "p_file_name" "text", "p_storage_path" "text", "p_file_hash" "text", "p_file_size" bigint, "p_mime_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."upload_minute_book_document"("p_entity_key" "public"."entity_key_enum", "p_entry_type" "public"."entry_type_enum", "p_section" "public"."doc_section_enum", "p_title" "text", "p_notes" "text", "p_file_name" "text", "p_storage_path" "text", "p_file_hash" "text", "p_file_size" bigint, "p_mime_type" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."verify_resolution_hash"("p_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."verify_resolution_hash"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."verify_resolution_hash"("p_id" "uuid") TO "service_role";












GRANT ALL ON TABLE "public"."entities" TO "anon";
GRANT ALL ON TABLE "public"."entities" TO "authenticated";
GRANT ALL ON TABLE "public"."entities" TO "service_role";



GRANT SELECT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."governance_ledger" TO "anon";
GRANT SELECT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."governance_ledger" TO "authenticated";
GRANT ALL ON TABLE "public"."governance_ledger" TO "service_role";



GRANT ALL ON TABLE "public"."resolutions" TO "anon";
GRANT ALL ON TABLE "public"."resolutions" TO "authenticated";
GRANT ALL ON TABLE "public"."resolutions" TO "service_role";



GRANT ALL ON TABLE "public"."governance_documents" TO "anon";
GRANT ALL ON TABLE "public"."governance_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."governance_documents" TO "service_role";



GRANT ALL ON TABLE "public"."supporting_documents" TO "anon";
GRANT ALL ON TABLE "public"."supporting_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."supporting_documents" TO "service_role";



GRANT ALL ON TABLE "public"."signature_envelopes" TO "anon";
GRANT ALL ON TABLE "public"."signature_envelopes" TO "authenticated";
GRANT ALL ON TABLE "public"."signature_envelopes" TO "service_role";



GRANT ALL ON TABLE "public"."signature_events" TO "anon";
GRANT ALL ON TABLE "public"."signature_events" TO "authenticated";
GRANT ALL ON TABLE "public"."signature_events" TO "service_role";



GRANT ALL ON TABLE "public"."signatories" TO "anon";
GRANT ALL ON TABLE "public"."signatories" TO "authenticated";
GRANT ALL ON TABLE "public"."signatories" TO "service_role";



GRANT ALL ON TABLE "public"."signature_parties" TO "anon";
GRANT ALL ON TABLE "public"."signature_parties" TO "authenticated";
GRANT ALL ON TABLE "public"."signature_parties" TO "service_role";



GRANT ALL ON TABLE "public"."minute_book_entries" TO "anon";
GRANT ALL ON TABLE "public"."minute_book_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."minute_book_entries" TO "service_role";



GRANT ALL ON TABLE "public"."ai_advice" TO "anon";
GRANT ALL ON TABLE "public"."ai_advice" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_advice" TO "service_role";



GRANT ALL ON TABLE "public"."ai_analyses" TO "anon";
GRANT ALL ON TABLE "public"."ai_analyses" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_analyses" TO "service_role";



GRANT ALL ON TABLE "public"."ai_summaries" TO "anon";
GRANT ALL ON TABLE "public"."ai_summaries" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_summaries" TO "service_role";



GRANT ALL ON TABLE "public"."compliance_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."compliance_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."compliance_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."compliance_obligations" TO "anon";
GRANT ALL ON TABLE "public"."compliance_obligations" TO "authenticated";
GRANT ALL ON TABLE "public"."compliance_obligations" TO "service_role";



GRANT ALL ON TABLE "public"."iso_clauses" TO "anon";
GRANT ALL ON TABLE "public"."iso_clauses" TO "authenticated";
GRANT ALL ON TABLE "public"."iso_clauses" TO "service_role";



GRANT ALL ON TABLE "public"."compliance_reviews" TO "anon";
GRANT ALL ON TABLE "public"."compliance_reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."compliance_reviews" TO "service_role";



GRANT ALL ON TABLE "public"."governance_violations" TO "anon";
GRANT ALL ON TABLE "public"."governance_violations" TO "authenticated";
GRANT ALL ON TABLE "public"."governance_violations" TO "service_role";















GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."actions_log" TO "anon";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."actions_log" TO "authenticated";
GRANT ALL ON TABLE "public"."actions_log" TO "service_role";



GRANT ALL ON TABLE "public"."advisor_audit" TO "anon";
GRANT ALL ON TABLE "public"."advisor_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."advisor_audit" TO "service_role";



GRANT ALL ON TABLE "public"."ai_actions" TO "anon";
GRANT ALL ON TABLE "public"."ai_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_actions" TO "service_role";



GRANT ALL ON TABLE "public"."ai_advisor_overview" TO "anon";
GRANT ALL ON TABLE "public"."ai_advisor_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_advisor_overview" TO "service_role";



GRANT ALL ON TABLE "public"."ai_agent_bindings" TO "anon";
GRANT ALL ON TABLE "public"."ai_agent_bindings" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_agent_bindings" TO "service_role";



GRANT ALL ON TABLE "public"."ai_analysis_overview" TO "anon";
GRANT ALL ON TABLE "public"."ai_analysis_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_analysis_overview" TO "service_role";



GRANT ALL ON TABLE "public"."ai_entity_roles" TO "anon";
GRANT ALL ON TABLE "public"."ai_entity_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_entity_roles" TO "service_role";



GRANT ALL ON TABLE "public"."ai_feature_flags" TO "anon";
GRANT ALL ON TABLE "public"."ai_feature_flags" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_feature_flags" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."ai_notes" TO "anon";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."ai_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_notes" TO "service_role";



GRANT ALL ON TABLE "public"."ai_policy_versions" TO "anon";
GRANT ALL ON TABLE "public"."ai_policy_versions" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_policy_versions" TO "service_role";



GRANT ALL ON TABLE "public"."ai_roles" TO "anon";
GRANT ALL ON TABLE "public"."ai_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_roles" TO "service_role";



GRANT ALL ON TABLE "public"."ai_roles_backup" TO "anon";
GRANT ALL ON TABLE "public"."ai_roles_backup" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_roles_backup" TO "service_role";



GRANT ALL ON TABLE "public"."ai_sentinel_overview" TO "anon";
GRANT ALL ON TABLE "public"."ai_sentinel_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_sentinel_overview" TO "service_role";



GRANT ALL ON TABLE "public"."ai_sentinel_runs" TO "anon";
GRANT ALL ON TABLE "public"."ai_sentinel_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_sentinel_runs" TO "service_role";



GRANT ALL ON TABLE "public"."ai_sentinel_tasks" TO "anon";
GRANT ALL ON TABLE "public"."ai_sentinel_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_sentinel_tasks" TO "service_role";



GRANT ALL ON TABLE "public"."ai_sentinel_record_status" TO "anon";
GRANT ALL ON TABLE "public"."ai_sentinel_record_status" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_sentinel_record_status" TO "service_role";



GRANT ALL ON TABLE "public"."ai_status_debug" TO "anon";
GRANT ALL ON TABLE "public"."ai_status_debug" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_status_debug" TO "service_role";



GRANT ALL ON TABLE "public"."ai_summary_overview" TO "anon";
GRANT ALL ON TABLE "public"."ai_summary_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_summary_overview" TO "service_role";



GRANT ALL ON TABLE "public"."audit_logs" TO "anon";
GRANT ALL ON TABLE "public"."audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."audit_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."audit_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."audit_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."audit_trail" TO "anon";
GRANT ALL ON TABLE "public"."audit_trail" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_trail" TO "service_role";



GRANT ALL ON SEQUENCE "public"."audit_trail_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."audit_trail_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."audit_trail_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."books" TO "anon";
GRANT ALL ON TABLE "public"."books" TO "authenticated";
GRANT ALL ON TABLE "public"."books" TO "service_role";



GRANT ALL ON TABLE "public"."certificate_jobs" TO "anon";
GRANT ALL ON TABLE "public"."certificate_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."certificate_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."ci_archive_documents" TO "anon";
GRANT ALL ON TABLE "public"."ci_archive_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_archive_documents" TO "service_role";



GRANT ALL ON TABLE "public"."ci_archive_supporting_docs" TO "anon";
GRANT ALL ON TABLE "public"."ci_archive_supporting_docs" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_archive_supporting_docs" TO "service_role";



GRANT ALL ON TABLE "public"."ci_edge_functions" TO "anon";
GRANT ALL ON TABLE "public"."ci_edge_functions" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_edge_functions" TO "service_role";



GRANT ALL ON TABLE "public"."ci_forge_envelopes" TO "anon";
GRANT ALL ON TABLE "public"."ci_forge_envelopes" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_forge_envelopes" TO "service_role";



GRANT ALL ON TABLE "public"."ci_forge_events" TO "anon";
GRANT ALL ON TABLE "public"."ci_forge_events" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_forge_events" TO "service_role";



GRANT ALL ON TABLE "public"."ci_forge_parties" TO "anon";
GRANT ALL ON TABLE "public"."ci_forge_parties" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_forge_parties" TO "service_role";



GRANT ALL ON TABLE "public"."ci_genesis_documents" TO "anon";
GRANT ALL ON TABLE "public"."ci_genesis_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_genesis_documents" TO "service_role";



GRANT ALL ON TABLE "public"."ci_genesis_members" TO "anon";
GRANT ALL ON TABLE "public"."ci_genesis_members" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_genesis_members" TO "service_role";



GRANT ALL ON TABLE "public"."ci_genesis_sessions" TO "anon";
GRANT ALL ON TABLE "public"."ci_genesis_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_genesis_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."ci_ledger_records" TO "anon";
GRANT ALL ON TABLE "public"."ci_ledger_records" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_ledger_records" TO "service_role";



GRANT ALL ON TABLE "public"."ci_modules_registry" TO "anon";
GRANT ALL ON TABLE "public"."ci_modules_registry" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_modules_registry" TO "service_role";



GRANT ALL ON TABLE "public"."ci_oracle_advice" TO "anon";
GRANT ALL ON TABLE "public"."ci_oracle_advice" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_oracle_advice" TO "service_role";



GRANT ALL ON TABLE "public"."ci_oracle_analyses" TO "anon";
GRANT ALL ON TABLE "public"."ci_oracle_analyses" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_oracle_analyses" TO "service_role";



GRANT ALL ON TABLE "public"."ci_oracle_summaries" TO "anon";
GRANT ALL ON TABLE "public"."ci_oracle_summaries" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_oracle_summaries" TO "service_role";



GRANT ALL ON TABLE "public"."ci_orb_events" TO "anon";
GRANT ALL ON TABLE "public"."ci_orb_events" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_orb_events" TO "service_role";



GRANT ALL ON TABLE "public"."ci_orb_logs" TO "anon";
GRANT ALL ON TABLE "public"."ci_orb_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_orb_logs" TO "service_role";



GRANT ALL ON TABLE "public"."ci_orb_state" TO "anon";
GRANT ALL ON TABLE "public"."ci_orb_state" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_orb_state" TO "service_role";



GRANT ALL ON TABLE "public"."ci_sentinel_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."ci_sentinel_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_sentinel_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."ci_sentinel_obligations" TO "anon";
GRANT ALL ON TABLE "public"."ci_sentinel_obligations" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_sentinel_obligations" TO "service_role";



GRANT ALL ON TABLE "public"."ci_sentinel_reviews" TO "anon";
GRANT ALL ON TABLE "public"."ci_sentinel_reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_sentinel_reviews" TO "service_role";



GRANT ALL ON TABLE "public"."ci_suite_modules" TO "anon";
GRANT ALL ON TABLE "public"."ci_suite_modules" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_suite_modules" TO "service_role";



GRANT ALL ON TABLE "public"."ci_tables_registry" TO "anon";
GRANT ALL ON TABLE "public"."ci_tables_registry" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_tables_registry" TO "service_role";



GRANT ALL ON TABLE "public"."compliance_rule_sets" TO "anon";
GRANT ALL ON TABLE "public"."compliance_rule_sets" TO "authenticated";
GRANT ALL ON TABLE "public"."compliance_rule_sets" TO "service_role";



GRANT ALL ON TABLE "public"."constitutional_objects" TO "anon";
GRANT ALL ON TABLE "public"."constitutional_objects" TO "authenticated";
GRANT ALL ON TABLE "public"."constitutional_objects" TO "service_role";



GRANT ALL ON TABLE "public"."corrections" TO "anon";
GRANT ALL ON TABLE "public"."corrections" TO "authenticated";
GRANT ALL ON TABLE "public"."corrections" TO "service_role";



GRANT ALL ON TABLE "public"."corrective_actions" TO "anon";
GRANT ALL ON TABLE "public"."corrective_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."corrective_actions" TO "service_role";



GRANT ALL ON TABLE "public"."doc_section_pillars" TO "anon";
GRANT ALL ON TABLE "public"."doc_section_pillars" TO "authenticated";
GRANT ALL ON TABLE "public"."doc_section_pillars" TO "service_role";



GRANT ALL ON TABLE "public"."document_links" TO "anon";
GRANT ALL ON TABLE "public"."document_links" TO "authenticated";
GRANT ALL ON TABLE "public"."document_links" TO "service_role";



GRANT ALL ON TABLE "public"."document_retention_policies" TO "anon";
GRANT ALL ON TABLE "public"."document_retention_policies" TO "authenticated";
GRANT ALL ON TABLE "public"."document_retention_policies" TO "service_role";



GRANT ALL ON TABLE "public"."entities_backup" TO "anon";
GRANT ALL ON TABLE "public"."entities_backup" TO "authenticated";
GRANT ALL ON TABLE "public"."entities_backup" TO "service_role";



GRANT ALL ON TABLE "public"."entity_companies" TO "anon";
GRANT ALL ON TABLE "public"."entity_companies" TO "authenticated";
GRANT ALL ON TABLE "public"."entity_companies" TO "service_role";



GRANT ALL ON TABLE "public"."entity_relationships" TO "anon";
GRANT ALL ON TABLE "public"."entity_relationships" TO "authenticated";
GRANT ALL ON TABLE "public"."entity_relationships" TO "service_role";



GRANT ALL ON TABLE "public"."entry_signers" TO "anon";
GRANT ALL ON TABLE "public"."entry_signers" TO "authenticated";
GRANT ALL ON TABLE "public"."entry_signers" TO "service_role";



GRANT ALL ON TABLE "public"."entry_type_default_section" TO "anon";
GRANT ALL ON TABLE "public"."entry_type_default_section" TO "authenticated";
GRANT ALL ON TABLE "public"."entry_type_default_section" TO "service_role";



GRANT ALL ON TABLE "public"."financial_events" TO "anon";
GRANT ALL ON TABLE "public"."financial_events" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_events" TO "service_role";



GRANT ALL ON TABLE "public"."governance_approvals" TO "anon";
GRANT ALL ON TABLE "public"."governance_approvals" TO "authenticated";
GRANT ALL ON TABLE "public"."governance_approvals" TO "service_role";



GRANT ALL ON TABLE "public"."governance_drafts" TO "anon";
GRANT ALL ON TABLE "public"."governance_drafts" TO "authenticated";
GRANT ALL ON TABLE "public"."governance_drafts" TO "service_role";



GRANT ALL ON TABLE "public"."governance_policies" TO "anon";
GRANT ALL ON TABLE "public"."governance_policies" TO "authenticated";
GRANT ALL ON TABLE "public"."governance_policies" TO "service_role";



GRANT ALL ON SEQUENCE "public"."governance_policies_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."governance_policies_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."governance_policies_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."governance_requirements" TO "anon";
GRANT ALL ON TABLE "public"."governance_requirements" TO "authenticated";
GRANT ALL ON TABLE "public"."governance_requirements" TO "service_role";



GRANT ALL ON TABLE "public"."governance_standards" TO "anon";
GRANT ALL ON TABLE "public"."governance_standards" TO "authenticated";
GRANT ALL ON TABLE "public"."governance_standards" TO "service_role";



GRANT ALL ON TABLE "public"."governance_templates" TO "anon";
GRANT ALL ON TABLE "public"."governance_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."governance_templates" TO "service_role";



GRANT ALL ON TABLE "public"."governance_validations" TO "anon";
GRANT ALL ON TABLE "public"."governance_validations" TO "authenticated";
GRANT ALL ON TABLE "public"."governance_validations" TO "service_role";



GRANT ALL ON TABLE "public"."legal_policy_links" TO "anon";
GRANT ALL ON TABLE "public"."legal_policy_links" TO "authenticated";
GRANT ALL ON TABLE "public"."legal_policy_links" TO "service_role";



GRANT ALL ON TABLE "public"."legal_record_links" TO "anon";
GRANT ALL ON TABLE "public"."legal_record_links" TO "authenticated";
GRANT ALL ON TABLE "public"."legal_record_links" TO "service_role";



GRANT ALL ON TABLE "public"."legal_sources" TO "anon";
GRANT ALL ON TABLE "public"."legal_sources" TO "authenticated";
GRANT ALL ON TABLE "public"."legal_sources" TO "service_role";



GRANT ALL ON TABLE "public"."meetings" TO "anon";
GRANT ALL ON TABLE "public"."meetings" TO "authenticated";
GRANT ALL ON TABLE "public"."meetings" TO "service_role";



GRANT ALL ON TABLE "public"."memberships" TO "anon";
GRANT ALL ON TABLE "public"."memberships" TO "authenticated";
GRANT ALL ON TABLE "public"."memberships" TO "service_role";



GRANT ALL ON TABLE "public"."menu_items" TO "anon";
GRANT ALL ON TABLE "public"."menu_items" TO "authenticated";
GRANT ALL ON TABLE "public"."menu_items" TO "service_role";



GRANT ALL ON TABLE "public"."menu_publish" TO "anon";
GRANT ALL ON TABLE "public"."menu_publish" TO "authenticated";
GRANT ALL ON TABLE "public"."menu_publish" TO "service_role";



GRANT ALL ON TABLE "public"."menu_publish_items" TO "anon";
GRANT ALL ON TABLE "public"."menu_publish_items" TO "authenticated";
GRANT ALL ON TABLE "public"."menu_publish_items" TO "service_role";



GRANT ALL ON TABLE "public"."menu_publish_items_backup" TO "anon";
GRANT ALL ON TABLE "public"."menu_publish_items_backup" TO "authenticated";
GRANT ALL ON TABLE "public"."menu_publish_items_backup" TO "service_role";



GRANT ALL ON TABLE "public"."menu_translations" TO "anon";
GRANT ALL ON TABLE "public"."menu_translations" TO "authenticated";
GRANT ALL ON TABLE "public"."menu_translations" TO "service_role";



GRANT ALL ON SEQUENCE "public"."menu_translations_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."menu_translations_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."menu_translations_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."metadata_sources" TO "anon";
GRANT ALL ON TABLE "public"."metadata_sources" TO "authenticated";
GRANT ALL ON TABLE "public"."metadata_sources" TO "service_role";



GRANT ALL ON TABLE "public"."minute_book_members" TO "anon";
GRANT ALL ON TABLE "public"."minute_book_members" TO "authenticated";
GRANT ALL ON TABLE "public"."minute_book_members" TO "service_role";



GRANT ALL ON TABLE "public"."minute_books" TO "anon";
GRANT ALL ON TABLE "public"."minute_books" TO "authenticated";
GRANT ALL ON TABLE "public"."minute_books" TO "service_role";



GRANT ALL ON TABLE "public"."obligations" TO "anon";
GRANT ALL ON TABLE "public"."obligations" TO "authenticated";
GRANT ALL ON TABLE "public"."obligations" TO "service_role";



GRANT ALL ON TABLE "public"."people" TO "anon";
GRANT ALL ON TABLE "public"."people" TO "authenticated";
GRANT ALL ON TABLE "public"."people" TO "service_role";



GRANT ALL ON TABLE "public"."policy_rules" TO "anon";
GRANT ALL ON TABLE "public"."policy_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."policy_rules" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."reasoning_traces" TO "anon";
GRANT ALL ON TABLE "public"."reasoning_traces" TO "authenticated";
GRANT ALL ON TABLE "public"."reasoning_traces" TO "service_role";



GRANT ALL ON TABLE "public"."resolution_status_history" TO "anon";
GRANT ALL ON TABLE "public"."resolution_status_history" TO "authenticated";
GRANT ALL ON TABLE "public"."resolution_status_history" TO "service_role";



GRANT ALL ON TABLE "public"."reviews" TO "anon";
GRANT ALL ON TABLE "public"."reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."reviews" TO "service_role";



GRANT ALL ON TABLE "public"."schema_change_approvals" TO "anon";
GRANT ALL ON TABLE "public"."schema_change_approvals" TO "authenticated";
GRANT ALL ON TABLE "public"."schema_change_approvals" TO "service_role";



GRANT ALL ON TABLE "public"."schema_change_log" TO "anon";
GRANT ALL ON TABLE "public"."schema_change_log" TO "authenticated";
GRANT ALL ON TABLE "public"."schema_change_log" TO "service_role";



GRANT ALL ON TABLE "public"."sections" TO "anon";
GRANT ALL ON TABLE "public"."sections" TO "authenticated";
GRANT ALL ON TABLE "public"."sections" TO "service_role";



GRANT ALL ON TABLE "public"."signature_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."signature_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."signature_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."signature_email_queue" TO "anon";
GRANT ALL ON TABLE "public"."signature_email_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."signature_email_queue" TO "service_role";



GRANT ALL ON TABLE "public"."signature_envelope_status_history" TO "anon";
GRANT ALL ON TABLE "public"."signature_envelope_status_history" TO "authenticated";
GRANT ALL ON TABLE "public"."signature_envelope_status_history" TO "service_role";



GRANT ALL ON TABLE "public"."system_config" TO "anon";
GRANT ALL ON TABLE "public"."system_config" TO "authenticated";
GRANT ALL ON TABLE "public"."system_config" TO "service_role";



GRANT ALL ON TABLE "public"."v_ai_agent_config" TO "anon";
GRANT ALL ON TABLE "public"."v_ai_agent_config" TO "authenticated";
GRANT ALL ON TABLE "public"."v_ai_agent_config" TO "service_role";



GRANT ALL ON TABLE "public"."v_ai_governance_pipeline" TO "anon";
GRANT ALL ON TABLE "public"."v_ai_governance_pipeline" TO "authenticated";
GRANT ALL ON TABLE "public"."v_ai_governance_pipeline" TO "service_role";



GRANT ALL ON TABLE "public"."v_ai_matrix" TO "anon";
GRANT ALL ON TABLE "public"."v_ai_matrix" TO "authenticated";
GRANT ALL ON TABLE "public"."v_ai_matrix" TO "service_role";



GRANT ALL ON TABLE "public"."v_compliance_obligation_health" TO "anon";
GRANT ALL ON TABLE "public"."v_compliance_obligation_health" TO "authenticated";
GRANT ALL ON TABLE "public"."v_compliance_obligation_health" TO "service_role";



GRANT ALL ON TABLE "public"."v_ai_sentinel_dashboard" TO "anon";
GRANT ALL ON TABLE "public"."v_ai_sentinel_dashboard" TO "authenticated";
GRANT ALL ON TABLE "public"."v_ai_sentinel_dashboard" TO "service_role";



GRANT ALL ON TABLE "public"."v_ai_sentinel_status" TO "anon";
GRANT ALL ON TABLE "public"."v_ai_sentinel_status" TO "authenticated";
GRANT ALL ON TABLE "public"."v_ai_sentinel_status" TO "service_role";



GRANT ALL ON TABLE "public"."v_all_corporate_documents" TO "anon";
GRANT ALL ON TABLE "public"."v_all_corporate_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."v_all_corporate_documents" TO "service_role";



GRANT ALL ON TABLE "public"."v_governance_all_documents" TO "anon";
GRANT ALL ON TABLE "public"."v_governance_all_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."v_governance_all_documents" TO "service_role";



GRANT ALL ON TABLE "public"."v_archive_documents" TO "anon";
GRANT ALL ON TABLE "public"."v_archive_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."v_archive_documents" TO "service_role";



GRANT ALL ON TABLE "public"."v_audit_feed" TO "anon";
GRANT ALL ON TABLE "public"."v_audit_feed" TO "authenticated";
GRANT ALL ON TABLE "public"."v_audit_feed" TO "service_role";



GRANT ALL ON TABLE "public"."v_ci_alchemy_drafts" TO "anon";
GRANT ALL ON TABLE "public"."v_ci_alchemy_drafts" TO "authenticated";
GRANT ALL ON TABLE "public"."v_ci_alchemy_drafts" TO "service_role";



GRANT ALL ON TABLE "public"."v_ci_archive_documents" TO "anon";
GRANT ALL ON TABLE "public"."v_ci_archive_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."v_ci_archive_documents" TO "service_role";



GRANT ALL ON TABLE "public"."v_ci_forge_envelopes" TO "anon";
GRANT ALL ON TABLE "public"."v_ci_forge_envelopes" TO "authenticated";
GRANT ALL ON TABLE "public"."v_ci_forge_envelopes" TO "service_role";



GRANT ALL ON TABLE "public"."v_ci_oracle_reviews" TO "anon";
GRANT ALL ON TABLE "public"."v_ci_oracle_reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."v_ci_oracle_reviews" TO "service_role";



GRANT ALL ON TABLE "public"."v_ci_sentinel_obligation_health" TO "anon";
GRANT ALL ON TABLE "public"."v_ci_sentinel_obligation_health" TO "authenticated";
GRANT ALL ON TABLE "public"."v_ci_sentinel_obligation_health" TO "service_role";



GRANT ALL ON TABLE "public"."v_ci_suite_map" TO "anon";
GRANT ALL ON TABLE "public"."v_ci_suite_map" TO "authenticated";
GRANT ALL ON TABLE "public"."v_ci_suite_map" TO "service_role";



GRANT ALL ON TABLE "public"."v_compliance_audit_feed" TO "anon";
GRANT ALL ON TABLE "public"."v_compliance_audit_feed" TO "authenticated";
GRANT ALL ON TABLE "public"."v_compliance_audit_feed" TO "service_role";



GRANT ALL ON TABLE "public"."v_latest_reviews" TO "anon";
GRANT ALL ON TABLE "public"."v_latest_reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."v_latest_reviews" TO "service_role";



GRANT ALL ON TABLE "public"."v_compliance_kpis" TO "anon";
GRANT ALL ON TABLE "public"."v_compliance_kpis" TO "authenticated";
GRANT ALL ON TABLE "public"."v_compliance_kpis" TO "service_role";



GRANT ALL ON TABLE "public"."v_compliance_reviews_with_policies" TO "anon";
GRANT ALL ON TABLE "public"."v_compliance_reviews_with_policies" TO "authenticated";
GRANT ALL ON TABLE "public"."v_compliance_reviews_with_policies" TO "service_role";



GRANT ALL ON TABLE "public"."v_schema_amendments" TO "anon";
GRANT ALL ON TABLE "public"."v_schema_amendments" TO "authenticated";
GRANT ALL ON TABLE "public"."v_schema_amendments" TO "service_role";



GRANT ALL ON TABLE "public"."v_constitutional_amendments" TO "anon";
GRANT ALL ON TABLE "public"."v_constitutional_amendments" TO "authenticated";
GRANT ALL ON TABLE "public"."v_constitutional_amendments" TO "service_role";



GRANT ALL ON TABLE "public"."v_corrective_action_ai_context" TO "anon";
GRANT ALL ON TABLE "public"."v_corrective_action_ai_context" TO "authenticated";
GRANT ALL ON TABLE "public"."v_corrective_action_ai_context" TO "service_role";



GRANT ALL ON TABLE "public"."v_corrective_action_ai_status" TO "anon";
GRANT ALL ON TABLE "public"."v_corrective_action_ai_status" TO "authenticated";
GRANT ALL ON TABLE "public"."v_corrective_action_ai_status" TO "service_role";



GRANT ALL ON TABLE "public"."v_corrective_action_queue" TO "anon";
GRANT ALL ON TABLE "public"."v_corrective_action_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."v_corrective_action_queue" TO "service_role";



GRANT ALL ON TABLE "public"."v_corrective_actions_needing_ai" TO "anon";
GRANT ALL ON TABLE "public"."v_corrective_actions_needing_ai" TO "authenticated";
GRANT ALL ON TABLE "public"."v_corrective_actions_needing_ai" TO "service_role";



GRANT ALL ON TABLE "public"."v_council_feed" TO "anon";
GRANT ALL ON TABLE "public"."v_council_feed" TO "authenticated";
GRANT ALL ON TABLE "public"."v_council_feed" TO "service_role";



GRANT ALL ON TABLE "public"."v_council_feed_colored" TO "anon";
GRANT ALL ON TABLE "public"."v_council_feed_colored" TO "authenticated";
GRANT ALL ON TABLE "public"."v_council_feed_colored" TO "service_role";



GRANT ALL ON TABLE "public"."v_current_user_entities" TO "anon";
GRANT ALL ON TABLE "public"."v_current_user_entities" TO "authenticated";
GRANT ALL ON TABLE "public"."v_current_user_entities" TO "service_role";



GRANT ALL ON TABLE "public"."v_doc_sections_with_pillar" TO "anon";
GRANT ALL ON TABLE "public"."v_doc_sections_with_pillar" TO "authenticated";
GRANT ALL ON TABLE "public"."v_doc_sections_with_pillar" TO "service_role";



GRANT ALL ON TABLE "public"."v_entity_compliance_health" TO "anon";
GRANT ALL ON TABLE "public"."v_entity_compliance_health" TO "authenticated";
GRANT ALL ON TABLE "public"."v_entity_compliance_health" TO "service_role";



GRANT ALL ON TABLE "public"."v_entity_compliance_overview" TO "anon";
GRANT ALL ON TABLE "public"."v_entity_compliance_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."v_entity_compliance_overview" TO "service_role";



GRANT ALL ON TABLE "public"."v_entity_compliance_reviews" TO "anon";
GRANT ALL ON TABLE "public"."v_entity_compliance_reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."v_entity_compliance_reviews" TO "service_role";



GRANT ALL ON TABLE "public"."v_entity_documents" TO "anon";
GRANT ALL ON TABLE "public"."v_entity_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."v_entity_documents" TO "service_role";



GRANT ALL ON TABLE "public"."v_entity_obligations_matrix" TO "anon";
GRANT ALL ON TABLE "public"."v_entity_obligations_matrix" TO "authenticated";
GRANT ALL ON TABLE "public"."v_entity_obligations_matrix" TO "service_role";



GRANT ALL ON TABLE "public"."v_entity_structure" TO "anon";
GRANT ALL ON TABLE "public"."v_entity_structure" TO "authenticated";
GRANT ALL ON TABLE "public"."v_entity_structure" TO "service_role";



GRANT ALL ON TABLE "public"."v_entity_violation_overview" TO "anon";
GRANT ALL ON TABLE "public"."v_entity_violation_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."v_entity_violation_overview" TO "service_role";



GRANT ALL ON TABLE "public"."v_envelope_status" TO "anon";
GRANT ALL ON TABLE "public"."v_envelope_status" TO "authenticated";
GRANT ALL ON TABLE "public"."v_envelope_status" TO "service_role";



GRANT ALL ON TABLE "public"."v_forge_queue" TO "anon";
GRANT ALL ON TABLE "public"."v_forge_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."v_forge_queue" TO "service_role";



GRANT ALL ON TABLE "public"."v_forge_queue_latest" TO "anon";
GRANT ALL ON TABLE "public"."v_forge_queue_latest" TO "authenticated";
GRANT ALL ON TABLE "public"."v_forge_queue_latest" TO "service_role";



GRANT ALL ON TABLE "public"."v_forge_execution_risk" TO "anon";
GRANT ALL ON TABLE "public"."v_forge_execution_risk" TO "authenticated";
GRANT ALL ON TABLE "public"."v_forge_execution_risk" TO "service_role";



GRANT ALL ON TABLE "public"."v_forge_pipeline" TO "anon";
GRANT ALL ON TABLE "public"."v_forge_pipeline" TO "authenticated";
GRANT ALL ON TABLE "public"."v_forge_pipeline" TO "service_role";



GRANT ALL ON TABLE "public"."v_governance_ai_last_runs" TO "anon";
GRANT ALL ON TABLE "public"."v_governance_ai_last_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."v_governance_ai_last_runs" TO "service_role";



GRANT ALL ON TABLE "public"."v_governance_drafts_for_signing" TO "anon";
GRANT ALL ON TABLE "public"."v_governance_drafts_for_signing" TO "authenticated";
GRANT ALL ON TABLE "public"."v_governance_drafts_for_signing" TO "service_role";



GRANT ALL ON TABLE "public"."v_governance_record_documents" TO "anon";
GRANT ALL ON TABLE "public"."v_governance_record_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."v_governance_record_documents" TO "service_role";



GRANT ALL ON TABLE "public"."v_iso_audit_feed" TO "anon";
GRANT ALL ON TABLE "public"."v_iso_audit_feed" TO "authenticated";
GRANT ALL ON TABLE "public"."v_iso_audit_feed" TO "service_role";



GRANT ALL ON TABLE "public"."v_iso_clause_gaps" TO "anon";
GRANT ALL ON TABLE "public"."v_iso_clause_gaps" TO "authenticated";
GRANT ALL ON TABLE "public"."v_iso_clause_gaps" TO "service_role";



GRANT ALL ON TABLE "public"."v_iso_compliance_overview" TO "anon";
GRANT ALL ON TABLE "public"."v_iso_compliance_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."v_iso_compliance_overview" TO "service_role";



GRANT ALL ON TABLE "public"."v_iso_control_schedule" TO "anon";
GRANT ALL ON TABLE "public"."v_iso_control_schedule" TO "authenticated";
GRANT ALL ON TABLE "public"."v_iso_control_schedule" TO "service_role";



GRANT ALL ON TABLE "public"."v_iso_obligations_dashboard" TO "anon";
GRANT ALL ON TABLE "public"."v_iso_obligations_dashboard" TO "authenticated";
GRANT ALL ON TABLE "public"."v_iso_obligations_dashboard" TO "service_role";



GRANT ALL ON TABLE "public"."v_iso_obligations_status" TO "anon";
GRANT ALL ON TABLE "public"."v_iso_obligations_status" TO "authenticated";
GRANT ALL ON TABLE "public"."v_iso_obligations_status" TO "service_role";



GRANT ALL ON TABLE "public"."v_iso_risk_matrix" TO "anon";
GRANT ALL ON TABLE "public"."v_iso_risk_matrix" TO "authenticated";
GRANT ALL ON TABLE "public"."v_iso_risk_matrix" TO "service_role";



GRANT ALL ON TABLE "public"."v_latest_notes" TO "anon";
GRANT ALL ON TABLE "public"."v_latest_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."v_latest_notes" TO "service_role";



GRANT ALL ON TABLE "public"."v_legal_briefs" TO "anon";
GRANT ALL ON TABLE "public"."v_legal_briefs" TO "authenticated";
GRANT ALL ON TABLE "public"."v_legal_briefs" TO "service_role";



GRANT ALL ON TABLE "public"."v_menu_categories" TO "anon";
GRANT ALL ON TABLE "public"."v_menu_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."v_menu_categories" TO "service_role";



GRANT ALL ON TABLE "public"."v_menu_item_ratings" TO "anon";
GRANT ALL ON TABLE "public"."v_menu_item_ratings" TO "authenticated";
GRANT ALL ON TABLE "public"."v_menu_item_ratings" TO "service_role";



GRANT ALL ON TABLE "public"."v_menu_list" TO "anon";
GRANT ALL ON TABLE "public"."v_menu_list" TO "authenticated";
GRANT ALL ON TABLE "public"."v_menu_list" TO "service_role";



GRANT ALL ON TABLE "public"."v_menu_list_with_ratings" TO "anon";
GRANT ALL ON TABLE "public"."v_menu_list_with_ratings" TO "authenticated";
GRANT ALL ON TABLE "public"."v_menu_list_with_ratings" TO "service_role";



GRANT ALL ON TABLE "public"."v_metadata_briefs" TO "anon";
GRANT ALL ON TABLE "public"."v_metadata_briefs" TO "authenticated";
GRANT ALL ON TABLE "public"."v_metadata_briefs" TO "service_role";



GRANT ALL ON TABLE "public"."v_minute_book_all_documents" TO "anon";
GRANT ALL ON TABLE "public"."v_minute_book_all_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."v_minute_book_all_documents" TO "service_role";



GRANT ALL ON TABLE "public"."v_minute_book_documents" TO "anon";
GRANT ALL ON TABLE "public"."v_minute_book_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."v_minute_book_documents" TO "service_role";



GRANT ALL ON TABLE "public"."v_minute_book_entries_with_docs" TO "anon";
GRANT ALL ON TABLE "public"."v_minute_book_entries_with_docs" TO "authenticated";
GRANT ALL ON TABLE "public"."v_minute_book_entries_with_docs" TO "service_role";



GRANT ALL ON TABLE "public"."v_minute_book_misplaced" TO "anon";
GRANT ALL ON TABLE "public"."v_minute_book_misplaced" TO "authenticated";
GRANT ALL ON TABLE "public"."v_minute_book_misplaced" TO "service_role";



GRANT ALL ON TABLE "public"."v_minute_book_ordered" TO "anon";
GRANT ALL ON TABLE "public"."v_minute_book_ordered" TO "authenticated";
GRANT ALL ON TABLE "public"."v_minute_book_ordered" TO "service_role";



GRANT ALL ON TABLE "public"."v_minute_book_section_health" TO "anon";
GRANT ALL ON TABLE "public"."v_minute_book_section_health" TO "authenticated";
GRANT ALL ON TABLE "public"."v_minute_book_section_health" TO "service_role";



GRANT ALL ON TABLE "public"."v_minute_book_status" TO "anon";
GRANT ALL ON TABLE "public"."v_minute_book_status" TO "authenticated";
GRANT ALL ON TABLE "public"."v_minute_book_status" TO "service_role";



GRANT ALL ON TABLE "public"."v_minute_book_with_documents" TO "anon";
GRANT ALL ON TABLE "public"."v_minute_book_with_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."v_minute_book_with_documents" TO "service_role";



GRANT ALL ON TABLE "public"."v_oasis_all_documents" TO "anon";
GRANT ALL ON TABLE "public"."v_oasis_all_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."v_oasis_all_documents" TO "service_role";



GRANT ALL ON TABLE "public"."v_orb_state" TO "anon";
GRANT ALL ON TABLE "public"."v_orb_state" TO "authenticated";
GRANT ALL ON TABLE "public"."v_orb_state" TO "service_role";



GRANT ALL ON TABLE "public"."v_orb_state_global" TO "anon";
GRANT ALL ON TABLE "public"."v_orb_state_global" TO "authenticated";
GRANT ALL ON TABLE "public"."v_orb_state_global" TO "service_role";



GRANT ALL ON TABLE "public"."v_record_documents" TO "anon";
GRANT ALL ON TABLE "public"."v_record_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."v_record_documents" TO "service_role";



GRANT ALL ON TABLE "public"."v_registry_ledger_entries" TO "anon";
GRANT ALL ON TABLE "public"."v_registry_ledger_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."v_registry_ledger_entries" TO "service_role";



GRANT ALL ON TABLE "public"."v_registry_minute_book_entries" TO "anon";
GRANT ALL ON TABLE "public"."v_registry_minute_book_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."v_registry_minute_book_entries" TO "service_role";



GRANT ALL ON TABLE "public"."v_registry_all_entries" TO "anon";
GRANT ALL ON TABLE "public"."v_registry_all_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."v_registry_all_entries" TO "service_role";



GRANT ALL ON TABLE "public"."v_resolution_compliance_ai" TO "anon";
GRANT ALL ON TABLE "public"."v_resolution_compliance_ai" TO "authenticated";
GRANT ALL ON TABLE "public"."v_resolution_compliance_ai" TO "service_role";



GRANT ALL ON TABLE "public"."v_resolution_status_timeline" TO "anon";
GRANT ALL ON TABLE "public"."v_resolution_status_timeline" TO "authenticated";
GRANT ALL ON TABLE "public"."v_resolution_status_timeline" TO "service_role";



GRANT ALL ON TABLE "public"."v_resolutions_picklist" TO "anon";
GRANT ALL ON TABLE "public"."v_resolutions_picklist" TO "authenticated";
GRANT ALL ON TABLE "public"."v_resolutions_picklist" TO "service_role";



GRANT ALL ON TABLE "public"."v_resolutions_with_documents" TO "anon";
GRANT ALL ON TABLE "public"."v_resolutions_with_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."v_resolutions_with_documents" TO "service_role";



GRANT ALL ON TABLE "public"."v_schema_amendments_with_approvals" TO "anon";
GRANT ALL ON TABLE "public"."v_schema_amendments_with_approvals" TO "authenticated";
GRANT ALL ON TABLE "public"."v_schema_amendments_with_approvals" TO "service_role";



GRANT ALL ON TABLE "public"."v_signature_email_jobs" TO "anon";
GRANT ALL ON TABLE "public"."v_signature_email_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."v_signature_email_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."v_signature_envelope_status_timeline" TO "anon";
GRANT ALL ON TABLE "public"."v_signature_envelope_status_timeline" TO "authenticated";
GRANT ALL ON TABLE "public"."v_signature_envelope_status_timeline" TO "service_role";



GRANT ALL ON TABLE "public"."v_signed_documents" TO "anon";
GRANT ALL ON TABLE "public"."v_signed_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."v_signed_documents" TO "service_role";



GRANT ALL ON TABLE "public"."v_standard_requirements" TO "anon";
GRANT ALL ON TABLE "public"."v_standard_requirements" TO "authenticated";
GRANT ALL ON TABLE "public"."v_standard_requirements" TO "service_role";



GRANT ALL ON TABLE "public"."verified_documents" TO "anon";
GRANT ALL ON TABLE "public"."verified_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."verified_documents" TO "service_role";



GRANT ALL ON TABLE "public"."v_verified_documents" TO "anon";
GRANT ALL ON TABLE "public"."v_verified_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."v_verified_documents" TO "service_role";



GRANT ALL ON TABLE "public"."v_verified_resolutions" TO "anon";
GRANT ALL ON TABLE "public"."v_verified_resolutions" TO "authenticated";
GRANT ALL ON TABLE "public"."v_verified_resolutions" TO "service_role";



GRANT ALL ON TABLE "public"."vb_minutebook_index" TO "anon";
GRANT ALL ON TABLE "public"."vb_minutebook_index" TO "authenticated";
GRANT ALL ON TABLE "public"."vb_minutebook_index" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































