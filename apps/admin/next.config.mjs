/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The UI package is consumed as TypeScript source rather than a build artifact, so a
  // token change shows up without a rebuild step in between.
  transpilePackages: ['@bizbot/ui', '@bizbot/shared', '@bizbot/rbac', '@bizbot/i18n', '@bizbot/contracts'],
  eslint: { ignoreDuringBuilds: true },
  env: { NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1' },
};
export default nextConfig;
