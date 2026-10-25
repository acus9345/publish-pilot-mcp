# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

Fewer tokens per tool call, and faster checks.

### Changed

- The tool list the model reads on every turn is about half the size (about 2,400 tokens instead of 4,700): shorter descriptions, no titles, and no JSON Schema dialect URL or default task setting on each tool.
- Results are about 60% smaller on a typical publish. Successful steps report a one-line summary instead of their whole output, npm's `npm notice` chatter is dropped, `preflight` returns versions and account names (with next steps only when something is missing), `check_names` lists taken names instead of one record per name, `watch_workflow` returns only status, conclusion, ref and URL, and failed workflow logs lose their job, step and timestamp columns.
- `run_checks` skips the install when `node_modules` is newer than `package.json` and the lockfile, runs lint and typecheck at the same time, and skips the separate build when the test script already builds (about 3 s to 1.4 s on a small project). It also scans for secrets first.
- `inspect_package` gets the file list from `npm publish --dry-run --json`, so the project builds once instead of twice, and says plainly when the version is already on npm.
- `verify_install` writes the temp `package.json` itself instead of starting `npm init`.
- README: an optional global install that starts in about 0.2 s instead of about 0.9 s with `npx`.

### Removed

- `scan_secrets`: `run_checks`, `git_commit` and `inspect_package` already scan.
- `open_url`: use `notify` with `url`.

## [0.3.0] - 2026-10-19

### Changed

- Faster. `preflight` checks tools, logins and the git identity all at once, and remembers found tools (10 minutes) and logged-in accounts (5 minutes), so later calls take about 30 ms instead of about 1.1 s. A missing tool or a logged-out account is checked again on every call, and `login` always checks for real.
- `check_names` takes about 1 s instead of about 3.5 s. One GitHub GraphQL request returns your login and checks every repo name, the package and repo checks run at the same time, and alternatives are checked in parallel only when the requested name is taken.
- Registry lookups use `HEAD` requests, so checking a popular name like `react` no longer downloads its 7 MB package record.
- `tag_and_release` pushes the branch and the tag in one atomic push, so the tag never arrives without its commit.
- `watch_workflow` checks a running workflow every 5 seconds instead of 10.
- Tool results are compact JSON, which is about 30% fewer tokens for the model to read.

## [0.2.0] - 2026-10-18

Found by using publish-pilot to create a private repo end to end.

### Added

- `scaffold_project` `target` option. Repo-only projects get a clone-and-build README and a manifest that blocks registry publishing (`"private": true` for npm, `publish = false` for Rust, the `Private :: Do Not Upload` classifier for PyPI).
- `private` option for `scaffold_project` and `add_workflows`: CI runs on Ubuntu only, because private repos pay for Actions minutes and Windows/macOS minutes count 2×/10×. `create_github_repo` warns when a private repo's CI would use them.

### Fixed

- `verify_install` takes a list of commands and stops at the first that fails. A single PowerShell line joined with `;` reported success whenever the last command passed, even when an earlier one failed.
- `tag_and_release` no longer creates the GitHub release itself when `release.yml` already creates it on the tag.
- `watch_workflow`'s description now says it matches the current commit.
- `watch_workflow` and `job_status` cap each wait at 45 seconds and say to call again. A long wait (for example 480 s) was cancelled by MCP clients that time out tool calls after 60 seconds. Long-running tools also send progress notifications every 15 seconds when the client asks for them.

## [0.1.1] - 2026-10-18

### Fixed

- README and `--help`: Windows install now uses `cmd /c npx`, because MCP clients can't start the `npx.cmd` shim directly (`ENOENT`/`EINVAL`). Claude Desktop's config is opened with Settings → Developer → Edit Config, since its location differs between installs.
- `bump_version` without notes now turns the CHANGELOG's "Unreleased" section into the new version instead of adding a separate "Maintenance release" entry.

## [0.1.0] - 2026-10-17

### Added

- MCP server with 21 tools covering the whole path from an empty folder to a published release: `preflight`, `install_tool`, `check_names`, `login`, `job_status`, `scaffold_project`, `add_workflows`, `run_checks`, `scan_secrets`, `inspect_package`, `git_commit`, `create_github_repo`, `publish_package`, `setup_trusted_publishing`, `tag_and_release`, `watch_workflow`, `bump_version`, `verify_install`, `notify`, `open_url` and `run_command`.
- `publish_project` prompt with the full step-by-step release plan.
- Support for npm, PyPI and crates.io, with GitHub Actions CI and tag-triggered release workflows that use trusted publishing (OIDC) and skip versions that already exist.
- Safety rails: token redaction on all output, secret scanning before commits and publishes, refusal of destructive commands, and browser pages limited to github.com, npmjs.com, pypi.org and crates.io.
- `publish-pilot-mcp` CLI with `--help`, `--version` and `doctor`.
- npm login, publish and trust steps run in a real terminal (a visible PowerShell window on Windows, a Terminal window on macOS, `script` on Linux), because npm only shows its 2FA approval link there.
- `job_status` explains rate limits (E429), versions that already exist, rejected names and expired approval links.
- After an E429, `publish_package` waits 24 hours before trying again (unless forced), because every failed attempt can extend npm's block.
