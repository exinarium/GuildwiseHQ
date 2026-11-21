import { parseArgs } from 'node:util';
import { ExportRefused, exportBundle } from '../src/blog/bundle/export.ts';

/**
 * `pnpm --filter @aom/server exec tsx scripts/blog-bundle-export.ts --dump <old.sql.gz> [--compare <later.sql.gz>] --out <dir>`
 * (development machine only, not in the image): writes the article carry-over bundle from an old install's plain
 * `pg_dump` file. The dump is parsed as text, never run (docs/SELF-HOSTING.md "Carry blog articles to a new install").
 */
const { values } = parseArgs({
  options: { dump: { type: 'string' }, compare: { type: 'string' }, out: { type: 'string' } },
});
if (!values.dump || !values.out) {
  console.error(
    'usage: blog-bundle-export --dump <file.sql[.gz]> [--compare <file.sql[.gz]>] --out <empty dir>',
  );
  process.exit(2);
}
try {
  const r = await exportBundle({ dump: values.dump, compare: values.compare, out: values.out });
  const c = r.manifest.counts;
  console.log(`Bundle ${r.bundleId} written to ${values.out}`);
  console.log(`posts ${c.posts}, releases ${c.releases}, videos ${c.videos}, shares ${c.shares}`);
  console.log(
    `differences with the compared dump: ${r.manifest.compared ? r.differences.length : 'not compared'}`,
  );
  console.log(`recorded content findings: ${r.findings.length} (see REPORT.md); blocking: 0`);
} catch (e) {
  console.error(e instanceof ExportRefused ? `refused: ${e.message}` : (e as Error).message);
  process.exitCode = 1;
}
