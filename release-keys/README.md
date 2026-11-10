# Release keys

The public keys of the release signatures go here as `stable.pub` and `dev.pub`, and ship in every server tarball (`docs/RELEASES.md`, "Release keys"). `sh scripts/gen-release-keys.sh` creates the key pairs. Only files ending in `.pub` are included in a tarball. No key has been added yet, so no release has been signed.
