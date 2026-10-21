/**
 * A container image reference: `[host[:port]/]path/name[:tag][@sha256:digest]`.
 *
 * The first part is a registry host only when it has a `.` or a `:` or is `localhost` (Docker's own rule), so
 * `192.168.1.11:5000/dcode-server:showcase-cd30f7bb33` is registry `192.168.1.11:5000`, name `dcode-server`, tag
 * `showcase-cd30f7bb33`, and `acme/api` is a Docker Hub path without a registry. A `:` only starts a tag after the last `/`.
 */
export interface ImageRef {
  /** `192.168.1.11:5000`, `ghcr.io`, `localhost:5000`; empty when the reference has no registry host. */
  registry: string;
  /** Everything between the registry and the tag, e.g. `dcode-server` or `acme/api`. */
  name: string;
  tag: string;
  digest: string;
}

export function parseImageRef(ref: string): ImageRef {
  let rest = ref.trim();
  let digest = '';
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let registry = '';
  const slash = rest.indexOf('/');
  if (slash > 0) {
    const first = rest.slice(0, slash);
    if (first.includes('.') || first.includes(':') || first === 'localhost') {
      registry = first;
      rest = rest.slice(slash + 1);
    }
  }
  let tag = '';
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  return { registry, name: rest, tag, digest };
}

/** The reference without its tag and digest, keeping the registry: `192.168.1.11:5000/dcode-server`. */
export function imageNameOf(ref: string): string {
  const p = parseImageRef(ref);
  return p.registry ? `${p.registry}/${p.name}` : p.name;
}
