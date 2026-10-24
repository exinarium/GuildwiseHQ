-- Security review (findings 1, 2, 8): an organization key now has a generation, the number of times it was set (replaced) for the
-- provider. It is bound into every sealed copy (AES-GCM associated data) and carried in the share, clear and reshare commands, so a
-- copy of a replaced or revoked key replayed later is refused by the runner and a late reshare answer for an old key is dropped.
-- The projection counts `OrgProviderKeySet` events, so a rebuild reproduces it; this backfill does the same for what exists.
ALTER TABLE org_providers ADD COLUMN IF NOT EXISTS key_generation bigint NOT NULL DEFAULT 0;
UPDATE org_providers p
   SET key_generation = (
     SELECT count(*) FROM events e
      WHERE e.type = 'OrgProviderKeySet' AND e.payload->>'orgId' = p.org_id::text AND e.payload->>'provider' = p.provider
   );

-- Copies sealed before keys were bound to their purpose cannot be opened by an updated runner: show them as failed, so the page
-- offers to set the key again (a new generation).
UPDATE org_provider_key_shares
   SET status = 'failed', ciphertext = NULL,
       error = 'sealed in the older form: set the key again so it is bound to this organization and endpoint'
 WHERE status IN ('stored', 'queued');
