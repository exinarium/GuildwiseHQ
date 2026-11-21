-- Release signing (R30, W14): the release sheet polls the newest release.prepare / release.sign of a release and target.
CREATE INDEX IF NOT EXISTS runner_commands_release_signing
  ON runner_commands (type, (payload->>'releaseId'), (payload->>'targetId'), created_at DESC)
  WHERE type IN ('release.prepare','release.sign');
