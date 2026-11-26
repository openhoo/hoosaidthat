# Releasing

For the partial 0.1.5 release, use [Recover the 0.1.5 npm publication](recover-npm-015.md).

For a new release, run `.github/workflows/release.yml` from
the exact `v<package-version>` tag. Supply the full lowercase 40-character SHA
of an immutable HooVDA commit, the SHA-256 of the npm archive tested on
Windows (`expected_package_sha256`), and explicitly confirm publication. The
HooVDA commit must also match `images/hoovda/source.json`, which is exercised by the native
HooVDA image CI job and records the consumer's engine dependency. Release
versions may include a SemVer prerelease suffix but not build metadata, because
the same value is also an OCI tag.

## Publishing from GitHub Actions

All release builds and registry uploads run in GitHub Actions. The workflow
pins Node 24 and npm 11.20.0 and offers two npm modes for new releases:

- `trusted` (default): `npm publish --access public --provenance` uses GitHub
  OIDC. Configure the package's trusted publisher on npmjs.com with organization
  `openhoo`, repository `hoosaidthat`, and workflow filename `release.yml`.
  Leave the environment unset, matching this workflow, and explicitly allow
  direct `npm publish`. The job has `id-token: write` and runs on a GitHub-hosted
  runner. This mode does not use `NPM_TOKEN`, `npm whoami`, or authenticated
  stage-list operations. A successful run verifies the public version's tarball
  integrity and npm provenance metadata against its publication receipt.
