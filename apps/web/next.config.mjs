/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@bizbot/ui', '@bizbot/shared', '@bizbot/rbac'],
  eslint: { ignoreDuringBuilds: true },
  env: { NEXT_PUBLIC_ADMIN_URL: process.env.NEXT_PUBLIC_ADMIN_URL ?? 'http://localhost:3001' },
};
export default nextConfig;
