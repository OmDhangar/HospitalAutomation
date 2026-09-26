-- Add BOOKED status to the appointment_status enum.
--
-- Slot bookings (WhatsApp / web) now start as BOOKED instead of WAITING.
-- BOOKED means "patient reserved a slot remotely but has not arrived".
-- Reception checks them in (BOOKED → ARRIVED → WAITING) when they show up.
--
-- This fixes the emergency cancellation logic: BOOKED patients are correctly
-- sent a WhatsApp message to rebook, instead of being treated as if they are
-- physically present at the hospital (which is what happened when they were
-- in WAITING status).

ALTER TYPE appointment_status ADD VALUE IF NOT EXISTS 'BOOKED' AFTER 'CREATED';
ALTER TYPE queue_action ADD VALUE IF NOT EXISTS 'book' BEFORE 'confirm';
