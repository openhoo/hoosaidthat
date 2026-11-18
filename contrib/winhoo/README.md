# Managed Windows operator

The WinHoo operator used for workstation qualification has a different lifecycle
from the Linux Podman CLI: it owns a lease and heartbeat, provisions the guest,
and shuts down its own container after the consumer exits. Use this adapter to
bind that operator to the same engine-state checks. It leaves the release
candidate, guest payload and existing qualification evidence untouched.

From a checkout of this repository, set `WINHOO_OPERATOR` to the **new staging
copy** of the WinHoo operator, with its existing package dependencies. The copy
must be writable. Apply once:

```sh
patch_file="$(pwd)/contrib/winhoo/managed-engine-control.patch"
git -C "$WINHOO_OPERATOR" apply --check "$patch_file" &&
  git -C "$WINHOO_OPERATOR" apply "$patch_file" &&
  cp oracle/windows-nvda/engine-state.mjs "$WINHOO_OPERATOR/oracle/windows-nvda/"
node "$WINHOO_OPERATOR/scripts/nvda-windows.mjs" preflight
```

Preflight reads the saved engine and reports the exact container ID and state.
A missing socket, timeout or malformed state exits nonzero without starting
Windows. If the engine disappears during a run, or the original container is
replaced, the owner defers cleanup. Restore the same engine, check the full ID
against the original receipt and inspect the retained disk before recovery.

Exercise the installed operator's real startup and cleanup paths with simulated
host commands (no Windows boot):

```sh
HST_TEST_WINHOO_OPERATOR="$WINHOO_OPERATOR/scripts/nvda-windows.mjs" \
  node --test scripts/tests/nvda-engine-cli.test.mjs
```
