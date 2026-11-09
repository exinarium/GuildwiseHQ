// Preloaded into a child process (`NODE_OPTIONS=--import=<this file>`) by specs that need a hostname for a stand-in
// service on this machine, like an /etc/hosts entry for one process. AOM_E2E_HOSTS lists `name=address` pairs separated
// by commas; every other name resolves as usual.
import dns from 'node:dns';

const map = new Map(
  (process.env.AOM_E2E_HOSTS ?? '')
    .split(',')
    .map((p) => p.split('='))
    .filter((p) => p.length === 2 && p[0] && p[1])
    .map(([name, address]) => [name.toLowerCase(), address]),
);

if (map.size) {
  const lookup = dns.lookup;
  dns.lookup = function patched(hostname, options, callback) {
    const address = map.get(String(hostname).toLowerCase());
    const cb = typeof options === 'function' ? options : callback;
    if (!address) return lookup.call(dns, hostname, options, callback);
    const family = address.includes(':') ? 6 : 4;
    const all = typeof options === 'object' && options?.all;
    process.nextTick(() => (all ? cb(null, [{ address, family }]) : cb(null, address, family)));
    return {};
  };
}
