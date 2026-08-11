/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@specd/shared'],
  // `next dev` and `next build` share .next by default, so building while a
  // dev server runs replaces the chunks it is serving mid-flight — the dev
  // server then 500s with "Cannot find module './NNN.js'" until restarted.
  // The build/start scripts set NEXT_DIST_DIR so the two never collide.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  env: {
    NEXT_PUBLIC_API: process.env.NEXT_PUBLIC_API ?? 'http://localhost:4000/api',
  },
};

export default nextConfig;
