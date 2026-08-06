/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@specd/shared'],
  env: {
    NEXT_PUBLIC_API: process.env.NEXT_PUBLIC_API ?? 'http://localhost:4000/api',
  },
};

export default nextConfig;
