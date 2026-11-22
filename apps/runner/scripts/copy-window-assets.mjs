// Copies the approvals page (src/window/static), the web app's design tokens and logos, and the Geist font into
// `dist/window/`, so the release tarball serves the page offline with Guildwise's look (easy-runner-setup, DESIGN
// "Approvals window": no CDN). The font is a pinned devDependency; its licence is in THIRD_PARTY_NOTICES.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const web = join(root, '..', 'web');
const require = createRequire(join(root, 'package.json'));
const font = (sub) => require.resolve(`@fontsource-variable/geist/files/geist-${sub}-wght-normal.woff2`);
const out = join(root, 'dist', 'window');
mkdirSync(out, { recursive: true });
// published name -> source (the names server.ts WINDOW_ASSETS serves)
const files = {
  'index.html': join(root, 'src', 'window', 'static', 'index.html'),
  'window.js': join(root, 'src', 'window', 'static', 'window.js'),
  'window.css': join(root, 'src', 'window', 'static', 'window.css'),
  'tokens.css': join(web, 'src', 'tokens.css'),
  'logo-light.svg': join(web, 'public', 'brand', 'logo-light.svg'),
  'logo-dark.svg': join(web, 'public', 'brand', 'logo-dark.svg'),
  'favicon.svg': join(web, 'public', 'brand', 'favicon.svg'),
  'geist-latin.woff2': font('latin'),
  'geist-latin-ext.woff2': font('latin-ext'),
};
for (const [name, src] of Object.entries(files)) {
  if (!existsSync(src)) throw new Error(`approvals page asset missing: ${src}`);
  copyFileSync(src, join(out, name));
}
console.log(`copied ${Object.keys(files).length} approvals page assets to dist/window/`);
