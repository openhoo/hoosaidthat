# Releasing

Releases are manual and fail closed. Run `.github/workflows/release.yml` from
the exact `v<package-version>` tag. Supply the full lowercase 40-character SHA
of an immutable HooVDA commit and explicitly confirm publication. The commit
must also match `images/hoovda/source.json`, which is exercised by the native
HooVDA image CI job and records the consumer's engine dependency. Release
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

Before tagging, run the [owned Windows qualification](../oracle/windows-nvda/README.md#run-and-observe-a-qualification)
against the exact candidate. On an Apple Silicon Mac, use the [guest-local WinHoo runner](../oracle/windows-nvda/README.md#local-mac-with-winhoo) with `--mode matrix --candidate <full-commit>`. It records installed guest hashes, the 40 block results and confirmed VM shutdown. Alternatively, use `qualification start` on a retained WSL2
workstation or `.github/workflows/nvda-oracle.yml` on the self-hosted Linux/KVM
runner. For the workflow, configure the repository variable
`NVDA_ORACLE_CONTAINER_ID` with the full ID of the stopped licensed container.
Require one matrix receipt with all 40 blocks (190 actions per locale/layout,
core and settings), zero retries, and confirmed guest shutdown. A diagnostic
replay or a green HooVDA image CI job is a separate result.
For a WinHoo run, also verify the original guest report archive offline with
WinHoo 0.2.0 or later. Use the inventory from the candidate checkout; it
declares the case titles independently of what Playwright tells the verifier
passed. The report for each block identifies its locale, keyboard layout, block
and guest attempt. The shutdown record is copied from that attempt's own
`desktop down` operation, before another run can replace it.

```sh
winhoo desktop verify-nvda-matrix "$evidence" \
  --inventory oracle/windows-nvda/matrix-inventory.json \
  --candidate "$(git rev-parse HEAD)" --tree "$(git rev-parse 'HEAD^{tree}')" \
  --engine "$(node -p 'require("./images/hoovda/source.json").commit')"
```

The qualification and release compare the HooVDA pin to the source tree on
upstream main, so a merge with identical bytes is accepted and new engine
changes must be reviewed before publication.
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
