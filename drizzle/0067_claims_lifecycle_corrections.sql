-- 0067_claims_lifecycle_corrections.sql — Separate operational workflow from financial settlement, multi-query stage recovery, authorization limits history, immutable submission manifests, and audited multi-receipt remittances.

ALTER TABLE claim_cases ADD COLUMN IF NOT EXISTS interrupted_stage TEXT;
--> statement-breakpoint

ALTER TABLE claim_cases ADD COLUMN IF NOT EXISTS settlement_status TEXT NOT NULL DEFAULT 'unsettled';
--> statement-breakpoint

ALTER TABLE claim_cases ADD COLUMN IF NOT EXISTS legacy_reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE;
--> statement-breakpoint

ALTER TABLE claim_cases DROP CONSTRAINT IF EXISTS claim_cases_settlement_status_check;
--> statement-breakpoint

ALTER TABLE claim_cases ADD CONSTRAINT claim_cases_settlement_status_check CHECK (settlement_status IN (
  'unsettled', 'partially_settled', 'settled', 'disputed', 'written_off', 'legacy_reconciliation_required'
));
--> statement-breakpoint

ALTER TABLE claim_cases DROP CONSTRAINT IF EXISTS claim_cases_status_check;
--> statement-breakpoint

ALTER TABLE claim_cases ADD CONSTRAINT claim_cases_status_check CHECK (status IN (
  'draft', 'preauth_submitted', 'query_raised', 'preauth_approved', 'preauth_rejected',
  'enhancement_requested', 'claim_ready', 'final_submitted', 'settled', 'partially_settled',
  'closed_settled', 'closed_cancelled',
  'claim_rejected', 'appeal_in_progress', 'appeal_submitted', 'appeal_won', 'appeal_lost',
  'reimbursement_draft', 'reimbursement_docs_gathering', 'reimbursement_dossier_ready',
  'dossier_handed_to_patient'
));
--> statement-breakpoint

ALTER TABLE claim_events DROP CONSTRAINT IF EXISTS claim_events_event_type_check;
--> statement-breakpoint

ALTER TABLE claim_events ADD CONSTRAINT claim_events_event_type_check CHECK (event_type IN (
  'created', 'preauth_sent', 'preauth_approved', 'preauth_rejected', 'query_received',
  'query_replied', 'enhancement_sent', 'enhancement_approved', 'claim_marked_ready',
  'final_packet_sent', 'settled', 'partially_settled', 'rejected', 'appeal_initiated',
  'appeal_submitted', 'appeal_won', 'appeal_lost', 'reimbursement_dossier_handed', 'voided',
  'closed_settled', 'closed_cancelled', 'reopened'
));
--> statement-breakpoint

ALTER TABLE claim_cases ADD COLUMN IF NOT EXISTS current_authorized_limit_paise BIGINT NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE claim_cases ADD COLUMN IF NOT EXISTS adjudicated_payable_paise BIGINT;
--> statement-breakpoint

ALTER TABLE claim_cases ADD COLUMN IF NOT EXISTS total_remitted_paise BIGINT NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE claim_cases ADD COLUMN IF NOT EXISTS total_tds_withheld_paise BIGINT NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE claim_cases ADD COLUMN IF NOT EXISTS total_deductions_paise BIGINT NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE claim_cases ADD COLUMN IF NOT EXISTS total_disputed_paise BIGINT NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE claim_cases ADD COLUMN IF NOT EXISTS hospital_internal_deadline TIMESTAMPTZ;
--> statement-breakpoint

ALTER TABLE claim_queries ADD COLUMN IF NOT EXISTS insurer_resolved_at TIMESTAMPTZ;
--> statement-breakpoint

ALTER TABLE claim_queries ADD COLUMN IF NOT EXISTS insurer_resolution_reference TEXT;
--> statement-breakpoint

ALTER TABLE claim_queries ADD COLUMN IF NOT EXISTS insurer_resolution_notes TEXT;
--> statement-breakpoint

ALTER TABLE claim_queries ADD COLUMN IF NOT EXISTS deadline_type TEXT NOT NULL DEFAULT 'hospital_response';
--> statement-breakpoint

ALTER TABLE claim_queries DROP CONSTRAINT IF EXISTS claim_queries_deadline_type_check;
--> statement-breakpoint

ALTER TABLE claim_queries ADD CONSTRAINT claim_queries_deadline_type_check CHECK (deadline_type IN ('hospital_response', 'insurer_sla'));
--> statement-breakpoint

ALTER TABLE claim_queries DROP CONSTRAINT IF EXISTS claim_queries_status_check;
--> statement-breakpoint

