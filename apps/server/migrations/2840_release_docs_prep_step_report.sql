-- Release prep: a step's own report (Generate videos: the videos chosen, why, and each render's result).
ALTER TABLE release_docs_prep_steps ADD COLUMN IF NOT EXISTS report jsonb;
