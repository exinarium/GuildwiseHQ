-- Project setting "Pull request branch prefix": the branch a pull request is pushed under is <prefix>/<ticket>
-- (for example pieter/DCPL-4276). Empty means the default prefix "feature". The local card branch is unchanged.
ALTER TABLE projects ADD COLUMN pr_branch_prefix text NOT NULL DEFAULT '';
