export default function Loading() {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <div className="flex flex-col items-center gap-4">
        <img src="/3d/segment.png" alt="" className="h-20 w-20 animate-[spin_1.6s_cubic-bezier(.6,0,.4,1)_infinite]" />
        <p className="text-[15px] text-dim">Loading…</p>
      </div>
    </div>
  );
}
