-- Discovery Studio (phase B): the structured side of a facilitated session. Projection tables rebuilt from the
-- `Discovery*` events (no foreign keys into other projection tables: a rebuild TRUNCATEs them).

-- One card per question the facilitator asked; at most one is `open` per session (the next question withdraws it).
-- `proposed`: the CEO answered in `ceo_prep` and the owner has not reviewed the answer yet.
CREATE TABLE IF NOT EXISTS discovery_questions (
  id               uuid PRIMARY KEY,
  thread_id        uuid NOT NULL,
  org_id           uuid NOT NULL,
  seq              bigint NOT NULL,                 -- event seq: the order of the timeline
  turn_id          uuid,
  asked_by_name    text NOT NULL,
  question         text NOT NULL,
  why              text,
  options          jsonb NOT NULL DEFAULT '[]',
  allow_free_text  boolean NOT NULL DEFAULT true,
  phase            text NOT NULL,
  status           text NOT NULL CHECK (status IN ('open','proposed','answered','skipped','parked','withdrawn')),
  answer           jsonb,                           -- {kind, optionId, text, source}
  proposed         jsonb,                           -- {text, optionId, rationale, byName, mode, at}
  asked_at         timestamptz NOT NULL,
  answered_at      timestamptz
);
CREATE INDEX IF NOT EXISTS discovery_questions_thread ON discovery_questions (thread_id, seq);
CREATE INDEX IF NOT EXISTS discovery_questions_open ON discovery_questions (thread_id) WHERE status IN ('open','proposed');

-- The side panel: ideas, assumptions, open questions, decisions, parked items.
CREATE TABLE IF NOT EXISTS discovery_notes (
  id          uuid PRIMARY KEY,
  thread_id   uuid NOT NULL,
  org_id      uuid NOT NULL,
  seq         bigint NOT NULL,
  section     text NOT NULL CHECK (section IN ('ideas','assumptions','open_questions','decisions','parked')),
  text        text NOT NULL,
  by_kind     text NOT NULL,
  by_name     text NOT NULL,
  by_id       text,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  removed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS discovery_notes_thread ON discovery_notes (thread_id, seq);

-- Apply / Reject / Redirect gate: nothing changes until the owner resolves a proposal.
CREATE TABLE IF NOT EXISTS discovery_proposals (
  id               uuid PRIMARY KEY,
  thread_id        uuid NOT NULL,
  org_id           uuid NOT NULL,
  seq              bigint NOT NULL,
  turn_id          uuid,
  title            text NOT NULL,
  change           text NOT NULL,
  rationale        text NOT NULL,
  doc_id           uuid,
  section          text,
  status           text NOT NULL CHECK (status IN ('open','applied','rejected','redirected')),
  resolution_text  text,
  asked_by_name    text NOT NULL,
  created_at       timestamptz NOT NULL,
  resolved_at      timestamptz
);
CREATE INDEX IF NOT EXISTS discovery_proposals_thread ON discovery_proposals (thread_id, seq);

-- What a session turn is for (facilitator, ceo_answer, ...), set by the orchestrator.
ALTER TABLE session_turns ADD COLUMN IF NOT EXISTS meta jsonb;

-- Documents (a PRD) handed to the BA with an intake: the cards the BA drafts link to them.
ALTER TABLE intakes ADD COLUMN IF NOT EXISTS linked_doc_ids jsonb NOT NULL DEFAULT '[]';
