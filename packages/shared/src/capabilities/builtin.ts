import { BUILTIN_CAPABILITY_FILES } from './builtin-data.ts';
import { type CapabilityMeta, capabilityMeta, indexCapabilityTree, type ParsedCapability } from './parse.ts';

/**
 * The capabilities shipped with the product. The files live in `packages/capabilities/` and are compiled into
 * `builtin-data.ts` by `packages/capabilities/generate.mjs` (a test fails when the two disagree), so the server and the
 * runner bundles carry them and the web app can list them without a file system.
 */
let cached: ParsedCapability[] | undefined;

export function builtinCapabilities(): ParsedCapability[] {
  if (!cached) {
    const { entries, issues } = indexCapabilityTree(BUILTIN_CAPABILITY_FILES);
    if (issues.length) throw new Error(`built-in capabilities are invalid: ${JSON.stringify(issues)}`);
    cached = entries;
  }
  return cached;
}

export function builtinCapabilityMeta(): CapabilityMeta[] {
  return builtinCapabilities().map((e) => capabilityMeta(e, 'builtin'));
}
