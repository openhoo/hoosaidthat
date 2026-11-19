# Registry absence must be proven both before building and immediately before promotion.
require_unused_npm_version() {
  local package_name public_result stage_result
  package_name=$(node -p 'require("./package.json").name')
  public_result=$(mktemp)
  if npm view "${package_name}@${RELEASE_VERSION}" version --json \
    --registry=https://registry.npmjs.org > "$public_result" 2> "${public_result}.stderr"; then
    echo "npm version already exists; release refused" >&2
    return 1
  fi
  if ! jq -e 'type == "object" and .error.code == "E404"' "$public_result" > /dev/null; then
    echo "Cannot prove npm version is absent; release refused" >&2
    return 1
  fi
  if [[ "$NPM_PUBLISH_MODE" == bootstrap-stage ]]; then
    stage_result=$(mktemp)
    if npm stage list "$package_name" --json --registry=https://registry.npmjs.org \
      > "$stage_result" 2> "${stage_result}.stderr"; then
      if ! jq -e --arg package "$package_name" --arg version "$RELEASE_VERSION" \
        'type == "array" and all(.[]; type == "object" and .packageName == $package and (.version | type == "string")) and all(.[]; .version != $version)' \
        "$stage_result" > /dev/null; then
        echo "npm staged version exists or stage listing is invalid; release refused" >&2
        return 1
      fi
    elif ! jq -e 'type == "object" and .error.code == "E404"' "$stage_result" > /dev/null; then
      echo "Cannot prove npm staged version is absent; release refused" >&2
      return 1
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
