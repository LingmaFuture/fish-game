import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '开一局 · 和朋友一起玩',
  description: '无需注册，输入昵称，邀请朋友来一局成语炸弹。',
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
