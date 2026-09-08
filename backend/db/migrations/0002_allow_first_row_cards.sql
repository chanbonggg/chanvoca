-- Headerless files contain vocabulary on worksheet row 1.
-- Keep the original row number for validation and troubleshooting.
ALTER TABLE cards
  DROP CONSTRAINT cards_source_row_check,
  ADD CONSTRAINT cards_source_row_check CHECK (source_row >= 1);
