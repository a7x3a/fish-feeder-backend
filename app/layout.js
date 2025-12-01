// Minimal root layout for Next.js App Router
// This project only uses API routes, no pages
export default function RootLayout({ children }) {
  return children || null;
}

export const metadata = {
  title: 'FishFeeder API',
  description: 'API routes only - no pages',
};

