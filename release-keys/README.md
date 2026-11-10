# Release keys

The public keys of the release signatures go here as `stable.pub` and `dev.pub`, and ship in every server tarball (`docs/RELEASES.md`, "Release keys"). `sh scripts/gen-release-keys.sh` creates the key pairs. Only files ending in `.pub` are included in a tarball. Both keys are in place: `stable.pub` (fingerprint `SHA256:4yszmEKSSoX49kfCJkTRP6CYIaqWhU/KUMqrL55nXb0`) and `dev.pub` (fingerprint `SHA256:ogXw2Hs1dsFjNhFXSWNYTm7maKOFI5XAh7Lxq1oCSkU`). No release has been signed yet.
