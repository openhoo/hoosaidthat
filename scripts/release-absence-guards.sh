# Registry absence must be proven both before building and immediately before promotion.
require_npm_not_found() {
  local lookup=$1 code
  # Only a single structured npm error is evidence. Neither the response nor
  # npm's diagnostics belong in the release logs.
  code=$(jq -ser 'select(length == 1) | .[0].error.code | select(. == "E401" or . == "E403" or . == "E404")' 2>/dev/null) || code=
  case "$code" in
    E404) return 0 ;;
    E401) echo "Cannot prove $lookup is absent: npm authentication failed (E401); check whether the credential is missing or expired. Release refused." >&2 ;;
    E403) echo "Cannot prove $lookup is absent: npm denied access (E403); check the credential's package and scope permissions. Release refused." >&2 ;;
    *) echo "Cannot prove $lookup is absent; release refused" >&2 ;;
  esac
  return 1
}

require_unused_npm_version() {
  local package_name result
  package_name=$(node -p 'require("./package.json").name')
  if result=$(npm view "${package_name}@${RELEASE_VERSION}" version --json \
    --registry=https://registry.npmjs.org 2>/dev/null); then
    echo "npm version already exists; release refused" >&2
    return 1
  fi
  require_npm_not_found 'public npm version' <<< "$result" || return 1
  if [[ "$NPM_PUBLISH_MODE" == bootstrap-stage ]]; then
    if result=$(npm stage list "$package_name" --json --registry=https://registry.npmjs.org 2>/dev/null); then
      if ! jq -se --arg package "$package_name" --arg version "$RELEASE_VERSION" \
        'length == 1 and (.[0] | type == "array" and all(.[]; type == "object" and .packageName == $package and (.version | type == "string")) and all(.[]; .version != $version))' \
        >/dev/null 2>&1 <<< "$result"; then
        echo "npm staged version exists or stage listing is invalid; release refused" >&2
        return 1
      fi
    else
      require_npm_not_found 'staged npm version' <<< "$result" || return 1
    fi
  fi
}
require_unused_image_tag() {
  local reference=$1 result error
  result=$(mktemp)
  if docker buildx imagetools inspect "$reference" > "$result" 2>&1; then
    echo "Image version tag already exists: $reference; release refused" >&2
    return 1
  fi
  error=$(cat "$result")
  error=${error#ERROR: }
  case "$error" in
    "$reference: not found"|"$reference: manifest unknown"|"$reference: manifest unknown: manifest unknown"|"manifest unknown") ;;
    *) echo "Cannot prove image version tag is absent: $reference; release refused" >&2; return 1 ;;
  esac
}
