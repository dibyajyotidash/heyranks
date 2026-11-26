/* HeyRanks app helpers, shared by the login, dashboard and admin pages. No build step: exposes window.HR. */
(() => {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /** JSON fetch against /api. A 401 outside auth/* sends the user to the login page. */
  async function api(path, { method = "GET", body } = {}) {
    const res = await fetch("/api/" + path, {
      method, credentials: "same-origin",
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && !path.startsWith("auth/")) {
      location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
      throw new Error("Please log in.");
    }
    if (!res.ok) { const e = new Error(data?.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
    return data;
  }

  const fmt = n => (n === null || n === undefined ? "–" : Number(n).toLocaleString("en-US"));
  const compact = n => {
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return fmt(Math.round(n));
  };
  const money = (minor, cur = "INR") => new Intl.NumberFormat(cur === "INR" ? "en-IN" : "en-US", {
    style: "currency", currency: cur, maximumFractionDigits: minor % 100 ? 2 : 0, minimumFractionDigits: 0,
  }).format((minor || 0) / 100);
  const date = (iso, o = { day: "numeric", month: "short", year: "numeric" }) =>
    iso ? new Date(iso.length === 10 ? iso + "T00:00:00Z" : iso).toLocaleDateString("en-GB", { timeZone: "UTC", ...o }) : "–";
  function ago(iso) {
    if (!iso) return "never";
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
    return date(iso);
  }
  const scoreClass = s => (s >= 75 ? "good" : s >= 45 ? "warn" : "bad");
  const scoreWord = s => (s >= 75 ? "Good" : s >= 45 ? "Needs work" : "Poor");
  const signed = n => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "±0");

  let toastTimer;
  function toast(msg) {
    let el = document.getElementById("toast");
    if (!el) { el = document.createElement("div"); el.id = "toast"; el.setAttribute("role", "status"); document.body.append(el); }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
  }

  /**
   * Opens Cashfree's checkout for a paid plan. Cashfree sends the buyer back to
   * /payment?order_id=..., which confirms the payment. Throws if checkout can't start.
   */
  async function checkout(plan) {
    const order = await api("checkout", { method: "POST", body: { plan } });
    if (!window.Cashfree) {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://sdk.cashfree.com/js/v3/cashfree.js";
        s.onload = resolve;
        s.onerror = () => reject(new Error("Couldn't load the payment page. Check your connection and try again."));
        document.head.append(s);
      });
    }
    window.Cashfree({ mode: order.mode }).checkout({ paymentSessionId: order.payment_session_id, redirectTarget: "_self" });
  }

  function initials(user) {
    const src = (user.name || user.email || "?").replace(/\(.*\)/, "").trim();
    return src.split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
  }

  // ─── charts (SVG, single series) ────────────────────────────────────────────
  const NS = "http://www.w3.org/2000/svg";
  function el(tag, attrs = {}, parent) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.append(n);
    return n;
  }
  function niceTicks(max, count = 4) {
    if (max <= 0) return [0, 1, 2, 3, 4];
    const raw = max / count, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
    const top = Math.ceil(max / step) * step;
    return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toFixed(6));
  }
  function tooltip(box) {
    let t = box.querySelector(".tooltip");
    if (!t) { t = document.createElement("div"); t.className = "tooltip hidden"; box.append(t); }
    return {
      show(x, y, value, label) {
        t.replaceChildren();
        const b = document.createElement("b");
        const k = document.createElement("i"); k.className = "k";
        b.append(k, document.createTextNode(value));
        const s = document.createElement("span"); s.textContent = label;
        t.append(b, s);
        t.classList.remove("hidden");
        const w = box.clientWidth;
        t.style.left = Math.min(Math.max(x, 60), w - 60) + "px";
        t.style.top = y + "px";
      },
      hide() { t.classList.add("hidden"); },
    };
  }
  /** Redraws on resize. draw(width) must fully render into `box`. */
  function responsive(box, draw) {
    box._ro?.disconnect();
    let last = 0;
    const ro = new ResizeObserver(() => { const w = Math.floor(box.clientWidth); if (w && w !== last) { last = w; draw(w); } });
    ro.observe(box);
    box._ro = ro;
  }
  function emptyChart(svg, w, h, msg) {
    const t = el("text", { x: w / 2, y: h / 2, "text-anchor": "middle", class: "empty" }, svg);
    t.textContent = msg;
  }

  /**
   * points: [{ x: "label for axis", tip: "label for tooltip", y: number }], oldest first.
   * opts: { yMax, ticks, format(v), height, label, empty }
   */
  function lineChart(box, points, opts = {}) {
    const H = opts.height || 220, M = { t: 14, r: 44, b: 26, l: 34 };
    const format = opts.format || (v => String(v));
    responsive(box, W => {
      box.replaceChildren();
      const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.label || "Line chart", tabindex: 0 });
      box.append(svg);
      const ticks = opts.ticks || niceTicks(Math.max(...points.map(p => p.y), 1));
      const yMax = opts.yMax ?? ticks[ticks.length - 1];
      const pw = W - M.l - M.r, ph = H - M.t - M.b;
      const X = i => M.l + (points.length < 2 ? pw / 2 : (i / (points.length - 1)) * pw);
      const Y = v => M.t + ph - (v / yMax) * ph;

      for (const t of ticks) {
        el("line", { x1: M.l, x2: W - M.r, y1: Y(t), y2: Y(t), class: "grid-line" }, svg);
        el("text", { x: M.l - 8, y: Y(t) + 4, "text-anchor": "end", class: "axis-text" }, svg).textContent = format(t);
      }
      if (!points.length) return emptyChart(svg, W, H, opts.empty || "No data yet");

      const xCount = Math.min(points.length, Math.max(2, Math.floor(pw / 90)));
      const shown = new Set(Array.from({ length: xCount }, (_, i) => Math.round(i * (points.length - 1) / Math.max(1, xCount - 1))));
      shown.forEach(i => {
        const anchor = points.length === 1 ? "middle" : i === 0 ? "start" : i === points.length - 1 ? "end" : "middle";
        el("text", { x: X(i), y: H - 6, "text-anchor": anchor, class: "axis-text" }, svg).textContent = points[i].x;
      });

      const d = points.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
      if (points.length > 1) {
        el("path", { d: `${d}L${X(points.length - 1)},${Y(0)}L${X(0)},${Y(0)}Z`, class: "series-area" }, svg);
        el("path", { d, class: "series-line" }, svg);
      }
      const li = points.length - 1;
      el("circle", { cx: X(li), cy: Y(points[li].y), r: 4.5, class: "series-dot" }, svg);
      el("text", { x: X(li) + 9, y: Y(points[li].y) + 4, class: "end-label" }, svg).textContent = format(points[li].y);

      // Hover / keyboard layer: crosshair snaps to the nearest period.
      const cross = el("line", { y1: M.t, y2: M.t + ph, class: "crosshair", visibility: "hidden" }, svg);
      const dot = el("circle", { r: 4.5, class: "series-dot", visibility: "hidden" }, svg);
      const tip = tooltip(box);
      let cur = -1;
      const show = i => {
        cur = Math.max(0, Math.min(li, i));
        const x = X(cur), y = Y(points[cur].y);
        cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
        dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("visibility", "visible");
        const scale = box.clientWidth / W;
        tip.show(x * scale, y * scale, format(points[cur].y), points[cur].tip || points[cur].x);
      };
      const hide = () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.hide(); };
      const hit = el("rect", { x: M.l - 10, y: 0, width: pw + 20, height: H, fill: "transparent" }, svg);
      hit.addEventListener("pointermove", e => {
        const r = svg.getBoundingClientRect();
        const px = (e.clientX - r.left) * (W / r.width);
        show(points.length < 2 ? 0 : Math.round(((px - M.l) / pw) * li));
      });
      hit.addEventListener("pointerleave", hide);
      svg.addEventListener("focus", () => show(cur < 0 ? li : cur));
      svg.addEventListener("blur", hide);
      svg.addEventListener("keydown", e => {
        if (e.key === "ArrowLeft") { show(cur - 1); e.preventDefault(); }
        if (e.key === "ArrowRight") { show(cur + 1); e.preventDefault(); }
      });
    });
  }

  /** Columns from one baseline. points: [{ x, tip, y }], oldest first. opts: { format, height, label, empty } */
  function barChart(box, points, opts = {}) {
    const H = opts.height || 180, M = { t: 10, r: 8, b: 26, l: 40 };
    const format = opts.format || compact;
    responsive(box, W => {
      box.replaceChildren();
      const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.label || "Bar chart" });
      box.append(svg);
      const max = Math.max(0, ...points.map(p => p.y));
      const ticks = niceTicks(max);
      const yMax = ticks[ticks.length - 1] || 1;
      const pw = W - M.l - M.r, ph = H - M.t - M.b;
      const Y = v => M.t + ph - (v / yMax) * ph;
      for (const t of ticks) {
        el("line", { x1: M.l, x2: W - M.r, y1: Y(t), y2: Y(t), class: "grid-line" }, svg);
        el("text", { x: M.l - 8, y: Y(t) + 4, "text-anchor": "end", class: "axis-text" }, svg).textContent = format(t);
      }
      if (!points.length || max === 0) return emptyChart(svg, W, H, opts.empty || "Nothing yet in this range");

      const slot = pw / points.length;
      const bw = Math.max(1, Math.min(24, slot - 2)); // 2px surface gap between neighbours
      const tip = tooltip(box);
      const bars = points.map((p, i) => {
        const x = M.l + i * slot + (slot - bw) / 2, h = (p.y / yMax) * ph, y = M.t + ph - h;
        const r = Math.min(4, h, bw / 2);
        if (h <= 0) return null;
        return el("path", {
          d: `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${y + h}Z`,
          class: "series-bar",
        }, svg);
      });
      [0, Math.floor((points.length - 1) / 2), points.length - 1].filter((v, i, a) => a.indexOf(v) === i).forEach((i, k, arr) => {
        const anchor = arr.length === 1 ? "middle" : k === 0 ? "start" : k === arr.length - 1 ? "end" : "middle";
        const x = anchor === "start" ? M.l + i * slot : anchor === "end" ? M.l + (i + 1) * slot : M.l + (i + .5) * slot;
        el("text", { x, y: H - 6, "text-anchor": anchor, class: "axis-text" }, svg).textContent = points[i].x;
      });
      // Each slot is its own hit target (wider than the bar), so thin bars are still easy to hover.
      points.forEach((p, i) => {
        const hit = el("rect", { x: M.l + i * slot, y: M.t, width: slot, height: ph, fill: "transparent" }, svg);
        hit.addEventListener("pointerenter", () => {
          bars.forEach((b, j) => b?.classList.toggle("dim", j !== i));
          const scale = box.clientWidth / W;
          tip.show((M.l + (i + .5) * slot) * scale, Y(p.y) * scale, format(p.y), p.tip || p.x);
        });
      });
      svg.addEventListener("pointerleave", () => { bars.forEach(b => b?.classList.remove("dim")); tip.hide(); });
    });
  }

  window.HR = { api, esc, fmt, compact, money, date, ago, toast, checkout, initials, scoreClass, scoreWord, signed, lineChart, barChart };
})();
