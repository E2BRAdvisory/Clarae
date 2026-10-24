-- +goose Up
-- Global defaults editable by administrators (§2.6.3, §2.6.2, §3.4.2).
INSERT INTO settings (key, value) VALUES
  ('storage.default_quota_bytes', '5368709120'::jsonb),      -- 5 GiB
  ('storage.warn_percent',        '80'::jsonb),
  ('storage.critical_percent',    '95'::jsonb),
  ('files.max_size_bytes',        '104857600'::jsonb),       -- 100 MB
  ('history.retention_days',      '30'::jsonb),
  ('history.daily_retention_days','90'::jsonb),
  ('vaults.deleted_retention_days','30'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- +goose Down
DELETE FROM settings WHERE key IN (
  'storage.default_quota_bytes', 'storage.warn_percent', 'storage.critical_percent',
  'files.max_size_bytes', 'history.retention_days', 'history.daily_retention_days',
  'vaults.deleted_retention_days'
);
