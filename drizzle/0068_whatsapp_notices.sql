-- 0068_whatsapp_notices.sql — Hospital WhatsApp Notices, priority-based recipient selection, capacity reservations, opt-out suppression, and webhook deduplication.

CREATE TABLE IF NOT EXISTS notice_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  notice_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  title TEXT NOT NULL,
  closure_date DATE,
  closure_duration TEXT,
  reason TEXT,
  reschedule_instructions TEXT,
  contact_phone TEXT,
  template_code TEXT NOT NULL,
  template_variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_target_recipients INTEGER NOT NULL DEFAULT 0,
  mandatory_recipients_count INTEGER NOT NULL DEFAULT 0,
  recent_recipients_count INTEGER NOT NULL DEFAULT 0,
  displaced_recipients_count INTEGER NOT NULL DEFAULT 0,
  ineligible_recipients_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  read_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  suppressed_count INTEGER NOT NULL DEFAULT 0,
  pending_capacity_count INTEGER NOT NULL DEFAULT 0,
  confirmed_at TIMESTAMPTZ,
  confirmed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE notice_campaigns DROP CONSTRAINT IF EXISTS notice_campaigns_notice_type_check;
--> statement-breakpoint

ALTER TABLE notice_campaigns ADD CONSTRAINT notice_campaigns_notice_type_check CHECK (
  notice_type IN ('hospital_closure', 'doctor_schedule_change', 'appointment_change')
);
--> statement-breakpoint

ALTER TABLE notice_campaigns DROP CONSTRAINT IF EXISTS notice_campaigns_status_check;
--> statement-breakpoint

ALTER TABLE notice_campaigns ADD CONSTRAINT notice_campaigns_status_check CHECK (
  status IN ('draft', 'scheduled', 'processing', 'completed', 'partially_completed', 'failed', 'cancelled')
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS notice_campaigns_hospital_idx ON notice_campaigns(hospital_id, created_at);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS notice_campaigns_status_idx ON notice_campaigns(hospital_id, status);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS notice_campaign_mandatory_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES notice_campaigns(id) ON DELETE CASCADE,
  patient_id UUID REFERENCES patients(id) ON DELETE SET NULL,
  phone_e164 TEXT NOT NULL,
  patient_name TEXT,
  is_eligible BOOLEAN NOT NULL DEFAULT true,
  ineligible_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS notice_campaign_mandatory_recipients_key ON notice_campaign_mandatory_recipients(campaign_id, phone_e164);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS notice_campaign_mandatory_recipients_campaign_idx ON notice_campaign_mandatory_recipients(campaign_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS notice_campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES notice_campaigns(id) ON DELETE CASCADE,
  patient_id UUID REFERENCES patients(id) ON DELETE SET NULL,
  phone_e164 TEXT NOT NULL,
  patient_name TEXT,
  priority SMALLINT NOT NULL DEFAULT 0,
  selection_reason TEXT NOT NULL,
  last_activity_at TIMESTAMPTZ,
  activity_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts SMALLINT NOT NULL DEFAULT 0,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  provider_message_id TEXT,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  failed_reason TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE notice_campaign_recipients DROP CONSTRAINT IF EXISTS notice_campaign_recipients_status_check;
--> statement-breakpoint

ALTER TABLE notice_campaign_recipients ADD CONSTRAINT notice_campaign_recipients_status_check CHECK (
  status IN ('pending', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'suppressed', 'pending_capacity', 'cancelled')
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS notice_campaign_recipients_campaign_phone_key ON notice_campaign_recipients(campaign_id, phone_e164);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS notice_campaign_recipients_drain_idx ON notice_campaign_recipients(status, scheduled_for, priority);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS notice_campaign_recipients_campaign_status_idx ON notice_campaign_recipients(campaign_id, status);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS notice_campaign_recipients_provider_msg_idx ON notice_campaign_recipients(provider_message_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS whatsapp_capacity_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  phone_number_id TEXT NOT NULL,
  campaign_id UUID NOT NULL REFERENCES notice_campaigns(id) ON DELETE CASCADE,
  reserved_slots INTEGER NOT NULL,
  consumed_slots INTEGER NOT NULL DEFAULT 0,
  released_slots INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE whatsapp_capacity_reservations DROP CONSTRAINT IF EXISTS whatsapp_capacity_reservations_status_check;
--> statement-breakpoint

ALTER TABLE whatsapp_capacity_reservations ADD CONSTRAINT whatsapp_capacity_reservations_status_check CHECK (
  status IN ('active', 'committed', 'released', 'expired')
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS whatsapp_capacity_reservations_phone_active_idx ON whatsapp_capacity_reservations(phone_number_id, status, expires_at);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS whatsapp_capacity_reservations_campaign_idx ON whatsapp_capacity_reservations(campaign_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS whatsapp_opt_outs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  phone_e164 TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'patient_opt_out',
  opted_out_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_opt_outs_hospital_phone_key ON whatsapp_opt_outs(hospital_id, phone_e164);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS whatsapp_opt_outs_hospital_idx ON whatsapp_opt_outs(hospital_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS webhook_event_dedup (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS webhook_event_dedup_event_id_key ON webhook_event_dedup(event_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS webhook_event_dedup_processed_at_idx ON webhook_event_dedup(processed_at);
--> statement-breakpoint

ALTER TABLE notice_campaigns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS notice_campaigns_tenant_isolation ON notice_campaigns;
--> statement-breakpoint

CREATE POLICY notice_campaigns_tenant_isolation ON notice_campaigns
  USING (hospital_id = current_setting('app.current_hospital_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE notice_campaign_mandatory_recipients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS notice_campaign_mandatory_recipients_tenant_isolation ON notice_campaign_mandatory_recipients;
--> statement-breakpoint

CREATE POLICY notice_campaign_mandatory_recipients_tenant_isolation ON notice_campaign_mandatory_recipients
  USING (campaign_id IN (SELECT id FROM notice_campaigns WHERE hospital_id = current_setting('app.current_hospital_id', true)::uuid));
--> statement-breakpoint

ALTER TABLE notice_campaign_recipients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS notice_campaign_recipients_tenant_isolation ON notice_campaign_recipients;
--> statement-breakpoint

CREATE POLICY notice_campaign_recipients_tenant_isolation ON notice_campaign_recipients
  USING (campaign_id IN (SELECT id FROM notice_campaigns WHERE hospital_id = current_setting('app.current_hospital_id', true)::uuid));
--> statement-breakpoint

ALTER TABLE whatsapp_capacity_reservations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS whatsapp_capacity_reservations_tenant_isolation ON whatsapp_capacity_reservations;
--> statement-breakpoint

CREATE POLICY whatsapp_capacity_reservations_tenant_isolation ON whatsapp_capacity_reservations
  USING (hospital_id = current_setting('app.current_hospital_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE whatsapp_opt_outs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS whatsapp_opt_outs_tenant_isolation ON whatsapp_opt_outs;
--> statement-breakpoint

CREATE POLICY whatsapp_opt_outs_tenant_isolation ON whatsapp_opt_outs
  USING (hospital_id = current_setting('app.current_hospital_id', true)::uuid);
