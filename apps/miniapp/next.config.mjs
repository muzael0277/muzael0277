/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@bizbot/ui', '@bizbot/shared', '@bizbot/i18n'],
  eslint: { ignoreDuringBuilds: true },
  env: { NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1' },
};
export default nextConfig;
