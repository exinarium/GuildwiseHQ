import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import './index.css';
import { ApiError } from './api/client.ts';
import { UpdateToast } from './components/pwa/UpdateToast.tsx';
import { ToastProvider } from './components/ui.tsx';
import { installClientErrorBuffer, recordClientError } from './lib/client-errors.ts';
import { registerServiceWorker } from './lib/pwa.ts';
import { createRouter } from './router.tsx';
import { initSocket } from './ws/socket.ts';

installClientErrorBuffer();

const queryClient = new QueryClient({
  // a failed request is worth knowing about when someone writes to support (not 4xx the user caused)
  queryCache: new QueryCache({
    onError: (err, query) => {
      if (err instanceof ApiError && err.status < 500) return;
      recordClientError(err, `query ${JSON.stringify(query.queryKey).slice(0, 80)}`);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

async function boot() {
  const socket = initSocket(queryClient);
  if (import.meta.env.VITE_MSW === '1') {
    const { startMocks } = await import('./mocks/browser.ts');
    await startMocks(socket);
  }
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <RouterProvider router={createRouter()} />
          <UpdateToast />
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
void boot();
registerServiceWorker();
