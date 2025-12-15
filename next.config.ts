import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ✅ Keep React Compiler enabled
  reactCompiler: true,

  // 🔁 Legacy Vite HTML → Next routes (permanent, SEO-safe)
  async redirects() {
    return [
      {
        source: "/sign.html",
        destination: "/sign",
        permanent: true,
      },
      {
        source: "/verify.html",
        destination: "/verify",
        permanent: true,
      },
      {
        source: "/certificate.html",
        destination: "/certificate",
        permanent: true,
      },

      // Extra safety for any historical paths
      {
        source: "/public/sign.html",
        destination: "/sign",
        permanent: true,
      },
      {
        source: "/public/verify.html",
        destination: "/verify",
        permanent: true,
      },
      {
        source: "/public/certificate.html",
        destination: "/certificate",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
