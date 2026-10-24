import { SECURE_CONTEXT_MESSAGE } from '@aom/shared';
import { canSealHere } from '../lib/secure.ts';
import { Callout } from './ui.tsx';

/** Shown next to a form that seals a secret in the browser when the page is not a secure context; the form's submit is disabled meanwhile. */
export function SecureContextNotice({ className }: { className?: string }) {
  if (canSealHere()) return null;
  return (
    <Callout tone="warning" role="alert" className={className} data-testid="secure-context-notice">
      {SECURE_CONTEXT_MESSAGE}.
    </Callout>
  );
}
