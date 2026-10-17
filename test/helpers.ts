import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "pp-test-"));

/** Build fake tokens at runtime so no secret-looking literal is ever committed. */
export const fake = (prefix: string, length = 36): string => prefix + "a1B2c3D4e5".repeat(Math.ceil(length / 10)).slice(0, length);
