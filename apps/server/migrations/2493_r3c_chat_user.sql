-- R3c (Q64): the person in an agent chat is recorded on the chat's shift, so a playbook the agent starts there belongs to them.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS chat_user_id uuid;
