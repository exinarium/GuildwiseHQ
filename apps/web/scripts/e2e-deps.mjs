// Playwright and axe live in the e2e package (`pnpm install` at the repository root installs them). The screenshot and
// audit scripts load them from there, so they run from any checkout; AOM_E2E_DIR points at another e2e directory.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const e2eDir = process.env.AOM_E2E_DIR ?? fileURLToPath(new URL('../../../e2e/', import.meta.url));
const req = createRequire(`${e2eDir.replace(/\/?$/, '/')}package.json`);

export const { chromium, request } = req('@playwright/test');
export const loadAxe = () => req('@axe-core/playwright').AxeBuilder;
