/** "Send me the weekly blog digest": the opt-in at sign-up and invitation acceptance (docs/design/blog-prd.md section 11). */
export function DigestCheckbox({
  checked,
  onChange,
  owner,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  owner: boolean;
}) {
  return (
    <label className="flex items-start gap-3 text-base text-fg">
      <input
        type="checkbox"
        className="mt-0.5 size-5"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid="invite-digest"
      />
      <span>
        Email me the weekly Guildwise HQ blog digest
        <span className="block text-sm text-muted">
          One mail on Monday mornings with the new articles, only in weeks with something new.
          {owner ? ' Owners get it by default.' : ''} You can unsubscribe in one click or in Settings.
        </span>
      </span>
    </label>
  );
}
