-- Ultra Family OS — Stage B compatibility backfill.
-- Safe for fresh databases and for Stage A installations that already applied 002.
-- A deliberately disabled module toggle is never overwritten.

INSERT INTO module_toggles (space_id, module_id, enabled)
SELECT s.id, m.module_id, TRUE
FROM spaces s
CROSS JOIN (
  VALUES
    ('dashboard'), ('catalog'), ('profile'), ('spaces'),
    ('settings'), ('sessions'), ('admin'), ('public_site'),
    ('calendar'), ('tasks'), ('notifications'), ('shopping')
) AS m(module_id)
ON CONFLICT (space_id, module_id) DO NOTHING;

INSERT INTO calendars (id, space_id, name, kind, color, visibility, ctag)
SELECT 'legacy-cal-' || s.id, s.id, 'Семейный', 'family', '#5B7CFA', 'household', '1'
FROM spaces s
WHERE NOT EXISTS (SELECT 1 FROM calendars c WHERE c.space_id = s.id)
ON CONFLICT (id) DO NOTHING;

INSERT INTO task_lists (id, space_id, name, kind, color)
SELECT 'legacy-lst-' || s.id, s.id, 'Общее', 'list', '#14B8A6'
FROM spaces s
WHERE NOT EXISTS (SELECT 1 FROM task_lists l WHERE l.space_id = s.id)
ON CONFLICT (id) DO NOTHING;

INSERT INTO shopping_lists (id, space_id, name, kind, status, version)
SELECT 'legacy-shp-' || s.id, s.id, 'Покупки', 'grocery', 'active', 1
FROM spaces s
WHERE NOT EXISTS (
  SELECT 1 FROM shopping_lists l WHERE l.space_id = s.id AND l.status = 'active'
)
ON CONFLICT (id) DO NOTHING;
