# Releasing

Releases are manual and fail closed. Run `.github/workflows/release.yml` from
the exact `v<package-version>` tag. Supply the full lowercase 40-character SHA
of an immutable HooVDA commit and explicitly confirm publication.

Required repository secret:

- `NPM_TOKEN`: automation token for `@openhoo/hoosaidthat`; configure npm
  provenance or trusted publishing for this workflow.

The workflow refuses publication unless package version and Git tag match,
HooVDA source resolves to the requested commit, the complete provenance-pinned
oracle corpus matches exactly, security and test gates pass, both
runtime images pass real screenreader smoke and Playwright E2E, and npm packing
succeeds. It publishes version-only Linux/amd64 tags; it does not move `latest`.

Published artifacts:

- `@openhoo/hoosaidthat` on npm, with provenance;
- `ghcr.io/openhoo/hoosaidthat-hoovda:<version>`;
- `ghcr.io/openhoo/hoosaidthat-orca:<version>`;
- `ghcr.io/openhoo/hoosaidthat-hoovda-engine:<version>` as the pinned base.

Image pushes request BuildKit SBOM and maximal provenance attestations. After a
first release, set each GHCR package visibility deliberately and verify the npm
tarball, OCI digest, SBOM, provenance, and fresh-pull smoke before announcing it.
