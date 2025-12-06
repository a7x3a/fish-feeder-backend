// Root layout for Next.js App Router
// This project uses API routes only, but layout is required by Next.js
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children || null}
      </body>
    </html>
  );
}

export const metadata = {
  title: 'FishFeeder API',
  description: 'API routes only - no pages',
};
