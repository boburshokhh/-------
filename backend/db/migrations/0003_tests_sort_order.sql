-- 0003_tests_sort_order.sql
-- Add persistent manual order for tests in library.

ALTER TABLE tests
    ADD COLUMN IF NOT EXISTS sort_order INTEGER;

WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS pos
    FROM tests
)
UPDATE tests t
SET sort_order = ranked.pos
FROM ranked
WHERE t.id = ranked.id
  AND (t.sort_order IS NULL OR t.sort_order <= 0);

ALTER TABLE tests
    ALTER COLUMN sort_order SET DEFAULT 1;

ALTER TABLE tests
    ALTER COLUMN sort_order SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tests_sort_order ON tests (sort_order);
