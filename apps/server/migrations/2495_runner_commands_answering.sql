-- Security review (finding 21): the answer to a durable command is claimed atomically (`UPDATE ... answering_at`) before it is
-- applied, so two answers to the same command (a redelivered command that ran twice) cannot both apply. The claim is a short lease.
ALTER TABLE runner_commands ADD COLUMN IF NOT EXISTS answering_at timestamptz;
