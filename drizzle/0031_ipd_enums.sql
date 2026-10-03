-- New enum values for IPD, in a file of their own.
--
-- Postgres cannot use an enum value in the same transaction that added it, and
-- each migration file runs in one transaction. 0032 creates tables and CHECKs
-- that name these values, so they must be committed first.
--
--   nurse        The bedside role (IPD plan §4). Records care entries; never
--                moves the OPD queue, takes money or sees prices.
--   consumable,  The new sources of an IPD bill line. Each is a charge item
--   procedure,   kind in 0032; `room` is the nightly bed-day charge.
--   service,
--   room

ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'nurse';
--> statement-breakpoint
ALTER TYPE bill_item_type ADD VALUE IF NOT EXISTS 'consumable';
--> statement-breakpoint
ALTER TYPE bill_item_type ADD VALUE IF NOT EXISTS 'procedure';
--> statement-breakpoint
ALTER TYPE bill_item_type ADD VALUE IF NOT EXISTS 'service';
--> statement-breakpoint
ALTER TYPE bill_item_type ADD VALUE IF NOT EXISTS 'room';
