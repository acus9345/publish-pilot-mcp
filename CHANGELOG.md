# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- PyPI and crates.io publishes now get the same 24-hour wait after a rate limit (429) as npm, instead of retrying into the block.
- `publish_package` and `inspect_package` for PyPI use only the current version's files in `dist/`. Older builds left there after `bump_version` made `twine upload` fail with "File already exists".
- `publish_package` with `dryRun` for PyPI runs `twine check` instead of uploading to TestPyPI.
- `inspect_package` for PyPI now scans the sdist's files for secrets and junk; it skipped the scan before.
- `setup_trusted_publishing` waits while npm is still processing a brand-new package (only the `0.0.0-stage` placeholder is listed), and `publish_package` says the first version can take a minute or two to appear.
- `create_github_repo` reuses the user's own empty repo when an earlier create was interrupted after GitHub made the repo but before the push, instead of asking for a new name.
- `verify_install` and `run_command` on Windows: `a && b` commands failed to parse in Windows PowerShell 5.1. They now run in PowerShell 7 (`pwsh`) when it is installed, and `&&` is rewritten for 5.1 otherwise.
- Garbled error text on non-English Windows (for example Chinese (Hong Kong), code page 950): output that isn't UTF-8 is decoded with the console code page, and PowerShell is asked to write UTF-8.
- Tool results with `ok: false` (a failed `verify_install`, `run_checks`, `git_commit`, push or tag) are now flagged as errors, so they aren't mistaken for success.
- Step output in `run_checks`, `inspect_package` and other tools keeps stdout and stderr in the order the command wrote them, instead of putting all of stderr (such as npm's notices) after the test results.

### Changed

- New npm projects from `scaffold_project` get a `typecheck` script (`tsc --noEmit`), so `run_checks` runs it instead of skipping it.

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