ALTER TABLE claim_queries ADD CONSTRAINT claim_queries_status_check CHECK (status IN (
  'pending_hospital', 'replied_by_hospital', 'replied', 'resolved_accepted', 're_queried', 'disputed', 'escalated_to_doctor'
));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS claim_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  claim_case_id UUID NOT NULL REFERENCES claim_cases(id) ON DELETE CASCADE,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('initial_preauth', 'enhancement')),
  sequence_number INTEGER NOT NULL DEFAULT 0 CHECK (sequence_number >= 0),
  requested_incremental_paise BIGINT CHECK (requested_incremental_paise IS NULL OR requested_incremental_paise >= 0),
  requested_cumulative_paise BIGINT NOT NULL CHECK (requested_cumulative_paise >= 0),
  approved_incremental_paise BIGINT CHECK (approved_incremental_paise IS NULL OR approved_incremental_paise >= 0),
  approved_cumulative_paise BIGINT CHECK (approved_cumulative_paise IS NULL OR approved_cumulative_paise >= 0),
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'partially_approved', 'rejected')),
  reference_number TEXT,
  decision_notes TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  decided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT claim_authorizations_client_key UNIQUE (hospital_id, client_id),
  CONSTRAINT claim_authorizations_seq_key UNIQUE (hospital_id, claim_case_id, auth_type, sequence_number)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS claim_authorizations_case_idx ON claim_authorizations(hospital_id, claim_case_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS claim_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  claim_case_id UUID NOT NULL REFERENCES claim_cases(id) ON DELETE CASCADE,
  submission_number INTEGER NOT NULL DEFAULT 1 CHECK (submission_number >= 1),
  submission_stage TEXT NOT NULL CHECK (submission_stage IN ('preauth', 'enhancement', 'final_claim', 'appeal')),
  is_resubmission BOOLEAN NOT NULL DEFAULT FALSE,
  channel TEXT NOT NULL CHECK (channel IN ('portal', 'email', 'physical_courier', 'in_person')),
  reference_number TEXT NOT NULL,
  claimed_amount_paise BIGINT CHECK (claimed_amount_paise IS NULL OR claimed_amount_paise >= 0),
  packet_hash TEXT NOT NULL,
  snapshot_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT claim_submissions_client_key UNIQUE (hospital_id, client_id),
  CONSTRAINT claim_submissions_seq_key UNIQUE (hospital_id, claim_case_id, submission_number)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS claim_submissions_case_idx ON claim_submissions(hospital_id, claim_case_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS claim_remittances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  claim_case_id UUID NOT NULL REFERENCES claim_cases(id) ON DELETE CASCADE,
  remittance_type TEXT NOT NULL CHECK (remittance_type IN ('payment', 'tds_withholding', 'deduction', 'disputed_deduction', 'correction_reversal', 'legacy_backfill')),
  payment_method TEXT CHECK (payment_method IS NULL OR payment_method IN ('neft', 'rtgs', 'cheque', 'portal_credit', 'other')),
  payer_reference TEXT,
  amount_paise BIGINT NOT NULL,
  tds_paise BIGINT NOT NULL DEFAULT 0,
  deduction_paise BIGINT NOT NULL DEFAULT 0,
  co_pay_paise BIGINT NOT NULL DEFAULT 0,
  disputed_deduction_paise BIGINT NOT NULL DEFAULT 0,
  reversal_of_remittance_id UUID REFERENCES claim_remittances(id) ON DELETE RESTRICT,
  reversal_reason TEXT,
  notes TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT claim_remittances_client_key UNIQUE (hospital_id, client_id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS claim_remittances_case_idx ON claim_remittances(hospital_id, claim_case_id);
--> statement-breakpoint

ALTER TABLE claim_document_records DROP CONSTRAINT IF EXISTS claim_document_records_linked_discharge_summary_id_fkey;
--> statement-breakpoint

ALTER TABLE claim_document_records DROP CONSTRAINT IF EXISTS claim_doc_records_discharge_summary_fk;
--> statement-breakpoint

-- Safe backfill for legacy settlement rows: preserve ambiguous values and flag for financial reconciliation
DO $backfill$
BEGIN
  -- 1. Flag legacy settlements as requiring reconciliation and do not invent historical remittances
  UPDATE claim_cases
  SET settlement_status = CASE
    WHEN settled_amount_paise IS NOT NULL AND settled_amount_paise > 0 THEN 'legacy_reconciliation_required'
    ELSE 'unsettled'
  END,
  legacy_reconciliation_required = CASE
    WHEN settled_amount_paise IS NOT NULL AND settled_amount_paise > 0 THEN TRUE
    ELSE FALSE
  END,
  total_remitted_paise = 0,
  total_tds_withheld_paise = 0,
  total_deductions_paise = 0,
  total_disputed_paise = 0,
  current_authorized_limit_paise = COALESCE(approved_amount_paise, 0)
  WHERE voided_at IS NULL;
END
$backfill$;
--> statement-breakpoint

DO $outer$
DECLARE
  app text := coalesce(nullif(current_setting('qurio.app_role', true), ''), 'opd_app');
  t text;
BEGIN
  -- Enable and enforce RLS on new tenant tables
  FOREACH t IN ARRAY ARRAY['claim_authorizations', 'claim_submissions', 'claim_remittances'] LOOP
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
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON claim_authorizations TO %I', app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON claim_submissions TO %I', app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON claim_remittances TO %I', app);
  END IF;
END
$outer$;
