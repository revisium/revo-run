# revo-run Release Train

The package is intended for npm publication as `@revisium/revo-run`. Release
automation delegates to immutable revisions of
[`revisium/revisium-actions`](https://github.com/revisium/revisium-actions).

## Principles

- Publish only after explicit approval.
- Run every release-train transition in dry-run mode first.
- Do not publish locally or directly from `master`.
- Do not manually create release branches or tags.
- Never reuse or overwrite a published npm version.
- Verify the exact packed artifact and isolated consumer before publication.
- Update reusable-workflow pins intentionally in a separate maintenance change.

## Workflows

- `ci.yml` verifies pull requests, `master`, and `release/**`.
- `release.yml` manually creates a verified package artifact without publishing.
- `release-train.yml` computes and applies approved version/branch/tag transitions.
- `npm-publish.yml` publishes exact SemVer tags with npm provenance.

## Publish flow

1. Run `Release Train` with `dry_run: true`.
2. Review the computed branch, version, tag, and npm channel.
3. Obtain explicit write-mode approval.
4. Repeat the same transition with `dry_run: false`.
5. Wait for the exact tag's npm publish workflow.
6. Verify the registry version and dist-tag.
7. Install the published package in a clean consumer and run the root smoke test.

Write mode requires `RELEASE_BOT_PRIVATE_KEY`; token publication requires
`NPM_TOKEN`. Repository variables and GitHub App configuration remain
repository-administration responsibilities.

The initial stable tag is an explicit administration action outside the
workflow. Before `1.0.0`, use minor versions for public behavior/API changes and
patch versions for compatible fixes and hardening.
