-- 0066_claims_tracker_and_tpa_desk.sql — Platform payer master, tenant payer configs, claim cases, append-only events, document custody, queries and rejections.

CREATE TABLE IF NOT EXISTS payer_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('tpa', 'private_insurer', 'public_insurer', 'govt_scheme', 'corporate')),
  portal_url TEXT,
  support_email TEXT,
  support_phone TEXT,
  toll_free_number TEXT,
  default_preauth_sla_minutes INTEGER NOT NULL DEFAULT 360 CHECK (default_preauth_sla_minutes > 0),
  default_query_sla_minutes INTEGER NOT NULL DEFAULT 120 CHECK (default_query_sla_minutes > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS hospital_payer_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  payer_profile_id UUID NOT NULL REFERENCES payer_profiles(id) ON DELETE RESTRICT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  preauth_sla_minutes INTEGER CHECK (preauth_sla_minutes IS NULL OR preauth_sla_minutes > 0),
  query_sla_minutes INTEGER CHECK (query_sla_minutes IS NULL OR query_sla_minutes > 0),
  final_packet_sla_minutes INTEGER DEFAULT 240 CHECK (final_packet_sla_minutes > 0),
  settlement_sla_minutes INTEGER DEFAULT 43200 CHECK (settlement_sla_minutes > 0),
  local_tpa_desk_contact TEXT,
  portal_login_identifier TEXT,
  required_documents JSONB NOT NULL DEFAULT '["insurance_card", "aadhaar_id", "admission_advice", "first_consultation_sheet"]'::jsonb,
  custom_checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hospital_payer_configs_tenant_payer_key UNIQUE (hospital_id, payer_profile_id)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS claim_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  admission_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  encounter_payer_id UUID NOT NULL,
  payer_profile_id UUID NOT NULL REFERENCES payer_profiles(id) ON DELETE RESTRICT,
  claim_type TEXT NOT NULL DEFAULT 'cashless' CHECK (claim_type IN ('cashless', 'reimbursement')),
  priority TEXT NOT NULL DEFAULT 'standard' CHECK (priority IN ('standard', 'urgent', 'emergency')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  client_id UUID NOT NULL,
  policy_number_ciphertext TEXT,
  policy_number_iv TEXT,
  policy_number_tag TEXT,
  policy_number_key_version SMALLINT,
  policy_number_masked TEXT,
  policy_number_bidx TEXT,
  member_id_ciphertext TEXT,
  member_id_iv TEXT,
  member_id_tag TEXT,
  member_id_key_version SMALLINT,
  member_id_masked TEXT,
  member_id_bidx TEXT,
  tpa_claim_number TEXT,
  corporate_emp_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'preauth_submitted', 'query_raised', 'preauth_approved', 'preauth_rejected',
    'enhancement_requested', 'claim_ready', 'final_submitted', 'settled', 'partially_settled',
    'claim_rejected', 'appeal_in_progress', 'appeal_submitted', 'appeal_won', 'appeal_lost',
    'reimbursement_draft', 'reimbursement_docs_gathering', 'reimbursement_dossier_ready',
    'dossier_handed_to_patient', 'closed_cancelled'
  )),
  estimated_cost_paise BIGINT CHECK (estimated_cost_paise IS NULL OR estimated_cost_paise >= 0),
  preauth_amount_paise BIGINT CHECK (preauth_amount_paise IS NULL OR preauth_amount_paise >= 0),
  approved_amount_paise BIGINT CHECK (approved_amount_paise IS NULL OR approved_amount_paise >= 0),
  enhancement_amount_paise BIGINT CHECK (enhancement_amount_paise IS NULL OR enhancement_amount_paise >= 0),
  claimed_amount_paise BIGINT CHECK (claimed_amount_paise IS NULL OR claimed_amount_paise >= 0),
  settled_amount_paise BIGINT CHECK (settled_amount_paise IS NULL OR settled_amount_paise >= 0),
  deduction_amount_paise BIGINT CHECK (deduction_amount_paise IS NULL OR deduction_amount_paise >= 0),
  co_pay_amount_paise BIGINT CHECK (co_pay_amount_paise IS NULL OR co_pay_amount_paise >= 0),
  discharge_bill_id UUID,
  preauth_submitted_at TIMESTAMPTZ,
  preauth_approved_at TIMESTAMPTZ,
  preauth_sla_deadline TIMESTAMPTZ,
  final_packet_ready_at TIMESTAMPTZ,
  final_submitted_at TIMESTAMPTZ,
  final_submitted_channel TEXT CHECK (final_submitted_channel IS NULL OR final_submitted_channel IN ('portal', 'email', 'physical_courier', 'in_person')),
  final_submission_reference TEXT,
  settled_at TIMESTAMPTZ,
  assigned_staff_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  CONSTRAINT claim_cases_client_key UNIQUE (hospital_id, client_id),
  CONSTRAINT claim_cases_admission_fk FOREIGN KEY (hospital_id, admission_id) REFERENCES admissions(hospital_id, id) ON DELETE CASCADE,
  CONSTRAINT claim_cases_encounter_payer_fk FOREIGN KEY (hospital_id, encounter_payer_id) REFERENCES encounter_payers(hospital_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS claim_cases_hospital_status_idx ON claim_cases(hospital_id, status) WHERE voided_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS claim_cases_admission_idx ON claim_cases(hospital_id, admission_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS claim_cases_policy_bidx ON claim_cases(hospital_id, policy_number_bidx) WHERE voided_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS claim_cases_member_bidx ON claim_cases(hospital_id, member_id_bidx) WHERE voided_at IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS claim_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  claim_case_id UUID NOT NULL REFERENCES claim_cases(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'preauth_sent', 'preauth_approved', 'preauth_rejected', 'query_received',
    'query_replied', 'enhancement_sent', 'enhancement_approved', 'claim_marked_ready',
    'final_packet_sent', 'settled', 'partially_settled', 'rejected', 'appeal_initiated',
    'appeal_submitted', 'appeal_won', 'appeal_lost', 'reimbursement_dossier_handed', 'voided'
  )),
  previous_status TEXT,
  new_status TEXT NOT NULL,
  amount_paise BIGINT CHECK (amount_paise IS NULL OR amount_paise >= 0),
  submission_channel TEXT CHECK (submission_channel IS NULL OR submission_channel IN ('portal', 'email', 'physical_courier', 'in_person')),
  external_reference TEXT,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT claim_events_client_key UNIQUE (hospital_id, client_id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS claim_events_case_created_idx ON claim_events(hospital_id, claim_case_id, created_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS claim_document_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  claim_case_id UUID NOT NULL REFERENCES claim_cases(id) ON DELETE CASCADE,
  doc_category TEXT NOT NULL CHECK (doc_category IN (
    'patient_id_proof', 'insurance_card', 'signed_preauth_form', 'admission_advice_sheet',
    'discharge_summary', 'final_itemized_bill', 'lab_radiology_reports', 'indoor_case_sheet',
    'tpa_approval_letter', 'query_reply_packet', 'settlement_voucher', 'other'
  )),
  linked_discharge_summary_id UUID REFERENCES discharge_summaries(id) ON DELETE SET NULL,
  linked_test_order_id UUID,
  is_paper_filed BOOLEAN NOT NULL DEFAULT FALSE,
  paper_filed_at TIMESTAMPTZ,
  paper_filed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  physical_box_or_file_no TEXT,
  notes TEXT,
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  CONSTRAINT claim_doc_records_client_key UNIQUE (hospital_id, client_id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS claim_doc_records_case_idx ON claim_document_records(hospital_id, claim_case_id) WHERE voided_at IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS claim_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  claim_case_id UUID NOT NULL REFERENCES claim_cases(id) ON DELETE CASCADE,
  query_category TEXT NOT NULL CHECK (query_category IN (
    'medical_necessity', 'line_item_breakup', 'past_medical_history_and_ped',
    'pharmacy_investigation_proofs', 'identity_mismatch', 'tariff_discrepancy', 'other'
  )),
  query_description TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sla_deadline_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_hospital' CHECK (status IN (
    'pending_hospital', 'replied', 'accepted_by_tpa', 'escalated_to_doctor', 'disputed'
  )),
  reply_notes TEXT,
  replied_at TIMESTAMPTZ,
  replied_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reply_channel TEXT CHECK (reply_channel IS NULL OR reply_channel IN ('portal', 'email', 'physical_courier')),
  reply_reference TEXT,
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  CONSTRAINT claim_queries_client_key UNIQUE (hospital_id, client_id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS claim_queries_pending_deadline_idx ON claim_queries(hospital_id, sla_deadline_at) WHERE status = 'pending_hospital' AND voided_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS claim_queries_case_idx ON claim_queries(hospital_id, claim_case_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS claim_rejections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  claim_case_id UUID NOT NULL REFERENCES claim_cases(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('preauth', 'enhancement', 'final_claim')),
  rejection_reason_category TEXT NOT NULL CHECK (rejection_reason_category IN (
    'ped_exclusion_clause', 'specific_exclusion_clause', 'late_intimation_beyond_limit',
    'not_medically_necessary_active_care', 'investigation_only_no_treatment',
    'hospital_tariff_non_compliance', 'administrative_deficiency_documents',
    'policy_exhausted_or_lapsed', 'other'
  )),
  rejection_remarks TEXT NOT NULL,
  rejected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  appeal_status TEXT NOT NULL DEFAULT 'not_appealed' CHECK (appeal_status IN (
    'not_appealed', 'appeal_in_progress', 'appeal_submitted', 'appeal_won', 'appeal_lost', 'converted_to_self_pay'
  )),
  appeal_deadline_at TIMESTAMPTZ,
  appeal_submitted_at TIMESTAMPTZ,
  appeal_reference TEXT,
  appeal_notes TEXT,
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT claim_rejections_client_key UNIQUE (hospital_id, client_id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS claim_rejections_case_idx ON claim_rejections(hospital_id, claim_case_id);
--> statement-breakpoint

DO $outer$
DECLARE
  app text := coalesce(nullif(current_setting('qurio.app_role', true), ''), 'opd_app');
  t text;
BEGIN
  -- Enable and enforce RLS on tenant tables
  FOREACH t IN ARRAY ARRAY['hospital_payer_configs', 'claim_cases', 'claim_events', 'claim_document_records', 'claim_queries', 'claim_rejections'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (hospital_id = nullif(current_setting(''app.hospital_id'', true), '''')::uuid)
         WITH CHECK (hospital_id = nullif(current_setting(''app.hospital_id'', true), '''')::uuid)',
      t
    );
    EXECUTE format('DROP POLICY IF EXISTS read_only_write ON %I', t);
    EXECUTE format('CREATE POLICY read_only_write ON %I AS RESTRICTIVE FOR ALL USING (true) WITH CHECK (NOT public.app_read_only())', t);
    EXECUTE format('DROP POLICY IF EXISTS read_only_delete ON %I', t);
    EXECUTE format('CREATE POLICY read_only_delete ON %I AS RESTRICTIVE FOR DELETE USING (NOT public.app_read_only())', t);
  END LOOP;

  -- Grant app permissions
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON payer_profiles TO %I', app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON hospital_payer_configs TO %I', app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON claim_cases TO %I', app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON claim_events TO %I', app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON claim_document_records TO %I', app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON claim_queries TO %I', app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON claim_rejections TO %I', app);
  END IF;
END
$outer$;
