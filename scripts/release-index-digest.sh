#!/usr/bin/env bash

# Read the entire registry response before comparing it to the qualified index.
verify_index_digest() (
  set -o pipefail
  local reference=$1 expected=$2 checksum actual
  if [[ ! "$expected" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "Invalid expected image index digest: $expected" >&2
    return 1
  fi
  if ! checksum=$(docker buildx imagetools inspect --raw "$reference" | sha256sum); then
    echo "Could not read and hash the complete image index: $reference" >&2
    return 1
  fi
  actual="sha256:${checksum%% *}"
  if [[ "$actual" != "$expected" ]]; then
    echo "Wrong image index digest for $reference: expected $expected, got $actual" >&2
    return 1
  fi
)
