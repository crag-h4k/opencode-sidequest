# Releasing

Release Please maintains the release PR, version files, changelog, Git tag, and
GitHub release. Version `0.1.0` is published on npm. The OIDC publish job is
implemented but remains disabled until trusted-publisher setup is complete.
Once enabled, a maintainer approves each staged version with 2FA before it goes live.

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

The first release is `0.1.0`, recorded in
`.github/release-please/manifest.json`. The `initial-version` setting in
`.github/release-please/config.json` controlled that bootstrap release.

Release Please writes the released version into the manifest and updates
`package.json`, `package-lock.json`, and `CHANGELOG.md` through its release PR.
Do not manually bump those files to prepare a release. The initial-version setting
only applies before the first release; later versions follow Conventional Commits.
Fixes increment the patch version and features increment the minor version.
With `bump-minor-pre-major` enabled, breaking changes also increment the minor
version while the package is below `1.0.0`.

## First npm release

Version `0.1.0` was published from the `v0.1.0` tag after typechecking, tests,
tarball inspection, and an isolated OpenCode load check. This initial publication
used maintainer authentication and has no CI provenance.

The package name is `opencode-sidequest`; its public repository is
`crag-h4k/opencode-sidequest`. Keep `NPM_TRUSTED_PUBLISHING` unset until the
trusted publisher is configured for the next release.

## Trusted publishing

Configure the package's trusted publisher on npmjs.com just before the next
release. A new configuration expires unless it completes its first successful
publish within two days.

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `crag-h4k` |
| Repository | `opencode-sidequest` |
| Workflow filename | `ci.yaml` |
| Environment | `npm` |
| Allowed actions | Staged publishing only |

Set the npm package's publishing access to require 2FA and disallow tokens, then
set the GitHub repository variable `NPM_TRUSTED_PUBLISHING` to `true`.

The publish job runs on a GitHub-hosted runner, checks out the release tag,
installs from the lockfile without caches, typechecks, tests, and runs
`npm stage publish`. Keep it in `ci.yaml`, which is the workflow filename registered
with npm. OIDC supplies authentication; no npm token is needed in GitHub secrets.
Public releases through this workflow receive npm provenance automatically.

After merging each later release PR, wait for the main-push CI run's
`Stage on npm` job. Review and approve the version in npm's Staged Packages tab
using 2FA. The GitHub release alone does not mean the package is live on npm.

## Release credential

The job uses the repository secret `RELEASE_PLEASE_CI`. It holds the shared
fine-grained PAT authorized for `dotfiles`, `opencode-sidequest`, and
`opencode-pillbox-statusline`, so release PRs can trigger their own CI.

Keep the token's repository selection and write access to Contents, Issues, and
Pull requests when rotating it. Replace `RELEASE_PLEASE_CI` in all three
repositories when the shared token is rotated or expires. Keep its value out of
repository files and logs.
