-- +goose Up
-- A desktop device is identified by its host name (ADR-0057): logging out of the
-- app used to forget the device id, and the next login registered one more row.
-- From now on POST /me/devices for a windows, macos or linux device is an upsert on
-- (user_id, platform, hostname), so a re-login finds the same row again. `hostname`
-- is NULL for web devices and for rows that stopped being the identity of their host.
ALTER TABLE devices ADD COLUMN hostname TEXT;

UPDATE devices SET hostname = lower(btrim(name))
WHERE platform IN ('windows', 'macos', 'linux') AND btrim(name) <> '';

-- Existing duplicates: per (user, platform, hostname) one row keeps the host name,
-- the active one with the most recent activity first (an active row always ranks
-- above a revoked one; if every row is revoked, the most recent revoked one wins).
-- The others lose the host name and are revoked unless they already are. No row is
-- deleted: revisions reference devices(id).
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, platform, hostname
           ORDER BY (revoked_at IS NULL) DESC, last_seen_at DESC NULLS LAST, created_at DESC, id DESC
         ) AS rn
  FROM devices
  WHERE hostname IS NOT NULL
)
UPDATE devices d
SET hostname = NULL, revoked_at = COALESCE(d.revoked_at, now())
FROM ranked r
WHERE d.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX devices_hostname_uq ON devices (user_id, platform, hostname) WHERE hostname IS NOT NULL;

-- +goose Down
DROP INDEX devices_hostname_uq;
ALTER TABLE devices DROP COLUMN hostname;
