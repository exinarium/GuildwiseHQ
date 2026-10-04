-- Credentials embedded in git remote URLs (https://user:token@host/...) were accepted before the API refused them.
-- Strip the password (and an http(s) user name, which is usually a token) from every stored copy: the projections and
-- the event payloads they were built from. The events table is append-only by trigger; this one redaction is the only
-- sanctioned exception, so the trigger is switched off for the statement and back on right after (same transaction).

CREATE FUNCTION aom_scrub_url(u text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(
           regexp_replace(u, '^(https?://)[^/@[:space:]]*@', '\1', 'i'),
           '^([a-zA-Z][a-zA-Z0-9+.-]*://[^/@:[:space:]]*):[^/@[:space:]]*@', '\1@')
$$;

UPDATE project_repos SET remote_url = aom_scrub_url(remote_url) WHERE remote_url <> aom_scrub_url(remote_url);
UPDATE vaults SET remote_url = aom_scrub_url(remote_url) WHERE remote_url <> aom_scrub_url(remote_url);

ALTER TABLE events DISABLE TRIGGER events_append_only;
UPDATE events SET payload = jsonb_set(payload, '{remoteUrl}', to_jsonb(aom_scrub_url(payload->>'remoteUrl')))
 WHERE type IN ('ProjectRepoAdded', 'VaultRegistered', 'VaultUpdated')
   AND payload ? 'remoteUrl' AND payload->>'remoteUrl' <> aom_scrub_url(payload->>'remoteUrl');
ALTER TABLE events ENABLE TRIGGER events_append_only;

DROP FUNCTION aom_scrub_url(text);
