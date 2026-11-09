// Small SVG charts, no library. Line chart with hover readout; sparkline.
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

const money = (v) => "$" + Math.round(v).toLocaleString("en-US");
const day = (ts) => new Date(ts).toISOString().slice(0, 10);

/**
 * lineChart(container, { ts: [...], series: [{ key, label, values, color, width, dash }] })
 * Redraws on resize. Returns a cleanup function.
 */
export function lineChart(container, { ts, series, format = money }) {
  const draw = () => {
    container.replaceChildren();
    const W = Math.max(280, container.clientWidth);
    const H = W < 520 ? 220 : 300;
    const pad = { l: 8, r: 64, t: 12, b: 26 };
    const all = series.flatMap((s) => s.values);
    let lo = Math.min(...all), hi = Math.max(...all);
    const span = hi - lo || 1;
    lo -= span * 0.06;
    hi += span * 0.06;
    const x = (i) => pad.l + (i / (ts.length - 1)) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": "Portfolio value over time" });

    for (let k = 0; k <= 4; k++) {
      const v = lo + ((hi - lo) * k) / 4;
      const gy = y(v);
      svg.append(el("line", { x1: pad.l, x2: W - pad.r, y1: gy, y2: gy, class: "grid" }));
      const t = el("text", { x: W - pad.r + 8, y: gy + 4, class: "axis" });
      t.textContent = format(v);
      svg.append(t);
    }
    const months = W < 520 ? 4 : 8;
    for (let k = 0; k <= months; k++) {
      const i = Math.round((k / months) * (ts.length - 1));
      const t = el("text", { x: x(i), y: H - 6, class: "axis", "text-anchor": k === 0 ? "start" : k === months ? "end" : "middle" });
      t.textContent = new Date(ts[i]).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
      svg.append(t);
    }
    for (const s of [...series].reverse()) {
      const d = s.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
      svg.append(el("path", { d, fill: "none", stroke: s.color, "stroke-width": s.width || 1.5, "stroke-dasharray": s.dash || "", "stroke-linejoin": "round" }));
    }

    const cross = el("line", { y1: pad.t, y2: H - pad.b, class: "cross", visibility: "hidden" });
    const dots = series.map((s) => el("circle", { r: 3.5, fill: s.color, visibility: "hidden" }));
    svg.append(cross, ...dots);
    const tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    const hit = el("rect", { x: pad.l, y: pad.t, width: W - pad.l - pad.r, height: H - pad.t - pad.b, fill: "transparent" });
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.touches?.[0]?.clientX ?? ev.clientX) - r.left) * (W / r.width);
      const i = Math.max(0, Math.min(ts.length - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (ts.length - 1))));
      cross.setAttribute("x1", x(i));
      cross.setAttribute("x2", x(i));
      cross.setAttribute("visibility", "visible");
      series.forEach((s, j) => {
        dots[j].setAttribute("cx", x(i));
        dots[j].setAttribute("cy", y(s.values[i]));
        dots[j].setAttribute("visibility", "visible");
      });
      tip.hidden = false;
      tip.innerHTML = `<div class="tip-date">${day(ts[i])}</div>` +
        series.map((s) => `<div class="tip-row"><span class="dot" style="background:${s.color}"></span>${s.label}<b>${format(s.values[i])}</b></div>`).join("");
      const left = (x(i) / W) * r.width;
      tip.style.left = `${Math.min(Math.max(left, 90), r.width - 90)}px`;
    };
    const leave = () => {
      tip.hidden = true;
      cross.setAttribute("visibility", "hidden");
      dots.forEach((d) => d.setAttribute("visibility", "hidden"));
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerleave", leave);
    svg.append(hit);
    container.append(svg, tip);
  };
  draw();
  const ro = new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - (container.firstChild?.getAttribute?.("width") || 0)) > 4) draw();
  });
  ro.observe(container);
  return () => ro.disconnect();
}

export function sparkline(values, { width = 120, height = 32, color = "currentColor" } = {}) {
  const lo = Math.min(...values), hi = Math.max(...values);
  const x = (i) => (i / (values.length - 1)) * width;
  const y = (v) => 2 + (1 - (v - lo) / (hi - lo || 1)) * (height - 4);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const base = y(1);
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">` +
    (base > 0 && base < height ? `<line x1="0" x2="${width}" y1="${base}" y2="${base}" class="spark-base"/>` : "") +
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}
