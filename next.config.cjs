/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next.js 14 configuration - API routes only
  // This project uses Next.js only for API routes, not pages
  
  // Use standalone output for serverless functions
  output: 'standalone',
  
  // Disable static page generation
  outputFileTracingRoot: process.cwd(),
  
  // Skip page generation - API routes only
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
      };
    }
    // Add path alias for lib imports
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': require('path').resolve(__dirname),
    };
    return config;
  },
  
  // Only trace API routes, exclude everything else
  experimental: {
    outputFileTracingIncludes: {
      '/api/**': ['./app/api/**'],
    },
    outputFileTracingExcludes: {
      '*': [
        '*.md',
        '*.json',
        'node_modules/**',
      ],
    },
  },
};

module.exports = nextConfig;

