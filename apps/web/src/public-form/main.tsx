import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { PUBLIC_FORM_ID_RE } from '@aom/shared';
import { PublicFormPage, takeLinkToken } from './PublicFormPage.tsx';

const publicId = window.location.pathname.split('/')[2] ?? '';
const root = document.getElementById('root') as HTMLElement;
const link = takeLinkToken();

createRoot(root).render(
  <StrictMode>
    {PUBLIC_FORM_ID_RE.test(publicId) ? (
      <PublicFormPage publicId={publicId} linkToken={link} />
    ) : (
      <main className="mx-auto max-w-xl p-6">
        <p className="text-base">This form is not available.</p>
      </main>
    )}
  </StrictMode>,
);
