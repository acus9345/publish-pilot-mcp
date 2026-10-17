# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-17

### Added

- MCP server with 21 tools covering the whole path from an empty folder to a published release: `preflight`, `install_tool`, `check_names`, `login`, `job_status`, `scaffold_project`, `add_workflows`, `run_checks`, `scan_secrets`, `inspect_package`, `git_commit`, `create_github_repo`, `publish_package`, `setup_trusted_publishing`, `tag_and_release`, `watch_workflow`, `bump_version`, `verify_install`, `notify`, `open_url` and `run_command`.
- `publish_project` prompt with the full step-by-step release plan.
- Support for npm, PyPI and crates.io, with GitHub Actions CI and tag-triggered release workflows that use trusted publishing (OIDC) and skip versions that already exist.
- Safety rails: token redaction on all output, secret scanning before commits and publishes, refusal of destructive commands, and browser pages limited to github.com, npmjs.com, pypi.org and crates.io.
- `publish-pilot-mcp` CLI with `--help`, `--version` and `doctor`.
