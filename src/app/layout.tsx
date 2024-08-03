// app/layout.tsx
import './globals.css';
import Link from 'next/link';
import { ReactNode } from 'react';

const navItems = [
  { href: '/', label: 'Deployments' },
  { href: '/create-deployment', label: 'Create Deployment' },
  { href: '/settings', label: 'Settings' },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-900 text-white">
        <div className="flex h-screen">
          {/* Sidebar */}
          <div className="w-64 bg-gray-800 p-4">
            <h1 className="text-2xl font-bold mb-8">Akash Dashboard</h1>
            <nav>
              {navItems.map((item) => (
                <Link key={item.href} href={item.href}>
                  <div className="mb-2 p-2 rounded text-gray-300 hover:bg-gray-700 transition-colors">
                    {item.label}
                  </div>
                </Link>
              ))}
            </nav>
          </div>
          {/* Main content */}
          <div className="flex-1 overflow-auto">
            <main className="p-8">
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}