/** The shell patterns every role denies (no pushing, rebasing, branch switching, force resets, sudo). */
export const COMMON_DENIED_SHELL = [
  'git push*',
  'git rebase*',
  'git checkout*',
  'git switch*',
  'git reset --hard*',
  'rm -rf /*',
  'sudo *',
];
