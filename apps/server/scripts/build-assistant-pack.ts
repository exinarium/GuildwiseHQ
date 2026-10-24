import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIndexPack, buildTopicFiles, INDEX_FILE, TOPICS_DIR } from '../src/assistant/pack-builder.ts';

// Rebuilds the landing-page assistant's knowledge from the help articles and docs/assistant/product-facts.md:
// the always-on index and one chunk per help topic.
const index = buildIndexPack();
const topics = buildTopicFiles();
mkdirSync(TOPICS_DIR, { recursive: true });
writeFileSync(INDEX_FILE, index);
for (const f of readdirSync(TOPICS_DIR)) if (!(f in topics)) rmSync(join(TOPICS_DIR, f));
for (const [f, text] of Object.entries(topics)) writeFileSync(join(TOPICS_DIR, f), text);
const size = Object.values(topics).reduce((n, t) => n + t.length, 0);
console.log(
  `wrote ${INDEX_FILE} (${index.length} characters, about ${Math.round(index.length / 4)} tokens) and ${Object.keys(topics).length} topics (${size} characters)`,
);
