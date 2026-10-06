import { TriangleAlert } from 'lucide-react';
import { useRouteError } from 'react-router';
import { Logo } from './Logo.tsx';
import { Button, Disclosure, EmptyState } from './ui.tsx';

/** Router-level error boundary: a calm full-page state with a reload and the technical details collapsed. */
export function RouteError() {
  const error = useRouteError();
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-6 px-6 py-10">
      <Logo variant="auto" height={30} />
      <EmptyState
        icon={TriangleAlert}
        tone="danger"
        title="Something went wrong"
        description="The page hit an unexpected error. Your work on the server is safe. Reload to try again."
        action={
          <Button variant="primary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        }
      />
      <Disclosure summary="Technical details">
        <pre className="overflow-x-auto rounded-control bg-sunken p-3 font-mono text-xs whitespace-pre-wrap text-fg">
          {detail}
        </pre>
      </Disclosure>
    </main>
  );
}
