# Releasing

Releases are manual and fail closed. Run `.github/workflows/release.yml` from
the exact `v<package-version>` tag. Supply the full lowercase 40-character SHA
of an immutable HooVDA commit and explicitly confirm publication. Release
versions may include a SemVer prerelease suffix but not build metadata, because
the same value is also an OCI tag.

Required repository secret:

- `NPM_TOKEN`: automation token for `@openhoo/hoosaidthat`; configure npm
  provenance or trusted publishing for this workflow.

The workflow refuses publication unless package version and Git tag match,
HooVDA source resolves to the requested commit, the complete provenance-pinned
oracle corpus matches exactly, security and test gates pass, both
runtime images pass real screenreader smoke and Playwright E2E, and npm packing
succeeds. It publishes version-only Linux/amd64 tags; it does not move `latest`.

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
After a first release, set each GHCR package visibility deliberately and verify
the npm tarball, OCI digest, SBOM, provenance, and fresh-pull smoke before
announcing it.
