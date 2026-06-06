import { config } from "dotenv";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(workerRoot, "../..");

config({ path: resolve(repoRoot, ".env") });
config({ path: resolve(workerRoot, ".env") });
