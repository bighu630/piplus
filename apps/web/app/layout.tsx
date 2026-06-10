import type { ReactNode } from 'react';
import './globals.css';
import { QueryProvider } from '../src/providers/query-provider';

export const metadata = {
  title: 'piplus workspace',
  description: 'A warm, role-driven project and session workbench',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
