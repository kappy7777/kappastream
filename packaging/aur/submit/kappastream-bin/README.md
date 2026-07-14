# kappastream-bin — AUR submission staging

A ready-to-submit snapshot of the `kappastream-bin` AUR package (the prebuilt
binary variant), staged here so the publish is a copy-paste once you're ready.

Contents:
- `PKGBUILD` — snapshot of `../../PKGBUILD-bin` (the source of truth). If that
  file changes, re-copy it here.
- `.SRCINFO` — **regenerate before pushing** (see below).

## Before pushing to the AUR

1. **Regenerate `.SRCINFO`** (re-run makepkg to be safe):
   ```
   makepkg --printsrcinfo > .SRCINFO
   ```

## Submit

```
git clone ssh://aur@aur.archlinux.org/kappastream-bin.git
cd kappastream-bin
cp /path/to/here/{PKGBUILD,.SRCINFO} .
git add PKGBUILD .SRCINFO
git commit -m "Initial import: kappastream-bin 0.1.2"
git push
```

First push creates the package on the AUR; later pushes update it.
