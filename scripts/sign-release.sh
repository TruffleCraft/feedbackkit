#!/bin/sh
# Signs a release file (SHA256SUMS) with the release key of the channel: writes <file>.sig.
# The key is an OpenSSH private key in FK_RELEASE_SIGNING_KEY (a secret of the GitHub
# environment: `production` holds the stable key, `dev` the dev key). It is written to a
# temporary file readable by this user only, and removed on exit.
set -eu
[ $# -eq 1 ] || { echo "usage: sign-release.sh <file>" >&2; exit 2; }
[ -n "${FK_RELEASE_SIGNING_KEY:-}" ] || { echo "FK_RELEASE_SIGNING_KEY is not set" >&2; exit 1; }
umask 077
key="$(mktemp)"
trap 'rm -f "$key"' EXIT INT TERM
printf '%s\n' "$FK_RELEASE_SIGNING_KEY" > "$key"
rm -f "$1.sig"
ssh-keygen -Y sign -q -f "$key" -n feedbackkit-release "$1"
[ -s "$1.sig" ] || { echo "no signature was written" >&2; exit 1; }
