# Releasing

Release Please maintains the release PR, version files, changelog, Git tag, and
GitHub release. npm publication is not configured.

## Release flow

1. Merge changes into `main` using Conventional Commit titles, such as `fix: ...`
   or `feat: ...`.
2. After the `prek` job passes, the `release-please` job in
   `.github/workflows/ci.yaml` opens or updates the release PR.
3. Review that PR's version and changelog, and wait for its CI to pass.
4. Merge the release PR. Once prek passes on that main push, Release Please
   creates `vX.Y.Z` and the matching GitHub release.

The release job runs only on pushes to `main`. Runs are serialized without
cancelling an in-progress release job. Write permissions are scoped to that job;
pull-request checks use read-only permissions.

## Initial version and later releases

The package is currently an unreleased `0.1.0`. The empty
`.github/release-please/manifest.json` records that no release has been made, and
`initial-version` in `.github/release-please/config.json` sets the first release
to `0.1.0`. The first changelog includes the repository's existing Conventional
Commits.

Release Please writes the released version into the manifest and updates
`package.json`, `package-lock.json`, and `CHANGELOG.md` through its release PR.
Do not manually bump those files to prepare a release. The initial-version setting
only applies before the first release; later versions follow Conventional Commits.
Fixes increment the patch version and features increment the minor version.
With `bump-minor-pre-major` enabled, breaking changes also increment the minor
version while the package is below `1.0.0`.

## Release credential

The job uses the repository secret `RELEASE_PLEASE_CI`. It holds the shared
fine-grained PAT authorized for `dotfiles`, `opencode-sidequest`, and
`opencode-pillbox-statusline`, so release PRs can trigger their own CI.

Keep the token's repository selection and write access to Contents, Issues, and
Pull requests when rotating it. Replace `RELEASE_PLEASE_CI` in all three
repositories when the shared token is rotated or expires. Keep its value out of
repository files and logs.