- `bootstrap-stage`: use this for the first package when its trusted publisher
  cannot yet be configured. Have an npm maintainer set a temporary granular
  access token as the repository’s `NPM_TOKEN` Actions secret. For
  **packages and scopes**, select only `@openhoo/hoosaidthat` if it already
  exists, or the `@openhoo` scope for the first release. Choose
  `read-write-stage-only`; leave **organizations** at `no-access` and
  **Bypass 2FA** off. See [npm’s token permissions](https://docs.npmjs.com/cli/v11/commands/npm-token/)
  and [staged publishing](https://docs.npmjs.com/staged-publishing/).
  Choose the shortest expiry that covers runner queues, the full qualification
  and final staging. An [`npm login` session lasts two hours](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/);
  a previous qualification alone took 2 h 7 min. An initial successful
  `npm whoami` cannot establish that the credential will still work at promotion.
  The workflow rechecks the public version and the stage list before promoting
  the images. On `E401`, check credential validity and expiry; on `E403`, check
  package/scope permissions before starting another attempt. The workflow uses
  `npm stage publish` with provenance; a maintainer must review and approve
  the stage with MFA on npmjs.com (or with `npm stage approve <stage-id>`)
  before it becomes public. Revoke the bootstrap token and remove the Actions
  secret after use; configure the package’s trusted publisher for later releases.

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

### Pack the archive to qualify

Use Node 24 and npm 11.20.0 on a POSIX filesystem. Start from a fresh checkout
of the signed candidate with a **022 umask during checkout, build and pack**.
npm preserves file modes in the tarball: a 077 checkout can produce different
bytes even when every file has the same contents. Keep the checkout inside a
private directory. Preserve Git's normal file modes (0644 for regular files,
0755 for executables); changing the umask after checkout does not restore them.

With `repo` set to the source repository and `candidate` to the full signed
commit, use the trusted Git signers configured for the project:

```sh
git -C "$repo" verify-commit "$candidate" || exit 1
private=$(mktemp -d) || exit 1    # parent directory stays 0700
(
  set -eu
  umask 022
  git clone --no-checkout -- "$repo" "$private/sdk"
  cd "$private/sdk"
  git fetch --no-tags origin "$candidate"
  git checkout --detach "$candidate"
  test "$(git rev-parse HEAD)" = "$candidate"
  test "$(node -p 'process.versions.node.split(".")[0]')" = 24
  test "$(npm --version)" = 11.20.0
  npm ci
  npm test
  npm run typecheck
  npm run pack:check
  mkdir "$private/bundle"
  npm pack --pack-destination "$private/bundle"
)
```

Install the tarball in the consumer environment used for qualification. With
the Docker runner this is the host, which drives NVDA in the Windows guest. Take
`expected_package_sha256` from the verified evidence for the same archive
(`packageSha256` for the Docker verifier below). Use all 64 lowercase hex
digits for either npm mode. The build checks its tarball against this hash
before pushing any candidate image. The publishing job checks the downloaded
tarball again before promoting images or submitting the package to npm.

### Verify the Windows evidence

Before tagging, run the [owned Windows qualification](../oracle/windows-nvda/README.md#run-and-observe-a-qualification)
against the exact candidate. On an Apple Silicon Mac, use the [guest-local WinHoo runner](../oracle/windows-nvda/README.md#local-mac-with-winhoo) with `--mode matrix --candidate <full-commit>`. It records installed guest hashes, the 40 block results and confirmed VM shutdown. Alternatively, use `qualification start` on a retained WSL2
workstation or `.github/workflows/nvda-oracle.yml` on the self-hosted Linux/KVM
runner. For the workflow, configure the repository variable
`NVDA_ORACLE_CONTAINER_ID` with the full ID of the stopped licensed container.
Require one matrix receipt with all 40 blocks (190 actions per locale/layout,
core and settings), zero retries, and confirmed guest shutdown. A diagnostic
replay or a green HooVDA image CI job is a separate result.
For an Apple Silicon WinHoo run, also verify the original guest report archive offline with
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

For a retained AMD64 WinHoo desktop on Docker, run the installed
`hoosaidthat-windows-reader nvda parity` once under an owner that captures
the stopped container and disk before and after the run, the running NVDA
plugin identity, the signed package installation, and the HooVDA source check.
Keep the host observations (`before.json`, `after.json`, `live.json`), native
report and attachment archive (`matrix.zip`), and their checksums
(`qualification.json`) together in a private evidence directory. A standalone
`parity` invocation produces reader reports but does not collect the host
observations. From the candidate checkout, verify the evidence offline against
the full candidate commit and the independently inspected HooVDA tree:

```sh
python3 oracle/windows-nvda/verify-docker-qualification.py "$evidence" \
  --candidate "$(git rev-parse HEAD)" --engine-tree "$hoovda_tree"
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
The build job packs the tested npm files once; the publishing job checks the
archive checksum and publishes those bytes. Its `release-qualification-evidence`
artifact preserves `release-candidates.json` with source commits, workflow run
and attempt, candidate digests and destination tags, and
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

## Timing the qualification without publishing

Each hosted runner uses one screen reader at a time. Across runners, the four
language/layout combinations run concurrently, each divided into two groups that
together execute core, all eight action blocks, and settings. Browser, report,
doctor, smoke, and example checks run alongside them. The English desktop runs
the full HooVDA examples; the other three combinations retain the targeted
aria-details check. The Orca examples run in full. Each job uploads its own
evidence under `release-check-*`. A failed test or missing required upload
prevents promotion. For a new publication attempt, rerun **all jobs** so that
the build, qualification, and publication refer to the same attempt.

To time this on GitHub, open **Actions → Release → Run workflow**. Select
the branch with the workflow to measure, fill in the version and HooVDA pin,
and copy the existing candidate tag from the original run's
`release-candidates.json` (just `candidate-<source SHA>-<run ID>-<attempt>`).
Enter it as **rehearsal_candidate**, leave **expected_package_sha256** empty,
and leave **confirm_release** unchecked.
The rehearsal resolves the existing HooVDA and Orca indexes and runs the same
qualification against their digests with read-only permissions. It performs no
build or publication and does not take the lock for a real release.

Compare the old **Qualify release candidates** step with elapsed time from
the first qualification job starting until the last one finishes. Include
checkout, pulls, uploads, and runner waits within that interval; also record
total runner minutes separately. The rehearsed interval excludes the initial
release build and final promotion.
