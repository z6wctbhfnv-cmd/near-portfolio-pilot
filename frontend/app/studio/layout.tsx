import { notFound } from "next/navigation";

// The 3D studio is a design tool for re-rendering public/3d/*.png; it is not part of the public site.
export default function StudioLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === "production") notFound();
  return children;
}
