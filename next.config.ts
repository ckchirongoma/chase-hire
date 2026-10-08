import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prompt files are read at runtime; make sure Vercel bundles them with the CV route.
  outputFileTracingIncludes: {
    "/api/cv/process": ["./prompts/**/*"],
  },
  serverExternalPackages: ["pdf-parse", "mammoth"],
  experimental: {
    serverActions: { bodySizeLimit: "1mb" },
  },
};

export default nextConfig;
