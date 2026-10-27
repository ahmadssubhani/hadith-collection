import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: "/hadiths/first-revelation-at-hira",
        destination: "/published-clusters/first-wahi",
        permanent: true,
      },
      {
        source: "/hadiths/first-wahi",
        destination: "/published-clusters/first-wahi",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
