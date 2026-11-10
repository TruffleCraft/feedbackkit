#!/bin/sh
# Creates the two release key pairs (Ed25519, no passphrase) in a new directory and says
# what to do with them. Run it once by hand, on a machine you trust (docs/RELEASES.md,
# "Release keys"). Nothing is uploaded and no secret is stored anywhere by this script.
set -eu
dir="${1:-./release-keys-new}"
[ ! -e "$dir" ] || { echo "$dir exists. Choose a new directory." >&2; exit 1; }
umask 077
mkdir -p "$dir"
for channel in stable dev; do
  ssh-keygen -q -t ed25519 -N '' -C "feedbackkit-release-$channel" -f "$dir/$channel"
done
cat <<TEXT
Created in $dir:
  stable, stable.pub   the key of stable releases (vX.Y.Z)
  dev, dev.pub         the key of dev builds (vX.Y.Z-dev.N)

1. Commit the two public keys as release-keys/stable.pub and release-keys/dev.pub.
2. Store the private key of each channel as the secret FK_RELEASE_SIGNING_KEY of the GitHub
   environment of that channel: stable in "production", dev in "dev". Keep a copy of both in
   your password manager, then delete the directory $dir.
3. Put the stable public key in docs/RELEASES.md ("Release keys") with its fingerprint:
$(ssh-keygen -l -f "$dir/stable.pub")
TEXT
