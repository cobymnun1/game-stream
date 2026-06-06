import { config } from "dotenv";
import { resolve } from "path";
import type { NextConfig } from "next";

config({ path: resolve(__dirname, "../../.env") });
config({ path: resolve(__dirname, ".env.local") });

const nextConfig: NextConfig = {
  transpilePackages: ["@game-stream/shared"],
};

export default nextConfig;
