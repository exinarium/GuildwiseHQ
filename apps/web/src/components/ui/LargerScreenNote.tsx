import { Callout } from './Callout.tsx';

/** Shown on phones only (below `md`) above editors that are not made for touch: they stay viewable. */
export function LargerScreenNote() {
  return (
    <div className="md:hidden" data-testid="larger-screen-note">
      <Callout tone="info" role="note" className="mb-4">
        Editing works best on a larger screen. You can look at everything here on your phone.
      </Callout>
    </div>
  );
}
