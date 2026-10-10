import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildPublicPack, PACK_FILE } from '../src/assistant/pack-builder.ts';

// Rebuilds the landing-page assistant's knowledge pack from the help articles and docs/assistant/product-facts.md.
const text = buildPublicPack();
mkdirSync(dirname(PACK_FILE), { recursive: true });
writeFileSync(PACK_FILE, text);
console.log(`wrote ${PACK_FILE} (${text.length} characters, about ${Math.round(text.length / 4)} tokens)`);
