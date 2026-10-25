## Summary

<!-- What does this change, and why? One logical change per pull request. -->

## Related issue or discussion

<!-- For example: Closes #123, or a link to the discussion. -->

## How it was tested

<!-- The commands you ran and what they showed. For example:
pnpm -r typecheck
pnpm lint
cd apps/server && AOM_TEST_DB_URL=... npx vitest run test/<file>.test.ts -->

## Checklist

- [ ] **DCO:** every commit has a `Signed-off-by` line (`git commit -s`). See [CONTRIBUTING.md](../CONTRIBUTING.md#developer-certificate-of-origin-dco).
- [ ] The change has tests, or I explained why it does not need them.
- [ ] `pnpm -r typecheck` and `pnpm lint` pass.
- [ ] Server changes are event-based and replay-safe. Schema changes are a new numbered migration. Data fixes are data migrations.
- [ ] Documentation is updated where behaviour or setup changed.
- [ ] No secrets, tokens, personal data or real hostnames or IP addresses are included.
- [ ] I have read the [Code of Conduct](../CODE_OF_CONDUCT.md).

## Notes for the reviewer

<!-- Anything that needs attention, a trade-off you made, or a question. -->
