import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import './index.css';
import { ApiError } from './api/client.ts';
import { ToastProvider } from './components/ui.tsx';
import { createRouter } from './router.tsx';
import { initSocket } from './ws/socket.ts';

const queryClient = new QueryClient({
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
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
void boot();
