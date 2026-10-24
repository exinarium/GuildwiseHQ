/** Shown to participants who are not the creator, an Owner or an Admin: they can talk, add notes and vote. */
export function ReadOnlyHint() {
  return (
    <p className="text-xs text-subtle" data-testid="read-only-hint">
      The session creator manages this session. You can talk, add notes and vote.
    </p>
  );
}
