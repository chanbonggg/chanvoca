import type { NextConfig } from "next";

// API forwarding lives in app/api/[...path] so upstream failures are observable.
const nextConfig: NextConfig = { experimental: { serverSourceMaps: true } };
export default nextConfig;
