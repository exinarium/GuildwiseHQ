# Test-only minisign keys (never trusted by a release)

Generated for the 1.10.0 signed-runner tests (R18-U, R21, R27, R30) with minisign 0.12. No release build, image or
server trusts these keys: the official key is the owner's (`apps/runner/release-key/`, a placeholder until the release
step), and UAT and production keys are never in the repository. The secret keys here are fixtures and deliberately public.

| File | What |
|---|---|
| `test.pub` / `test.key` | key id `8399E5B65A3876B0`, no passphrase (`minisign -G -W`) |
| `other.pub` / `other.key` | key id `F0D6288B1CBE00A7`, no passphrase: "signed by another key" |
| `protected.pub` / `protected.key` | passphrase `test-passphrase` (scrypt): `autoSign` must refuse it (R30, Q14) |
| `aom-runner-1.10.0.tgz` | a text file standing in for the runner tarball (its sha256 is in the manifest) |
| `manifest.json` | the release manifest shape (`RunnerReleaseManifestSchema`, packages/shared/src/security) |
| `manifest.json.minisig` | `minisign -S -s test.key -m manifest.json -t "guildwise-runner 1.10.0"` |
| `manifest.json.other.minisig` | the same, signed with `other.key` |

Check: `minisign -V -p test.pub -m manifest.json -x manifest.json.minisig`.
