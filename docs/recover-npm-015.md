# Recover the 0.1.5 npm publication

Use this procedure only for `@openhoo/hoosaidthat@0.1.5`. The [original run](https://github.com/openhoo/hoosaidthat/actions/runs/45816609095/attempts/1)
built the archive, passed all 14 hosted qualification lanes and promoted all three
image indexes. The npm command then returned `ENEEDAUTH`. Rerunning the original
release would encounter occupied image tags.

## Before dispatch

1. Have an npm package maintainer verify that the trusted publisher for
   `@openhoo/hoosaidthat` allows **direct publishing** from GitHub organization
   `openhoo`, repository `hoosaidthat`, workflow `release.yml`, with no
   environment. Complete any npm account authentication on npmjs.com. No npm
   credential belongs in the workflow or the dispatch command.
2. Review the recovery change and verify its Git signature. Merge it as a
   two-parent merge onto `96adeb876f5dc94877de2b2f12cc2aaace49c1f3`. Record the
   full merge SHA and check that its tree is identical to the reviewed change.
   Wait for that exact merge's **push** CI on `main` to succeed. All seven jobs
   must pass. The workflow verifies the merge, signed parent, commit trees,
   current main and CI itself; it does not rely on branch protection.
3. Dispatch before the [original input artifact](https://github.com/openhoo/hoosaidthat/actions/runs/45816609095/artifacts/15117230053)
   expires on **December 26, 2026 at 12:17 UTC**. Set `reviewed_merge` to the SHA
   you recorded. Do not resolve it from a moving branch at dispatch time.

```sh
gh workflow run release.yml -R openhoo/hoosaidthat --ref main \
  -f version=0.1.5 \
  -f hoovda_ref=71cae236a506d598c201f15da4d8e7aa118a8ca1 \
  -f npm_publish_mode=recover-npm-0.1.5 \
  -f expected_package_sha256=b249b33dfb7d46fb6d625d6697e35e8fe32f0da77dbcb84fe36c7af36d2a0c74 \
  -f expected_recovery_commit="${reviewed_merge:?set to the reviewed main merge SHA}" \
  -f confirm_release=true
```

The job takes only the original GitHub artifact. It verifies the signed tag,
source and engine trees, original run and jobs, ZIP and candidate manifest
hashes, package identity and archive bytes. It checks anonymously that npm
still reports 0.1.5 absent and `latest` is 0.1.2, and that the three public
image indexes still have their original digests. It then submits the verified
archive once with provenance and the `latest` dist-tag. It neither builds
artifacts nor authenticates to GHCR.

## Confirm the outcome

Download the recovery run's `npm-only-0.1.5-<run>-1` evidence artifact. The
original package is bound to `v0.1.5`, commit
`b3b177122fef654f2a823a1c5251befd869204c0`. Its public npm provenance must
identify the **recovery** invocation of `release.yml@refs/heads/main` and its
reviewed merge. These are separate source and publisher identities.

The job reads npm anonymously and checks the downloaded tarball against the
original bytes, the `latest` tag, and the signed Sigstore provenance. Keep
`public-readback.json` and `npm-sigstore-bundle.json` with the originals'
qualification, dispatch, destination checks and npm response. An accepted
write or a successful CLI exit alone does not establish that verification.

If the job fails, inspect the recorded steps and partial evidence first. A
network error or missing CLI receipt can follow a successful registry write.
The workflow attempts anonymous readback after submission, including a CLI
error. If it was canceled or timed out before readback finished, inspect npm
anonymously yourself. **Do not rerun the job or dispatch again after an ambiguous result.** Inspect
the public version and its provenance. If it exists with unexpected bytes,
publisher or dist-tag, stop and have a maintainer investigate. If npm rejected
the submission, resolve the reported cause and confirm the public version is
still absent before making any separate recovery decision. Keep the three
existing image tags.
