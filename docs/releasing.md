# Releasing

Releases are manual and fail closed. Run `.github/workflows/release.yml` from
the exact `v<package-version>` tag. Supply the full lowercase 40-character SHA
of an immutable HooVDA commit and explicitly confirm publication. Release
versions may include a SemVer prerelease suffix but not build metadata, because
the same value is also an OCI tag.

Required repository secret:

- `NPM_TOKEN`: publishing credential for `@openhoo/hoosaidthat`. Staging accepts
  a browser-login session token and does not require a token that bypasses MFA.
  Deliver a temporary session token directly to the repository secret without
  printing it, and remove that secret after the run. The workflow pins npm
  11.20.0 for staged publishing with provenance.

The workflow refuses publication unless package version and Git tag match,
HooVDA source resolves to the requested commit, the complete provenance-pinned
oracle corpus matches exactly, security and test gates pass, both
runtime images pass real screenreader smoke and Playwright E2E, and npm packing
succeeds. Report qualification explicitly enables capture against the candidate
HooVDA image and verifies the exported file's original audio, source positions,
desktop/mobile interaction, and offline operation. Synthetic report edge cases
and browser session regressions also run before publication. It publishes
version-only Linux/amd64 tags; it does not move `latest`.

Runs for the same version are serialized. Before building, and again before
promoting any image, the workflow requires both public and staged npm versions
to be absent. It also checks that all three destination image tags are absent
before promotion. Only explicit registry not-found responses count as absence;
authentication, network, and malformed responses stop the release. Stable npm
versions use the explicit `latest` dist-tag; prereleases use `next`.

Before tagging, run `.github/workflows/nvda-oracle.yml` for the exact candidate
commit on a trusted self-hosted runner labeled `linux`, `x64`, `kvm`, and
`nvda-oracle`, or run `npm run nvda:windows:parity` on the operator workstation.
That separate gate owns the persistent licensed Windows VM, selects and attests
each real-NVDA process locale, executes the complete four-cell 190-action
semantic matrix plus settings and core behavior gates, uploads only Playwright
evidence, and shuts the guest down.
GitHub-hosted release jobs intentionally do not install or redistribute Windows
or NVDA.

Published artifacts:

- `@openhoo/hoosaidthat` on npm, with provenance;
- `ghcr.io/openhoo/hoosaidthat-hoovda:<version>`;
- `ghcr.io/openhoo/hoosaidthat-orca:<version>`;
- `ghcr.io/openhoo/hoosaidthat-hoovda-engine:<version>` as the pinned base.

Image builds push run-scoped candidate indexes with BuildKit SBOM and maximal
provenance attestations. Qualification pulls those exact digests. Publication
then promotes the same OCI indexes to version tags without rebuilding them.
The always-uploaded `release-qualification-evidence` artifact preserves the
qualification results, `release-candidates.json` with source commits, workflow
run and attempt, candidate digests and destination tags, and
`npm-stage-receipt.json` with the validated stage ID and tarball integrity.
The stage receipt includes only explicitly selected package metadata; raw npm
responses and publishing credentials are not uploaded. The separate
`release-buildx-metadata` artifact preserves all three Buildx metadata files,
including their image digests and build metadata. These artifacts are retained for
30 days; download and retain them with the release record.
The final npm step submits an attested staged package. It is not public until
the maintainer runs `npm stage list @openhoo/hoosaidthat`, verifies the candidate
version and provenance, and runs `npm stage approve <stage-id>`. Approval
requires the maintainer's MFA. This workflow supports staging the first version
before the public package exists. A successful workflow alone does not mean
npm publication is complete.
After a first release, set each GHCR package visibility deliberately and verify
the npm tarball, OCI digest, SBOM, provenance, and fresh-pull smoke before
announcing it.
