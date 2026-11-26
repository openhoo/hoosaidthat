# Both publication modes must use the same bytes that were tested on Windows.
require_package_sha256() {
  local LC_ALL=C
  if [[ ! "${EXPECTED_PACKAGE_SHA256:-}" =~ ^[0-9a-f]{64}$ ]]; then
    echo 'expected_package_sha256 must be the 64 lowercase hex digits from the qualified npm archive.' >&2
    return 1
  fi
}

verify_package_sha256() {
  local actual
  require_package_sha256 || return 1
  actual=$(sha256sum < "$1") || return 1
  actual=${actual%% *}
  if [[ "$actual" != "$EXPECTED_PACKAGE_SHA256" ]]; then
    printf 'Qualified npm archive SHA-256: %s; release archive SHA-256: %s. Publication refused.\n' \
      "$EXPECTED_PACKAGE_SHA256" "$actual" >&2
    return 1
  fi
}
