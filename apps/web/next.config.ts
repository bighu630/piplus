import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  allowedDevOrigins: ['mccui.whosworld.fun', '127.0.0.1', '192.168.5.129', 'localhost'],
  turbopack: {
    resolveAlias: {},
  },
};

export default nextConfig;
