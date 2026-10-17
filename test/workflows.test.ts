import { describe, expect, it } from "vitest";
import { ciWorkflow, releaseWorkflow, repoOnlyReleaseWorkflow } from "../src/workflows.js";

const registries = ["npm", "pypi", "crates"] as const;

describe("workflows", () => {
  it.each(registries)("%s CI runs on push and pull_request", (registry) => {
    const yaml = ciWorkflow(registry);
    expect(yaml).toContain("push:");
    expect(yaml).toContain("pull_request:");
    expect(yaml).toContain("windows-latest");
    expect(yaml).not.toContain("\t");
  });

  it.each(registries)("%s release uses OIDC, skips existing versions and creates a release", (registry) => {
    const yaml = releaseWorkflow(registry);
    expect(yaml).toContain('tags: ["v*"]');
    expect(yaml).toContain("id-token: write");
    expect(yaml).toContain("steps.registry.outputs.exists == 'false'");
    expect(yaml).toContain("gh release create");
    expect(yaml).not.toMatch(/secrets\.(NPM_TOKEN|PYPI|CARGO)/);
    expect(yaml).not.toContain("\t");
  });

  it("repo-only release just creates a GitHub release", () => {
    const yaml = repoOnlyReleaseWorkflow();
    expect(yaml).toContain("gh release create");
    expect(yaml).not.toContain("id-token");
  });
});
