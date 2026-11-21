-- Release signing per deploy target (R30, W14): the runner artefact each target's release was packaged into. Projection
-- of `ReleaseArtefactPrepared` (the newest one per release and target wins). The manifest is public data: the server
-- verifies a minisign signature over its bytes and offers it for offline signing. The tgz stays on the workstation.
CREATE TABLE IF NOT EXISTS release_artefacts (
  release_id       uuid NOT NULL,
  target_id        uuid NOT NULL,
  artefact_sha256  text NOT NULL,
  version          text NOT NULL,
  manifest         text,
  workstation_id   uuid,
  prepared_at      timestamptz NOT NULL,
  PRIMARY KEY (release_id, target_id)
);
CREATE INDEX IF NOT EXISTS release_artefacts_target ON release_artefacts (target_id);
