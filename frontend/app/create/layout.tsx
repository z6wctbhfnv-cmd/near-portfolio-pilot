import type { Metadata } from "next";

export const metadata: Metadata = { title: "write a script" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
