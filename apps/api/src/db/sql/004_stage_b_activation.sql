-- Ultra Family OS — Stage B module activation on legacy Stage A databases.
-- Stage A seeded every module toggle, but marked future modules disabled.
-- Activate organizational modules only where the toggle still has the original
-- seed timestamp; a later owner change is never overwritten.

UPDATE module_toggles AS mt
SET enabled = TRUE,
    updated_at = CURRENT_TIMESTAMP
WHERE mt.module_id IN ('calendar', 'tasks', 'notifications', 'shopping')
  AND mt.enabled = FALSE
  AND mt.updated_at = (
    SELECT MIN(mt2.updated_at)
    FROM module_toggles AS mt2
    WHERE mt2.space_id = mt.space_id
  );
