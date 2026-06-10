import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  typedRoutes: true,
};
module.exports = {
  allowedDevOrigins: ['mccui.whosworld.fun','127.0.0.1','192.168.5.129'],
}

export default nextConfig;
