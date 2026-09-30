-- A free-text address for walk-in patients.
--
-- One field, not structured parts: reception types "Near Hanuman temple,
-- Wadgaon" faster than it fills five boxes, and the reason this exists — finding
-- a family in an emergency — is served by the words, not by a postcode column.
--
-- It lives on the patient, not the visit. The historical copy that matters
-- legally is the one printed on a bill, and bills snapshot it.
ALTER TABLE patients ADD COLUMN address TEXT;
--> statement-breakpoint

ALTER TABLE patients
  ADD CONSTRAINT patients_address_length CHECK (address IS NULL OR char_length(address) <= 500);
