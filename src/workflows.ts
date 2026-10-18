import type { Registry } from "./preflight.js";

/** GitHub Actions versions used in generated workflows. */
export const ACTIONS = {
  checkout: "actions/checkout@v7",
  setupNode: "actions/setup-node@v7",
  setupPython: "actions/setup-python@v7",
  pypiPublish: "pypa/gh-action-pypi-publish@release/v1",
  rustToolchain: "dtolnay/rust-toolchain@stable",
  cratesAuth: "rust-lang/crates-io-auth-action@v1",
} as const;

export const RELEASE_WORKFLOW_FILE = "release.yml";
export const CI_WORKFLOW_FILE = "ci.yml";

const ghReleaseStep = `      - name: Create GitHub release from CHANGELOG
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          VERSION="\${GITHUB_REF_NAME#v}"
          awk -v ver="$VERSION" '
            /^## / { if (found) exit; if (index($0, "[" ver "]") || index($0, " " ver " ") || $0 ~ (" " ver "$")) { found = 1; next } }
            found { print }
          ' CHANGELOG.md > release-notes.md || true
          [ -s release-notes.md ] || echo "Release $GITHUB_REF_NAME" > release-notes.md
          if gh release view "$GITHUB_REF_NAME" > /dev/null 2>&1; then
            echo "Release $GITHUB_REF_NAME already exists; leaving it as is."
          else
            gh release create "$GITHUB_REF_NAME" --title "$GITHUB_REF_NAME" --notes-file release-notes.md --verify-tag
          fi
`;

const tagCheck = (versionExpr: string): string => `      - name: Check the tag matches the manifest version
        run: |
          VERSION=${versionExpr}
          if [ "v$VERSION" != "$GITHUB_REF_NAME" ]; then
            echo "::error::Tag $GITHUB_REF_NAME does not match manifest version $VERSION. Bump the version, commit, and push a new tag."
            exit 1
          fi
`;

const header = (name: string, on: string, permissions: string): string => `name: ${name}

on:
${on}${permissions}`;

const RELEASE_ON = `  push:
    tags: ["v*"]
`;
const RELEASE_PERMISSIONS = `
permissions:
  contents: write # create the GitHub release
  id-token: write # trusted publishing (OIDC), no stored tokens
`;
const CI_ON = `  push:
    branches: ["**"]
  pull_request:
`;
const CI_PERMISSIONS = `
permissions:
  contents: read
`;

export interface CiOptions {
  /**
   * Ubuntu only. For private repos, which pay for Actions minutes: Windows minutes count
   * 2x and macOS minutes 10x, so the full matrix costs about 13 times as much per push.
   */
  lean?: boolean;
}

const LEAN_NOTE = "    # Ubuntu only: this repo is private, and private repos pay for Actions minutes\n    # (Windows counts 2x, macOS 10x). Add windows-latest / macos-latest when you need them.\n";

/** CI workflow: install, lint, build and test on every push and pull request. */
export function ciWorkflow(registry: Registry, options: CiOptions = {}): string {
  const yaml = fullCiWorkflow(registry);
  if (!options.lean) return yaml;
  return yaml.replace(/( +)os: \[ubuntu-latest, windows-latest, macos-latest\]\n/, (_m, indent: string) => `${LEAN_NOTE.replace(/^ {4}/gm, indent)}${indent}os: [ubuntu-latest]\n`);
}

function fullCiWorkflow(registry: Registry): string {
  switch (registry) {
    case "npm":
      return `${header("CI", CI_ON, CI_PERMISSIONS)}
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node: [22, 24]
    runs-on: \${{ matrix.os }}
    steps:
      - uses: ${ACTIONS.checkout}
      - uses: ${ACTIONS.setupNode}
        with:
          node-version: \${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run lint --if-present
      - run: npm run build --if-present
      - run: npm test
`;
    case "pypi":
      return `${header("CI", CI_ON, CI_PERMISSIONS)}
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        python: ["3.11", "3.13", "3.14"]
    runs-on: \${{ matrix.os }}
    steps:
      - uses: ${ACTIONS.checkout}
      - uses: ${ACTIONS.setupPython}
        with:
          python-version: \${{ matrix.python }}
      - run: python -m pip install --upgrade pip
      - run: python -m pip install -e . pytest build
      - run: python -m pytest
      - run: python -m build
`;
    case "crates":
      return `${header("CI", CI_ON, CI_PERMISSIONS)}
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: \${{ matrix.os }}
    steps:
      - uses: ${ACTIONS.checkout}
      - uses: ${ACTIONS.rustToolchain}
        with:
          components: clippy
      - run: cargo clippy --all-targets -- -D warnings
      - run: cargo build
      - run: cargo test
`;
  }
}

