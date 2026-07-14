# kappastream-bin — AUR submission staging

A ready-to-submit snapshot of the `kappastream-bin` AUR package (the prebuilt
binary variant), staged here so the publish is a copy-paste once you're ready.

Contents:
- `PKGBUILD` — snapshot of `../../PKGBUILD-bin` (the source of truth). If that
  file changes, re-copy it here.
- `.SRCINFO` — hand-written to match; **regenerate before pushing** (see below).

## Before pushing to the AUR

1. **Regenerate `.SRCINFO`** (this one is hand-staged — re-run makepkg to be safe):
   ```
   makepkg --printsrcinfo > .SRCINFO
   ```
2. **Make the GitHub repo public** (or the release asset publicly reachable).
   `source=()` points at a GitHub release URL that `makepkg`/`yay` fetch
   *unauthenticated* — on a private repo it 404s and the install fails. This is
   the real "ready to release" gate.

## Submit

```
git clone ssh://aur@aur.archlinux.org/kappastream-bin.git
cd kappastream-bin
cp /path/to/here/{PKGBUILD,.SRCINFO} .
git add PKGBUILD .SRCINFO
git commit -m "Initial import: kappastream-bin 0.1.0"
git push
```

First push creates the package on the AUR; later pushes update it.

## Known nits to consider before publishing

- `url=` in the PKGBUILD currently resolves to the release-download path, not
  the project homepage. Consider setting
  `url=https://github.com/kappy7777/kappastream` (then regenerate `.SRCINFO`).
