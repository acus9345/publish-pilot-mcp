import { describe, expect, it } from "vitest";
import { checkCommand, isAllowedUrl } from "../src/guard.js";

describe("checkCommand", () => {
  it.each([
    "git push --force origin main",
    "git push -f",
    "git push origin --delete v0.1.0",
    "git push origin :v0.1.0",
    "git tag -d v0.1.0",
    "npm unpublish my-pkg@0.1.0",
    "gh repo delete owner/repo --yes",
    "gh release delete v1.0.0",
    "gh auth token",
    "cargo yank --version 0.1.0",
    "rm -rf /",
    "Remove-Item -Recurse -Force C:\\stuff",
  ])("refuses %s", (command) => {
    expect(checkCommand(command)).toMatch(/Refused/);
  });

  it.each(["git push origin main", "git push origin v0.1.0", "npm publish --access public", "gh repo create x --public --source . --push", "npm test", ""])(
    "allows %s",
    (command) => {
      expect(checkCommand(command)).toBeNull();
    },
  );
});

describe("isAllowedUrl", () => {
  it.each(["https://github.com/login/device", "https://www.npmjs.com/auth/cli/abc", "https://pypi.org/manage/account/publishing/", "https://crates.io/settings/tokens"])(
    "allows %s",
    (url) => expect(isAllowedUrl(url)).toBe(true),
  );

  it.each(["http://github.com", "https://github.com.evil.example", "https://evilgithub.com", "javascript:alert(1)", "not a url", ""])("refuses %s", (url) =>
    expect(isAllowedUrl(url)).toBe(false),
  );
});