/** Release workflow: on v* tags test, build, publish with trusted publishing (skipped if the version exists), then create a GitHub release. */
export function releaseWorkflow(registry: Registry): string {
  switch (registry) {
    case "npm":
      return `${header("Release", RELEASE_ON, RELEASE_PERMISSIONS)}
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: ${ACTIONS.checkout}
      - uses: ${ACTIONS.setupNode}
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm run build --if-present
      - run: npm test
${tagCheck(`$(node -p "require('./package.json').version")`)}      - name: Check whether this version is already on npm
        id: registry
        run: |
          NAME=$(node -p "require('./package.json').name")
          VERSION=$(node -p "require('./package.json').version")
          if npm view "$NAME@$VERSION" version > /dev/null 2>&1; then
            echo "exists=true" >> "$GITHUB_OUTPUT"
            echo "$NAME@$VERSION is already on npm; skipping publish."
          else
            echo "exists=false" >> "$GITHUB_OUTPUT"
          fi
      - name: Publish to npm (trusted publishing)
        if: steps.registry.outputs.exists == 'false'
        run: npm publish --access public
${ghReleaseStep}`;
    case "pypi":
      return `${header("Release", RELEASE_ON, RELEASE_PERMISSIONS)}
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: ${ACTIONS.checkout}
      - uses: ${ACTIONS.setupPython}
        with:
          python-version: "3.13"
      - run: python -m pip install --upgrade pip build pytest
      - run: python -m pip install -e .
      - run: python -m pytest
      - run: python -m build
${tagCheck(`$(python -c "import tomllib;print(tomllib.load(open('pyproject.toml','rb'))['project']['version'])")`)}      - name: Check whether this version is already on PyPI
        id: registry
        run: |
          NAME=$(python -c "import tomllib;print(tomllib.load(open('pyproject.toml','rb'))['project']['name'])")
          VERSION="\${GITHUB_REF_NAME#v}"
          if curl -sf "https://pypi.org/pypi/$NAME/$VERSION/json" > /dev/null; then
            echo "exists=true" >> "$GITHUB_OUTPUT"
            echo "$NAME $VERSION is already on PyPI; skipping publish."
          else
            echo "exists=false" >> "$GITHUB_OUTPUT"
          fi
      - name: Publish to PyPI (trusted publishing)
        if: steps.registry.outputs.exists == 'false'
        uses: ${ACTIONS.pypiPublish}
        with:
          skip-existing: true
${ghReleaseStep}`;
    case "crates":
      return `${header("Release", RELEASE_ON, RELEASE_PERMISSIONS)}
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: ${ACTIONS.checkout}
      - uses: ${ACTIONS.rustToolchain}
      - run: cargo test
      - run: cargo build --release
${tagCheck(`$(cargo metadata --no-deps --format-version 1 | python3 -c "import json,sys;print(json.load(sys.stdin)['packages'][0]['version'])")`)}      - name: Check whether this version is already on crates.io
        id: registry
        run: |
          NAME=$(cargo metadata --no-deps --format-version 1 | python3 -c "import json,sys;print(json.load(sys.stdin)['packages'][0]['name'])")
          VERSION="\${GITHUB_REF_NAME#v}"
          if curl -sf -A "release-workflow (github.com/\${{ github.repository }})" "https://crates.io/api/v1/crates/$NAME/$VERSION" > /dev/null; then
            echo "exists=true" >> "$GITHUB_OUTPUT"
            echo "$NAME $VERSION is already on crates.io; skipping publish."
          else
            echo "exists=false" >> "$GITHUB_OUTPUT"
          fi
      - name: Get a short-lived crates.io token (trusted publishing)
        if: steps.registry.outputs.exists == 'false'
        id: auth
        uses: ${ACTIONS.cratesAuth}
      - name: Publish to crates.io
        if: steps.registry.outputs.exists == 'false'
        run: cargo publish
        env:
          CARGO_REGISTRY_TOKEN: \${{ steps.auth.outputs.token }}
${ghReleaseStep}`;
  }
}

/** Release workflow for repo-only projects: just a GitHub release from the CHANGELOG. */
export function repoOnlyReleaseWorkflow(): string {
  return `${header("Release", RELEASE_ON, `
permissions:
  contents: write
`)}
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: ${ACTIONS.checkout}
${ghReleaseStep}`;
}
