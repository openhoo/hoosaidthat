# Releasing

Releases are manual and fail closed. Run `.github/workflows/release.yml` from
the exact `v<package-version>` tag. Supply the full lowercase 40-character SHA
of an immutable HooVDA commit and explicitly confirm publication. Release
versions may include a SemVer prerelease suffix but not build metadata, because
the same value is also an OCI tag.

## Publishing from GitHub Actions

All release builds and registry uploads run in GitHub Actions. The workflow
pins Node 24 and npm 11.20.0 and offers two explicit npm modes:

- `trusted` (default): `npm publish --access public --provenance` uses GitHub
  OIDC. Configure the package's trusted publisher on npmjs.com with organization
  `openhoo`, repository `hoosaidthat`, and workflow filename `release.yml`.
  Leave the environment unset, matching this workflow, and explicitly allow
  direct `npm publish`. The job has `id-token: write` and runs on a GitHub-hosted
  runner. This mode does not use `NPM_TOKEN`, `npm whoami`, or authenticated
  stage-list operations. A successful run verifies the public version's tarball
  integrity and npm provenance metadata against its publication receipt.
- `bootstrap-stage`: use this for the first package when its trusted publisher
  cannot yet be configured. Supply a temporary npm browser-login session token
  through the repository's `NPM_TOKEN` Actions secret. The workflow verifies
  the session and stages the package with provenance using `npm stage publish`.
  A maintainer must review and approve that stage with MFA on npmjs.com (or
  with `npm stage approve <stage-id>`) before it becomes public. The workflow
  labels this outcome **staged**, not published. Remove the temporary secret
  after the run, then configure the package's trusted publisher for later
  `trusted` releases. No local package build or publication is needed.

Creating a trusted publisher is a separate npm account configuration step;
adding this workflow to GitHub does not grant it permission on npm. Newly
configured publishers must complete their first successful publish within npm's
two-day validation window. Public registry reads do not prove publishing access.

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
promoting any image, the workflow requires the public npm version to be absent.
The bootstrap mode also requires staged versions to be absent. OIDC cannot list
staged packages; in trusted mode, npm enforces version collisions at publication.
The workflow also checks that all three destination image tags are absent
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
`npm-publication-receipt.json` with the publishing status and tarball integrity.
The bootstrap receipt also contains the validated stage ID; a trusted receipt
records successful public-registry integrity and provenance metadata checks.
Receipts include only explicitly selected package metadata; raw npm
responses and publishing credentials are not uploaded. The separate
`release-buildx-metadata` artifact preserves all three Buildx metadata files,
including their image digests and build metadata. These artifacts are retained for
30 days; download and retain them with the release record.
Check the selected mode and receipt status before announcing publication. A
successful bootstrap workflow means the three GHCR images are published and
the npm package is waiting for maintainer approval. A successful trusted run
means npm publication and public metadata verification are complete.
After a first release, set each GHCR package visibility deliberately and verify
the npm tarball, OCI digest, SBOM, provenance, and fresh-pull smoke before
announcing it.
