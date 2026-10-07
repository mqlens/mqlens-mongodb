# Verify MQLens downloads

Every release asset is shipped with a detached GPG signature (`.asc`), and the
macOS bundles are also Apple-notarized. To verify a download:

```bash
# Import the MQLens release public key (once):
gpg --import KEYS          # from this repo, or: curl -L https://mqlens.com/KEYS | gpg --import

# Verify an asset against its .asc:
gpg --verify MQLens_0.1.0_amd64.deb.asc MQLens_0.1.0_amd64.deb
```

Signing key — **MQLens Releases `<dev@mqlens.com>`**, fingerprint:

```
8E10 C09D 1FEC 8C8F 90B1  DB7E 5804 6649 06E7 D373
```


Download the current artifacts from [GitHub releases](https://github.com/mqlens/mqlens-mongodb/releases/latest) and substitute their exact filenames in the verification command.
