# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-10-18

Found by using publish-pilot to create a private repo end to end.

### Added

- `scaffold_project` `target` option. Repo-only projects get a clone-and-build README and a manifest that blocks registry publishing (`"private": true` for npm, `publish = false` for Rust, the `Private :: Do Not Upload` classifier for PyPI).
- `private` option for `scaffold_project` and `add_workflows`: CI runs on Ubuntu only, because private repos pay for Actions minutes and Windows/macOS minutes count 2×/10×. `create_github_repo` warns when a private repo's CI would use them.

### Fixed

- `verify_install` takes a list of commands and stops at the first that fails. A single PowerShell line joined with `;` reported success whenever the last command passed, even when an earlier one failed.
- `tag_and_release` no longer creates the GitHub release itself when `release.yml` already creates it on the tag.
- `watch_workflow`'s description now says it matches the current commit.

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
