// Dev-only: the /studio page posts rendered 3D objects here to save them as PNGs in public/3d.
import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function POST(req: Request) {
  if (process.env.NODE_ENV !== "development") return new Response("off", { status: 404 });
  const { name, data } = (await req.json()) as { name: string; data: string };
  if (!/^[a-z0-9-]+$/.test(name)) return new Response("bad name", { status: 400 });
  const buf = Buffer.from(data.replace(/^data:image\/png;base64,/, ""), "base64");
  await writeFile(path.join(process.cwd(), "public", "3d", `${name}.png`), buf);
  return Response.json({ ok: true, bytes: buf.length });
}
