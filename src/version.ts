import { createRequire } from "node:module";

/** The package version, read from package.json so it never drifts. */
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
