-- Revision R3a (docs/ARCHITECTURE.md section 38.8): custom and private capabilities, private git packs, member opt-in,
-- hire-from-pack and persona chat. Projection state, rebuilt from the Pack* events; additive (an older row keeps its defaults).

-- A pack is a git import (as before) or authored in the capability editor; an authored or org pack may be private to its owner.
ALTER TABLE packs ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'git' CHECK (source IN ('git','authored'));
ALTER TABLE packs ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'org' CHECK (visibility IN ('org','private'));
ALTER TABLE packs ADD COLUMN IF NOT EXISTS owner_user_id uuid;
ALTER TABLE packs ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE packs ADD COLUMN IF NOT EXISTS credential_kind text CHECK (credential_kind IN ('ssh','token'));
ALTER TABLE packs ADD COLUMN IF NOT EXISTS credential_fingerprint text;
-- the host key line pinned on the first ssh fetch (public information), so a re-installed runner keeps the pin
ALTER TABLE packs ADD COLUMN IF NOT EXISTS host_key text;
ALTER TABLE packs ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
-- an authored pack: a save is on its way (and whether the author, an Owner or Admin, approves their own save)
ALTER TABLE packs ADD COLUMN IF NOT EXISTS save_pending boolean NOT NULL DEFAULT false;
ALTER TABLE packs ADD COLUMN IF NOT EXISTS save_approve boolean NOT NULL DEFAULT false;
-- a private pack and its owner are looked up on every registry read
CREATE INDEX IF NOT EXISTS packs_owner ON packs (owner_user_id) WHERE removed_at IS NULL;

-- Member opt-in: a pack assigned to the workstation of another member is cloned only after that member accepted.
-- No row (a pack from before R3a, or one on the admin's own workstation) means the workstation holds the pack.
CREATE TABLE IF NOT EXISTS pack_assignments (
  pack_id         uuid NOT NULL,
  workstation_id  uuid NOT NULL,
  user_id         uuid NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending','accepted')),
  desk_item_id    uuid,
  requested_by    uuid,
  requested_at    timestamptz NOT NULL,
  decided_at      timestamptz,
  PRIMARY KEY (pack_id, workstation_id)
);
CREATE INDEX IF NOT EXISTS pack_assignments_user ON pack_assignments (user_id) WHERE status = 'pending';

-- The sealed deploy key or token of a private git pack, per workstation. The ciphertext is held only while it waits for the
-- member's opt-in (or for the runner to come online) and is emptied once the runner stored it: the server never opens it.
CREATE TABLE IF NOT EXISTS pack_credential_shares (
  pack_id         uuid NOT NULL,
  workstation_id  uuid NOT NULL,
  key_id          text NOT NULL,
  ciphertext      text,
  username        text,
  status          text NOT NULL CHECK (status IN ('held','queued','stored','failed')),
  error           text,
  updated_at      timestamptz NOT NULL,
  PRIMARY KEY (pack_id, workstation_id)
);

ALTER TABLE pack_workstation_state ADD COLUMN IF NOT EXISTS host_key_pinned boolean NOT NULL DEFAULT false;
-- the revision the workstation holds (an authored organization pack travels to the others sealed)
ALTER TABLE pack_workstation_state ADD COLUMN IF NOT EXISTS content_sha text;

-- A private pack's owner lets some of their agents use it.
CREATE TABLE IF NOT EXISTS pack_agent_grants (
  pack_id    uuid NOT NULL,
  agent_id   uuid NOT NULL,
  granted_by uuid,
  granted_at timestamptz NOT NULL,
  PRIMARY KEY (pack_id, agent_id)
);

-- Asks that a workstation answers with file contents: the editor reading a pack (sealed to the page), hiring a persona, reviewing
-- a new version of a persona. The answer is stored only for what the server needs (hire/review); an editor read keeps only the
-- ciphertext, in memory, never here.
CREATE TABLE IF NOT EXISTS pack_requests (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  pack_id       uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('hire','role_review')),
  requested_by  uuid NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  error         text,
  params        jsonb NOT NULL DEFAULT '{}',
  -- hire: one entry per persona (text kept until the role exists); role_review: the proposed instructions
  results       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS pack_requests_pack ON pack_requests (pack_id, created_at DESC);

-- A pack update changed a persona an agent was hired from: a new role version is on offer (never applied by itself).
CREATE TABLE IF NOT EXISTS role_pack_offers (
  org_id       uuid NOT NULL,
  role_key     text NOT NULL,
  from_version integer NOT NULL,
  pack_id      uuid NOT NULL,
  capability   text NOT NULL,
  sha          text NOT NULL,
  hash         text NOT NULL,
  provenance   jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','dismissed')),
  offered_at   timestamptz NOT NULL,
  PRIMARY KEY (org_id, role_key)
);

-- Where an agent was hired from (a pack persona): shown on the HR board, the agent page and chats.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS provenance jsonb;

-- Persona chat: a one-to-one session with a persona that is not hired.
ALTER TABLE threads DROP CONSTRAINT IF EXISTS threads_kind_check;
ALTER TABLE threads ADD CONSTRAINT threads_kind_check
  CHECK (kind IN ('card','chat','devops','intake','phase','ceo_order','discovery','boardroom','persona_chat'));

-- A private pack's name must not tell other members that it exists: names are unique among the organization's visible packs, and
-- among one member's private packs.
DROP INDEX IF EXISTS packs_org_name;
CREATE UNIQUE INDEX IF NOT EXISTS packs_org_name_org ON packs (org_id, name) WHERE removed_at IS NULL AND visibility = 'org';
CREATE UNIQUE INDEX IF NOT EXISTS packs_org_name_private ON packs (org_id, owner_user_id, name)
  WHERE removed_at IS NULL AND visibility = 'private';
