(() => {
  "use strict";

  const REFRESH_MS = 30_000;
  const HOURS = 24;

  const el = {
    value: document.getElementById("latest-value"),
    badge: document.getElementById("latest-badge"),
    time: document.getElementById("latest-time"),
    marker: document.getElementById("scale-marker"),
    statMin: document.getElementById("stat-min"),
    statMax: document.getElementById("stat-max"),
    statAvg: document.getElementById("stat-avg"),
    statCount: document.getElementById("stat-count"),
    live: document.getElementById("live"),
    liveText: document.getElementById("live-text"),
    hint: document.getElementById("chart-hint"),
    empty: document.getElementById("empty"),
    tooltip: document.getElementById("tooltip"),
    lastRefresh: document.getElementById("last-refresh"),
    chart: document.getElementById("chart"),
  };

  const state = {
    points: [],
    stats: null,
    latest: null,
    windowEnd: Date.now() / 1000,
    hover: -1,
    fetchedAt: 0,
  };

  const timeFmt = new Intl.DateTimeFormat("cs-CZ", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const dateTimeFmt = new Intl.DateTimeFormat("cs-CZ", {
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const relFmt = new Intl.RelativeTimeFormat("cs", { numeric: "auto" });

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  /** 0.00 → green, 0.50 → yellow, 1.00 → red. */
  function colorFor(value) {
    const v = clamp(Number(value), 0, 1);
    const hue = 140 * (1 - v);
    return `hsl(${hue.toFixed(0)} 78% 58%)`;
  }

  function classify(value) {
    if (value === null) return { label: "bez dat", color: "var(--muted)" };
    if (value < 0.2) return { label: "velmi dobré", color: colorFor(value) };
    if (value < 0.4) return { label: "dobré", color: colorFor(value) };
    if (value < 0.6) return { label: "průměrné", color: colorFor(value) };
    if (value < 0.8) return { label: "špatné", color: colorFor(value) };
    return { label: "velmi špatné", color: colorFor(value) };
  }

  function formatAge(seconds) {
    if (seconds === null || !Number.isFinite(seconds)) return "";
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return relFmt.format(-s, "second");
    if (s < 3600) return relFmt.format(-Math.round(s / 60), "minute");
    if (s < 86400) return relFmt.format(-Math.round(s / 3600), "hour");
    return relFmt.format(-Math.round(s / 86400), "day");
  }

  function setLive(ok, text) {
    el.live.classList.toggle("is-ok", ok);
    el.live.classList.toggle("is-error", !ok);
    el.liveText.textContent = text;
  }

  function renderSummary() {
    const { latest, stats } = state;

    if (latest) {
      const age = Date.now() / 1000 - latest.created_at;
      el.value.textContent = latest.value.toFixed(2);
      el.value.style.color = colorFor(latest.value);
      const cls = classify(latest.value);
      el.badge.textContent = cls.label;
      el.badge.style.color = cls.color;
      el.badge.style.borderColor = "currentColor";
      el.time.textContent = `Naměřeno ${dateTimeFmt.format(
        new Date(latest.created_at * 1000)
      )} · ${formatAge(age)}`;
      el.marker.style.left = `${clamp(latest.value, 0, 1) * 100}%`;
      el.marker.style.background = colorFor(latest.value);
      el.marker.classList.add("is-visible");
    } else {
      el.value.textContent = "—";
      el.value.style.color = "";
      el.badge.textContent = "bez dat";
      el.badge.style.color = "";
      el.time.textContent = "Zatím nebylo nic naměřeno.";
      el.marker.classList.remove("is-visible");
    }

    if (stats && stats.count > 0) {
      el.statMin.textContent = stats.min.toFixed(2);
      el.statMax.textContent = stats.max.toFixed(2);
      el.statAvg.textContent = stats.avg.toFixed(2);
      el.statCount.textContent = String(stats.count);
      el.statMin.style.color = colorFor(stats.min);
      el.statMax.style.color = colorFor(stats.max);
      el.statAvg.style.color = colorFor(stats.avg);
    } else {
      el.statMin.textContent = "—";
      el.statMax.textContent = "—";
      el.statAvg.textContent = "—";
      el.statCount.textContent = "0";
      el.statMin.style.color = "";
      el.statMax.style.color = "";
      el.statAvg.style.color = "";
    }

    const shown = state.points.length;
    if (stats && stats.count > shown && shown > 0) {
      el.hint.textContent = `zprůměrováno z ${stats.count} vzorků`;
    } else if (shown > 0) {
      el.hint.textContent = `${shown} bodů`;
    } else {
      el.hint.textContent = "";
    }

    el.empty.hidden = shown > 0;
    el.lastRefresh.textContent = `Aktualizováno ${timeFmt.format(
      new Date(state.fetchedAt || Date.now())
    )}`;
  }

  function drawHeaderDots() {
    document.querySelectorAll("[data-scale-color]").forEach((node) => {
      node.style.background = colorFor(Number(node.dataset.scaleColor));
    });
  }

  // ---------------------------------------------------------------- canvas

  const ctx = el.chart.getContext("2d");
  let width = 0;
  let height = 0;

  function resize() {
    const rect = el.chart.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    el.chart.width = Math.round(width * dpr);
    el.chart.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawChart();
  }

  function xFor(t, pad, plotW) {
    const span = HOURS * 3600;
    const x = ((t - (state.windowEnd - span)) / span) * plotW;
    return pad.left + clamp(x, 0, plotW);
  }

  function drawChart() {
    ctx.clearRect(0, 0, width, height);
    if (!width || !height) return;

    const pad = { top: 14, right: 14, bottom: 28, left: 46 };
    const plotW = Math.max(1, width - pad.left - pad.right);
    const plotH = Math.max(1, height - pad.top - pad.bottom);
    const yFor = (v) => pad.top + (1 - clamp(v, 0, 1)) * plotH;

    // Background tint: green (best) at the bottom, red (worst) at the top.
    const bg = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    bg.addColorStop(0, "rgba(239, 68, 68, 0.075)");
    bg.addColorStop(0.5, "rgba(148, 163, 184, 0.02)");
    bg.addColorStop(1, "rgba(34, 197, 94, 0.075)");
    ctx.fillStyle = bg;
    ctx.fillRect(pad.left, pad.top, plotW, plotH);

    // Horizontal grid + y labels.
    ctx.font =
      '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const v = i / 4;
      const y = yFor(v);
      ctx.strokeStyle = i === 0 || i === 4 ? "#2b3a55" : "#1e2a40";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.left, y + 0.5);
      ctx.lineTo(pad.left + plotW, y + 0.5);
      ctx.stroke();
      ctx.fillStyle = "#7f8fa8";
      ctx.fillText(v.toFixed(2), pad.left - 9, y);
    }

    // Vertical time grid + x labels.
    const start = state.windowEnd - HOURS * 3600;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let i = 0; i <= 4; i++) {
      const t = start + (i / 4) * HOURS * 3600;
      const x = pad.left + (i / 4) * plotW;
      ctx.strokeStyle = "#1b2539";
      ctx.beginPath();
      ctx.moveTo(x + 0.5, pad.top);
      ctx.lineTo(x + 0.5, pad.top + plotH);
      ctx.stroke();
      const anchor = i === 0 ? "left" : i === 4 ? "right" : "center";
      ctx.textAlign = anchor;
      ctx.fillStyle = "#7f8fa8";
      ctx.fillText(timeFmt.format(new Date(t * 1000)), x, pad.top + plotH + 9);
    }

    if (!state.points.length) return;

    const pts = state.points;

    // Area under the curve.
    const area = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    area.addColorStop(0, "rgba(239, 68, 68, 0.10)");
    area.addColorStop(1, "rgba(34, 197, 94, 0.10)");
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xFor(p.t, pad, plotW);
      const y = yFor(p.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(xFor(pts[pts.length - 1].t, pad, plotW), pad.top + plotH);
    ctx.lineTo(xFor(pts[0].t, pad, plotW), pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = area;
    ctx.fill();

    // Line, colored by value height: green low, red high.
    const line = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    line.addColorStop(0, "#ef4444");
    line.addColorStop(0.3, "#f59e0b");
    line.addColorStop(0.6, "#eab308");
    line.addColorStop(1, "#22c55e");
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xFor(p.t, pad, plotW);
      const y = yFor(p.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = line;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    // Individual samples: dots when the series is sparse enough to read.
    if (pts.length <= 240) {
      pts.forEach((p) => {
        const x = xFor(p.t, pad, plotW);
        const y = yFor(p.v);
        ctx.beginPath();
        ctx.arc(x, y, 2.4, 0, Math.PI * 2);
        ctx.fillStyle = colorFor(p.v);
        ctx.fill();
        ctx.strokeStyle = "#0b1120";
        ctx.lineWidth = 1;
        ctx.stroke();
      });
    }

    // Hover crosshair.
    if (state.hover >= 0 && state.hover < pts.length) {
      const p = pts[state.hover];
      const x = xFor(p.t, pad, plotW);
      const y = yFor(p.v);
      ctx.strokeStyle = "rgba(230, 237, 247, 0.28)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = colorFor(p.v);
      ctx.fill();
      ctx.strokeStyle = "#e6edf7";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  function nearestPoint(offsetX) {
    const pts = state.points;
    if (!pts.length) return -1;
    const pad = { left: 46, right: 14 };
    const plotW = Math.max(1, width - pad.left - pad.right);
    const start = state.windowEnd - HOURS * 3600;
    const span = HOURS * 3600;

    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const x = pad.left + ((pts[i].t - start) / span) * plotW;
      const d = Math.abs(x - offsetX);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return bestDist <= 24 ? best : -1;
  }

  function handleMove(event) {
    if (!state.points.length) return;
    const rect = el.chart.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const index = nearestPoint(x);
    if (index === state.hover) {
      if (index >= 0) positionTooltip(index, x);
      return;
    }
    state.hover = index;
    drawChart();
    if (index >= 0) positionTooltip(index, x);
    else el.tooltip.hidden = true;
  }

  function positionTooltip(index, x) {
    const p = state.points[index];
    const pad = { top: 14, bottom: 28, left: 46, right: 14 };
    const plotH = Math.max(1, height - pad.top - pad.bottom);
    const y = pad.top + (1 - clamp(p.v, 0, 1)) * plotH;

    el.tooltip.innerHTML =
      `<span style="color:${colorFor(p.v)}">${p.v.toFixed(2)}</span>` +
      `<br>${dateTimeFmt.format(new Date(p.t * 1000))}`;
    el.tooltip.hidden = false;
    const tipW = el.tooltip.offsetWidth;
    const left = clamp(x, tipW / 2 + 4, width - tipW / 2 - 4);
    el.tooltip.style.left = `${left}px`;
    el.tooltip.style.top = `${Math.max(y, 34)}px`;
  }

  function handleLeave() {
    if (state.hover === -1) return;
    state.hover = -1;
    el.tooltip.hidden = true;
    drawChart();
  }

  // ---------------------------------------------------------------- data

  async function load() {
    try {
      const response = await fetch(`/api/readings?hours=${HOURS}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      state.points = Array.isArray(data.points) ? data.points : [];
      state.stats = data.stats || null;
      state.latest = data.latest || null;
      state.windowEnd = data.server_time || Date.now() / 1000;
      state.fetchedAt = Date.now();
      state.hover = -1;
      el.tooltip.hidden = true;

      renderSummary();
      drawChart();
      setLive(true, "online");
    } catch (error) {
      console.error("Nepodařilo se načíst data:", error);
      setLive(false, "chyba připojení");
      el.lastRefresh.textContent = `Aktualizace selhala ${timeFmt.format(
        new Date()
      )}`;
    }
  }

  function schedule() {
    window.setTimeout(async () => {
      if (!document.hidden) await load();
      schedule();
    }, REFRESH_MS);
  }

  drawHeaderDots();
  new ResizeObserver(resize).observe(el.chart);
  el.chart.addEventListener("mousemove", handleMove);
  el.chart.addEventListener("mouseleave", handleLeave);
  el.chart.addEventListener("touchstart", (event) => {
    if (!event.touches.length) return;
    const rect = el.chart.getBoundingClientRect();
    const x = event.touches[0].clientX - rect.left;
    const index = nearestPoint(x);
    state.hover = index;
    drawChart();
    if (index >= 0) positionTooltip(index, x);
  });
  el.chart.addEventListener("touchend", handleLeave);

  load().then(schedule);
})();
