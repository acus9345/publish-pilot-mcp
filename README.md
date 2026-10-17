# publish-pilot-mcp

An MCP server that lets Claude take a project from an empty folder to a published GitHub repo and npm, PyPI or crates.io package. It checks your tools, handles logins, scaffolds the project, runs checks, publishes and releases. You only do the sign-in, 2FA and approval clicks.

[![npm](https://img.shields.io/npm/v/publish-pilot-mcp)](https://www.npmjs.com/package/publish-pilot-mcp)
[![CI](https://github.com/acus9345/publish-pilot-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/acus9345/publish-pilot-mcp/actions/workflows/ci.yml)

## Install

You need [Node.js](https://nodejs.org) 22 or newer. The server runs with `npx`, so there is nothing else to install.

**Claude Code**

```sh
claude mcp add publish-pilot -- npx -y publish-pilot-mcp
```

**Claude Desktop**: add this to `claude_desktop_config.json` (on Windows it is in `%APPDATA%\Claude\`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "publish-pilot": {
      "command": "npx",
      "args": ["-y", "publish-pilot-mcp"]
    }
  }
}
```

Any other MCP client: run `npx -y publish-pilot-mcp` as a stdio server.

## Quick start

1. Check that your machine is ready:

   ```sh
   npx -y publish-pilot-mcp doctor both npm
   ```

   This lists the tools that are installed or missing (git, gh, node/npm) and whether you are logged in to GitHub and npm.

2. Open an empty folder in Claude and say:

   > Use the publish_project prompt. Make an npm package called my-tool that converts CSV to JSON, and publish it to both GitHub and npm.

   In Claude Code you can also type `/mcp__publish-pilot__publish_project`.

Claude then works through the plan: preflight, scaffold, code and tests, quality checks, dry run, commit, GitHub repo, publish, trusted publishing, tag, release and a final install test. When it needs you, it sends a desktop notification and opens the right page: a GitHub device-code login, the npm login, or the npm publish approval.

## What you have to do yourself

The server never types passwords or 2FA codes and never clicks Authorize, Approve or Save. Expect to:

- Sign in to GitHub and click **Authorize** (only if `gh` is not logged in yet).
- Sign in to npm (only if `npm whoami` fails).
- Approve the first `npm publish` on npmjs.com (2FA).
- Approve the trusted-publisher link (`npm trust github`) with 2FA. If you prefer the website, open the package's **Settings → Trusted Publisher** page and fill in the values Claude gives you.

npm only shows its approval link in a real terminal. So on Windows these npm steps run in a visible PowerShell window: if it says "Press ENTER to open in the browser", press Enter there and approve. On macOS and Linux they run under `script`, which gives npm a terminal, and the page opens in your browser.

npm can only add a trusted publisher to a package that already exists, so a brand-new package is published once from your machine and every later version from GitHub Actions.

After that, every release is a pushed `v*` tag. GitHub Actions publishes with OIDC, so no tokens are stored anywhere.

## Tools

| Tool | What it does |
| --- | --- |
| `preflight` | Checks git, gh, the registry CLI, your logins and your git identity. Starts no logins. |
| `install_tool` | Installs a missing tool with winget (Windows), brew (macOS) or apt (Linux). |
| `check_names` | Checks that the package and repo names are valid and free, and picks the best free alternative (for npm, `@you/name`). |
| `login` | Starts a browser login (`gh auth login --web`, `npm login --auth-type=web`) and returns the one-time code and URL. |
| `job_status` | Polls a running login or publish job: status, output, URLs and codes. |
| `scaffold_project` | Creates source, tests, README, LICENSE, CHANGELOG, .gitignore, manifest and workflows. Never overwrites files. |
| `add_workflows` | Writes `ci.yml` and a `release.yml` that uses trusted publishing (OIDC), skips versions that already exist and creates a GitHub release from the CHANGELOG. |
| `run_checks` | Install, lint, typecheck, build and test (npm scripts, a Python `.venv` with pytest, or cargo). |
| `scan_secrets` | Finds `.env` files, private keys and tokens that would be committed. |
| `inspect_package` | Runs the publish dry run and lists the files that would ship, flagging junk and secrets. |
| `git_commit` | Runs `git init -b main` if needed and commits. Refuses if secrets would be committed. |
| `create_github_repo` | Runs `gh repo create <name> --public/--private --source . --push`. |
| `publish_package` | Runs `npm publish`, `twine upload` or `cargo publish`, opens the approval page, and skips versions that already exist. |
| `setup_trusted_publishing` | Connects the package to `release.yml` (`npm trust github`, or the PyPI/crates.io settings page with the exact values). |
| `tag_and_release` | Tags `v<version>`, pushes it, and optionally creates the GitHub release from the CHANGELOG. |
| `watch_workflow` | Waits for the release run and returns the failing log if it fails. |
| `bump_version` | Bumps the patch, minor or major version and adds a CHANGELOG entry. |
| `verify_install` | Installs from the real registry (or clones the repo) into a new temp folder and runs your quick start. |
| `notify` / `open_url` | Desktop notification, and opening a page on github.com, npmjs.com, pypi.org or crates.io. |
| `run_command` | Runs a command in PowerShell (Windows) or sh. Destructive commands are refused. |

The `publish_project` prompt takes optional `target`, `name`, `description`, `registry`, `visibility`, `license`, `what` and `dir` arguments. Anything you leave out, Claude asks for before it starts.

## Safety

- All command output is scanned, and tokens (GitHub, npm, PyPI, crates.io, AWS and others) are replaced with `***` before Claude sees them.
- Commits and publishes are blocked when `.env` files, private keys or tokens would be included.
- It never deletes, force-pushes or unpublishes anything, tags included. Failed releases are fixed with a new patch version instead. `run_command` refuses force-push, tag/repo/release deletion, `npm unpublish`, `cargo yank`, logout/token commands and recursive deletes.
- It only opens `https://` pages on github.com, npmjs.com, pypi.org and crates.io.

## Use as a library

```js
import { createServer } from "publish-pilot-mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

await createServer().connect(new StdioServerTransport());
```

`preflight`, `scaffoldProject`, `releaseWorkflow`, `scanProject`, `checkPackageName` and other helpers are exported too, with TypeScript types.

## Build from source

```sh
git clone https://github.com/acus9345/publish-pilot-mcp.git
cd publish-pilot-mcp
npm install
npm test
node dist/cli.js --help
```

## Troubleshooting

- **`doctor` says a tool is MISSING**: ask Claude to run `install_tool`, or install it yourself (for example `winget install --id GitHub.cli -e`). Then restart your MCP client so it picks up the new PATH.
- **Claude Desktop on Windows can't start the server**: use `"command": "cmd", "args": ["/c", "npx", "-y", "publish-pilot-mcp"]` and restart Claude Desktop.
- **`npm publish` fails with E429 `rate limited exceeded`**: npm limits how many packages and versions one account (or connection) can publish in about a day, and it doesn't say what the limit is. Nothing was published. Wait a few hours and try once. Retrying every few minutes can keep the limit active.
- **The npm approval link expired**: ask Claude to call `publish_package` again. Each call opens a fresh link, and versions that are already published are skipped.
- **The release workflow says the tag doesn't match the version**: the `v*` tag must equal the manifest version. Ask Claude to `bump_version`, commit, and tag the new version. Old tags are never moved.
- **`npm publish` from Actions fails with 404 or 401**: trusted publishing isn't set up for this repo and `release.yml` yet. Run `setup_trusted_publishing` (the package must already exist on npm).

## License

[MIT](LICENSE)
