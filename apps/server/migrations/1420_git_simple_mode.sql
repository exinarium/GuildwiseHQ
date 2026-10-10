-- Git expert mode is a per-user preference, OFF for everyone (existing users included): the simple mode hides branch
-- names, completion pickers and "Mark merged" behind plain-language outcomes. Set by UserGitExpertModeSet.
ALTER TABLE users ADD COLUMN git_expert boolean NOT NULL DEFAULT false;
-- How finished work lands in a project (the card's own completion action overrides it): 'merge' into the working
-- branch after review and test, or 'pr' (a pull request the manager approves). A protected branch flips it to 'pr'.
ALTER TABLE projects ADD COLUMN default_completion text NOT NULL DEFAULT 'merge' CHECK (default_completion IN ('merge','pr'));
