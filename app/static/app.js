(() => {
  "use strict";

  const REFRESH_MS = 30_000;
  const HOURS = 24;
  const THEME_KEY = "nahovnost-theme";
  const PAD = { top: 16, right: 16, bottom: 32, left: 48 };

  const el = {
    value: document.getElementById("latest-value"),
    badge: document.getElementById("latest-badge"),
    time: document.getElementById("latest-time"),
    marker: document.getElementById("scale-marker"),
    statMin: document.getElementById("stat-min"),
    statMax: document.getElementById("stat-max"),
    statAvg: document.getElementById("stat-avg"),
    statCount: document.getElementById("stat-count"),
    comment: document.getElementById("latest-comment"),
    hint: document.getElementById("chart-hint"),
    empty: document.getElementById("empty"),
    tooltip: document.getElementById("tooltip"),
    lastRefresh: document.getElementById("last-refresh"),
    chart: document.getElementById("chart"),
    themeToggle: document.getElementById("theme-toggle"),
    helpToggle: document.getElementById("help-toggle"),
    helpPanel: document.getElementById("api-help"),
    helpClose: document.getElementById("help-close"),
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

  let tokens = {};

  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

  /* ------------------------------------------------------------- tokens */

  function readTokens() {
    const styles = getComputedStyle(document.documentElement);
    const read = (name) => styles.getPropertyValue(name).trim();

    tokens = {
      success: read("--color-success"),
      secondary: read("--color-secondary"),
      error: read("--color-error"),
      successContainer: read("--color-success-container"),
      errorContainer: read("--color-error-container"),
      surfaceLow: read("--color-surface-container-low"),
      surfaceLowest: read("--color-surface-container-lowest"),
      onSurface: read("--color-on-surface"),
      onSurfaceVariant: read("--color-on-surface-variant"),
      outlineVariant: read("--color-outline-variant"),
      fontSans: read("--font-sans"),
      radiusLg: read("--radius-lg"),
    };
  }

  function parseColor(input) {
    const value = (input || "").trim();

    if (value.startsWith("#")) {
      const hex = value.slice(1);
      const full =
        hex.length === 3
          ? hex
              .split("")
              .map((char) => char + char)
              .join("")
          : hex;
      return {
        r: parseInt(full.slice(0, 2), 16),
        g: parseInt(full.slice(2, 4), 16),
        b: parseInt(full.slice(4, 6), 16),
      };
    }

    const match = value.match(
      /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/
    );
    if (match) {
      return {
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3]),
      };
    }

    return { r: 0, g: 0, b: 0 };
  }

  function mix(from, to, amount) {
    const a = parseColor(from);
    const b = parseColor(to);
    const t = clamp(amount, 0, 1);
    const channel = (start, end) => Math.round(start + (end - start) * t);
    return `rgb(${channel(a.r, b.r)}, ${channel(a.g, b.g)}, ${channel(
      a.b,
      b.b
    )})`;
  }

  function translucent(color, alpha) {
    const { r, g, b } = parseColor(color);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /** 0.00 → success, 0.50 → secondary, 1.00 → error. */
  function colorFor(value) {
    const v = clamp(Number(value), 0, 1);
    return v <= 0.5
      ? mix(tokens.success, tokens.secondary, v * 2)
      : mix(tokens.secondary, tokens.error, (v - 0.5) * 2);
  }

  /** Readable text colour for the current severity. */
  function severityToken(value) {
    if (value < 0.4) return "var(--color-success)";
    if (value < 0.8) return "var(--color-secondary)";
    return "var(--color-error)";
  }

  function badgeFor(value) {
    if (value === null) {
      return { className: "badge--muted", label: "bez dat" };
    }
    if (value < 0.2) {
      return { className: "badge--success", label: "velmi dobré" };
    }
    if (value < 0.4) {
      return { className: "badge--success-soft", label: "dobré" };
    }
    if (value < 0.6) {
      return { className: "badge--warning", label: "průměrné" };
    }
    if (value < 0.8) {
      return { className: "badge--warning-strong", label: "špatné" };
    }
    return { className: "badge--error", label: "velmi špatné" };
  }

  /* --------------------------------------------------------------- text */

  function formatAge(seconds) {
    if (seconds === null || !Number.isFinite(seconds)) return "";
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return relFmt.format(-s, "second");
    if (s < 3600) return relFmt.format(-Math.round(s / 60), "minute");
    if (s < 86400) return relFmt.format(-Math.round(s / 3600), "hour");
    return relFmt.format(-Math.round(s / 86400), "day");
  }

  function setStat(node, value) {
    if (value === null || value === undefined) {
      node.textContent = "—";
      node.style.color = "";
      return;
    }
    node.textContent = value.toFixed(2);
    node.style.color = severityToken(value);
  }

  function renderSummary() {
    const { latest, stats } = state;

    if (latest) {
      const age = Date.now() / 1000 - latest.created_at;
      el.value.textContent = latest.value.toFixed(2);
      el.value.style.color = severityToken(latest.value);

      const badge = badgeFor(latest.value);
      el.badge.className = `badge ${badge.className}`;
      el.badge.textContent = badge.label;

      el.time.textContent = `Naměřeno ${dateTimeFmt.format(
        new Date(latest.created_at * 1000)
      )} · ${formatAge(age)}`;

      if (latest.comment) {
        el.comment.textContent = `Komentář: ${latest.comment}`;
        el.comment.hidden = false;
      } else {
        el.comment.textContent = "";
        el.comment.hidden = true;
      }

      el.marker.style.left = `${clamp(latest.value, 0, 1) * 100}%`;
      el.marker.classList.add("is-visible");
    } else {
      el.value.textContent = "—";
      el.value.style.color = "";
      el.badge.className = "badge badge--muted";
      el.badge.textContent = "bez dat";
      el.time.textContent = "Zatím nebylo nic naměřeno.";
      el.comment.textContent = "";
      el.comment.hidden = true;
      el.marker.classList.remove("is-visible");
    }

    if (stats && stats.count > 0) {
      setStat(el.statMin, stats.min);
      setStat(el.statMax, stats.max);
      setStat(el.statAvg, stats.avg);
      el.statCount.textContent = String(stats.count);
      el.statCount.style.color = "";
    } else {
      setStat(el.statMin, null);
      setStat(el.statMax, null);
      setStat(el.statAvg, null);
      el.statCount.textContent = "0";
      el.statCount.style.color = "";
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

  /* --------------------------------------------------------------- theme */

  function isDark() {
    return document.documentElement.classList.contains("dark");
  }

  function syncThemeButton() {
    const dark = isDark();
    el.themeToggle.setAttribute("aria-pressed", String(dark));
    el.themeToggle.textContent = dark ? "Světlý režim" : "Tmavý režim";
  }

  function applyTheme(dark) {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
    } catch (error) {
      /* keep the toggle working without persistence */
    }
    syncThemeButton();
    readTokens();
    drawChart();
  }

  el.themeToggle.addEventListener("click", () => applyTheme(!isDark()));

  /* ---------------------------------------------------------------- help */

  function openHelp() {
    el.helpPanel.hidden = false;
    el.helpToggle.setAttribute("aria-expanded", "true");
    el.helpClose.focus();
  }

  function closeHelp(returnFocus = true) {
    if (el.helpPanel.hidden) return;
    const focusInside = el.helpPanel.contains(document.activeElement);
    el.helpPanel.hidden = true;
    el.helpToggle.setAttribute("aria-expanded", "false");
    if (returnFocus || focusInside) el.helpToggle.focus();
  }

  el.helpToggle.addEventListener("click", () => {
    if (el.helpPanel.hidden) openHelp();
    else closeHelp();
  });
  el.helpClose.addEventListener("click", () => closeHelp());

  document.addEventListener("click", (event) => {
    if (
      !el.helpPanel.hidden &&
      event.target instanceof Element &&
      !event.target.closest(".help")
    ) {
      closeHelp(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el.helpPanel.hidden) closeHelp();
  });

  /* -------------------------------------------------------------- canvas */

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

  function xFor(t, plotW) {
    const span = HOURS * 3600;
    const x = ((t - (state.windowEnd - span)) / span) * plotW;
    return PAD.left + clamp(x, 0, plotW);
  }

  function drawChart() {
    ctx.clearRect(0, 0, width, height);
    if (!width || !height || !tokens.success) return;

    const plotW = Math.max(1, width - PAD.left - PAD.right);
    const plotH = Math.max(1, height - PAD.top - PAD.bottom);
    const yFor = (value) =>
      PAD.top + (1 - clamp(value, 0, 1)) * plotH;
    const plotRadius = parseFloat(tokens.radiusLg) || 8;
    const font = `500 12px ${tokens.fontSans}`;

    // Plot surface, stepping up from the card surface.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(PAD.left, PAD.top, plotW, plotH, plotRadius);
    ctx.clip();
    ctx.fillStyle = tokens.surfaceLow;
    ctx.fillRect(PAD.left, PAD.top, plotW, plotH);

    const bands = ctx.createLinearGradient(
      0,
      PAD.top,
      0,
      PAD.top + plotH
    );
    bands.addColorStop(0, translucent(tokens.errorContainer, 0.42));
    bands.addColorStop(0.5, translucent(tokens.surfaceLow, 0));
    bands.addColorStop(1, translucent(tokens.successContainer, 0.42));
    ctx.fillStyle = bands;
    ctx.fillRect(PAD.left, PAD.top, plotW, plotH);
    ctx.restore();

    // Horizontal grid and value labels.
    ctx.font = font;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i += 1) {
      const value = i / 4;
      const y = yFor(value);
      ctx.globalAlpha = i === 0 || i === 4 ? 0.9 : 0.55;
      ctx.strokeStyle = tokens.outlineVariant;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y + 0.5);
      ctx.lineTo(PAD.left + plotW, y + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = tokens.onSurfaceVariant;
      ctx.fillText(value.toFixed(2), PAD.left - 10, y);
    }

    const start = state.windowEnd - HOURS * 3600;
    const span = HOURS * 3600;
    const xTicks = plotW < 220 ? 2 : 4;

    // Vertical time grid and clock labels.
    ctx.textBaseline = "top";
    for (let i = 0; i <= xTicks; i += 1) {
      const x = PAD.left + (i / xTicks) * plotW;
      const t = start + (i / xTicks) * span;
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = tokens.outlineVariant;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, PAD.top);
      ctx.lineTo(x + 0.5, PAD.top + plotH);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.textAlign =
        i === 0 ? "left" : i === xTicks ? "right" : "center";
      ctx.fillStyle = tokens.onSurfaceVariant;
      ctx.fillText(
        timeFmt.format(new Date(t * 1000)),
        x,
        PAD.top + plotH + 10
      );
    }

    if (!state.points.length) return;

    const pts = state.points;

    // Area beneath the series.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(PAD.left, PAD.top, plotW, plotH, plotRadius);
    ctx.clip();
    ctx.beginPath();
    pts.forEach((point, index) => {
      const x = xFor(point.t, plotW);
      const y = yFor(point.v);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(xFor(pts[pts.length - 1].t, plotW), PAD.top + plotH);
    ctx.lineTo(xFor(pts[0].t, plotW), PAD.top + plotH);
    ctx.closePath();
    const area = ctx.createLinearGradient(
      0,
      PAD.top,
      0,
      PAD.top + plotH
    );
    area.addColorStop(0, translucent(tokens.errorContainer, 0.32));
    area.addColorStop(1, translucent(tokens.successContainer, 0.32));
    ctx.fillStyle = area;
    ctx.fill();
    ctx.restore();

    // Series line: red high, amber mid, green low.
    const line = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + plotH);
    line.addColorStop(0, tokens.error);
    line.addColorStop(0.5, tokens.secondary);
    line.addColorStop(1, tokens.success);
    ctx.beginPath();
    pts.forEach((point, index) => {
      const x = xFor(point.t, plotW);
      const y = yFor(point.v);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = line;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    // Individual samples when the series is sparse enough to read.
    if (pts.length <= 240) {
      ctx.strokeStyle = tokens.surfaceLow;
      ctx.lineWidth = 1.5;
      pts.forEach((point) => {
        ctx.beginPath();
        ctx.arc(
          xFor(point.t, plotW),
          yFor(point.v),
          2.6,
          0,
          Math.PI * 2
        );
        ctx.fillStyle = colorFor(point.v);
        ctx.fill();
        ctx.stroke();
      });
    }

    // Hover crosshair.
    if (state.hover >= 0 && state.hover < pts.length) {
      const point = pts[state.hover];
      const x = xFor(point.t, plotW);
      const y = yFor(point.v);
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = tokens.onSurface;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, PAD.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = colorFor(point.v);
      ctx.fill();
      ctx.strokeStyle = tokens.surfaceLowest;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  function nearestPoint(offsetX) {
    const pts = state.points;
    if (!pts.length) return -1;
    const plotW = Math.max(1, width - PAD.left - PAD.right);
    const span = HOURS * 3600;
    const start = state.windowEnd - span;

    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < pts.length; i += 1) {
      const x = PAD.left + ((pts[i].t - start) / span) * plotW;
      const distance = Math.abs(x - offsetX);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return bestDistance <= 24 ? best : -1;
  }

  function positionTooltip(index, x) {
    const point = state.points[index];
    const plotH = Math.max(1, height - PAD.top - PAD.bottom);
    const y = PAD.top + (1 - clamp(point.v, 0, 1)) * plotH;

    el.tooltip.innerHTML =
      `<span class="tooltip-value" style="color:${severityToken(
        point.v
      )}">${point.v.toFixed(2)}</span><br>` +
      `<span class="tooltip-time">${dateTimeFmt.format(
        new Date(point.t * 1000)
      )}</span>`;
    el.tooltip.hidden = false;
    const tipWidth = el.tooltip.offsetWidth;
    const tipHeight = el.tooltip.offsetHeight;
    const left = clamp(
      x,
      tipWidth / 2 + 4,
      width - tipWidth / 2 - 4
    );
    el.tooltip.style.left = `${left}px`;
    el.tooltip.style.top = `${Math.max(y, tipHeight + 20)}px`;
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

  function handleLeave() {
    if (state.hover === -1) return;
    state.hover = -1;
    el.tooltip.hidden = true;
    drawChart();
  }

  /* ---------------------------------------------------------------- data */

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
      el.lastRefresh.classList.remove("is-error");
    } catch (error) {
      console.error("Nepodařilo se načíst data:", error);
      el.lastRefresh.classList.add("is-error");
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

  /* ----------------------------------------------------------------- init */

  syncThemeButton();
  readTokens();
  new ResizeObserver(resize).observe(el.chart);
  resize();
  el.chart.addEventListener("mousemove", handleMove);
  el.chart.addEventListener("mouseleave", handleLeave);
  el.chart.addEventListener(
    "touchstart",
    (event) => {
      if (!event.touches.length) return;
      const rect = el.chart.getBoundingClientRect();
      const x = event.touches[0].clientX - rect.left;
      const index = nearestPoint(x);
      state.hover = index;
      drawChart();
      if (index >= 0) positionTooltip(index, x);
    },
    { passive: true }
  );
  el.chart.addEventListener("touchend", handleLeave);

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(drawChart);
  }

  load().then(schedule);
})();
