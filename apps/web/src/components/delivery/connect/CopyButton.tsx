import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../ui.tsx';

/** Copies a text to the clipboard (the key to paste into a hosting panel). */
export function CopyButton({
  text,
  label = 'Copy',
  testId,
}: {
  text: string;
  label?: string;
  testId?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 2500);
          },
          () => undefined,
        );
      }}
      data-testid={testId}
    >
      {done ? (
        <Check aria-hidden="true" className="size-4" />
      ) : (
        <Copy aria-hidden="true" className="size-4" />
      )}
      {done ? 'Copied' : label}
    </Button>
  );
}
