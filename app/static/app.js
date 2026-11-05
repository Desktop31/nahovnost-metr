(() => {
  "use strict";

  const REFRESH_MS = 30_000;
  const HOURS = 24;
  const THEME_KEY = "nahovnost-theme";
  const PAD = { top: 16, right: 16, bottom: 32, left: 48 };
  const MINI_PAD = { top: 10, right: 10, bottom: 8, left: 36 };

  const pathMatch = window.location.pathname.match(/^\/m\/([^/]+)\/?$/);
  let currentSlug = null;
  if (pathMatch) {
    try {
      currentSlug = decodeURIComponent(pathMatch[1]);
    } catch (error) {
      currentSlug = pathMatch[1];
    }
  }
  const isDetail = currentSlug !== null;

  const el = {
    overviewView: document.getElementById("overview-view"),
    detailView: document.getElementById("detail-view"),
    meterGrid: document.getElementById("meter-grid"),
    meterCount: document.getElementById("meter-count"),
    overviewStatus: document.getElementById("overview-status"),
    overviewEmpty: document.getElementById("overview-empty"),
    meterTitle: document.getElementById("meter-title"),
    meterDescription: document.getElementById("meter-description"),
    detailError: document.getElementById("detail-error"),
    detailErrorText: document.getElementById("detail-error-text"),
    detailContent: document.getElementById("detail-content"),
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
    hoverBox: document.getElementById("chart-hover"),
    hoverMeta: document.getElementById("hover-meta"),
    hoverText: document.getElementById("hover-text"),
    empty: document.getElementById("empty"),
    tooltip: document.getElementById("tooltip"),
    lastRefresh: document.getElementById("last-refresh"),
    chart: document.getElementById("chart"),
    chartLive: document.getElementById("chart-live"),
    themeToggle: document.getElementById("theme-toggle"),
    addToggle: document.getElementById("add-toggle"),
    addPanel: document.getElementById("add-panel"),
    addClose: document.getElementById("add-close"),
    addCancel: document.getElementById("add-cancel"),
    addForm: document.getElementById("add-form"),
    addMeter: document.getElementById("add-meter"),
    addValueRange: document.getElementById("add-value-range"),
    addValueNumber: document.getElementById("add-value-number"),
    addComment: document.getElementById("add-comment"),
    addToken: document.getElementById("add-token"),
    addTokenClear: document.getElementById("add-token-clear"),
    addStatus: document.getElementById("add-status"),
    addSubmit: document.getElementById("add-submit"),
    helpToggle: document.getElementById("help-toggle"),
    helpPanel: document.getElementById("api-help"),
    helpClose: document.getElementById("help-close"),
  };

  const TOKEN_PREFIX = "nahovnost-token:";

  let knownMeters = [];
  let currentMeterMeta = null;
  let lastSelectedMeter = null;
  let refreshView = async () => {};

  const state = {
    points: [],
    stats: null,
    latest: null,
    windowEnd: Date.now() / 1000,
    hover: -1,
    fetchedAt: 0,
  };

  const overviewCharts = [];
  let overviewObserver = null;
  let activeRedraw = () => {};

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
    if (value === null || value === undefined) {
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
    if (seconds === null || seconds === undefined) return "";
    if (!Number.isFinite(Number(seconds))) return "";
    const s = Math.max(0, Math.round(Number(seconds)));
    if (s < 60) return relFmt.format(-s, "second");
    if (s < 3600) return relFmt.format(-Math.round(s / 60), "minute");
    if (s < 86400) return relFmt.format(-Math.round(s / 3600), "hour");
    return relFmt.format(-Math.round(s / 86400), "day");
  }

  function meterCountLabel(count) {
    if (count === 1) return "1 měřidlo";
    if (count >= 2 && count <= 4) return `${count} měřidla`;
    return `${count} měřidel`;
  }

  function setRefresh(ok, text) {
    el.lastRefresh.classList.toggle("is-error", !ok);
    el.lastRefresh.textContent =
      text || `${ok ? "Aktualizováno" : "Aktualizace selhala"} ${timeFmt.format(new Date())}`;
  }

  async function fetchJSON(url) {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (typeof body.detail === "string") detail = body.detail;
      } catch (error) {
        /* keep the status message */
      }
      const error = new Error(detail);
      error.status = response.status;
      throw error;
    }
    return response.json();
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
    activeRedraw();
  }

  el.themeToggle.addEventListener("click", () => applyTheme(!isDark()));

  /* ---------------------------------------------------------------- help */

  function openHelp() {
    closeAddPanel(false);
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
    if (event.key !== "Escape") return;
    if (!el.helpPanel.hidden) closeHelp();
    else if (!el.addPanel.hidden) closeAddPanel();
  });

  /* -------------------------------------------------------------- add form */

  function tokenKey(slug) {
    return `${TOKEN_PREFIX}${slug}`;
  }

  function readStoredToken(slug) {
    if (!slug) return "";
    try {
      return localStorage.getItem(tokenKey(slug)) || "";
    } catch (error) {
      return "";
    }
  }

  function writeStoredToken(slug, token) {
    try {
      localStorage.setItem(tokenKey(slug), token);
    } catch (error) {
      /* keep the field editable if storage is unavailable */
    }
  }

  function removeStoredToken(slug) {
    try {
      localStorage.removeItem(tokenKey(slug));
    } catch (error) {
      /* nothing to do */
    }
  }

  function setAddStatus(text, type) {
    el.addStatus.textContent = text || "";
    el.addStatus.hidden = !text;
    el.addStatus.classList.toggle("is-error", type === "error");
    el.addStatus.classList.toggle("is-success", type === "success");
  }

  function syncAddTokenField(clearManual = false) {
    const slug = el.addMeter.value;
    const stored = readStoredToken(slug);
    if (clearManual || stored) el.addToken.value = "";
    el.addToken.disabled = !slug || Boolean(stored);
    el.addToken.placeholder = stored
      ? "Token je uložen v prohlížeči"
      : "Vložte token měřidla";
    el.addTokenClear.hidden = !stored;
    el.addTokenClear.disabled = !slug;
    el.addSubmit.disabled = !slug;
  }

  async function getAddMeters() {
    if (isDetail && currentMeterMeta) return [currentMeterMeta];
    if (!isDetail && knownMeters.length) return knownMeters;
    const list = await fetchJSON("/api/meters");
    knownMeters = Array.isArray(list.meters) ? list.meters : [];
    if (isDetail) {
      return knownMeters.filter((meter) => meter.slug === currentSlug);
    }
    return knownMeters;
  }

  async function populateAddMeters() {
    el.addMeter.replaceChildren();
    el.addMeter.disabled = false;
    el.addSubmit.disabled = true;

    let meters;
    try {
      meters = await getAddMeters();
    } catch (error) {
      setAddStatus("Měřidla se nepodařilo načíst.", "error");
      el.addMeter.disabled = true;
      syncAddTokenField(true);
      return;
    }

    if (isDetail) {
      const meter = meters[0] || {
        slug: currentSlug,
        name: currentMeterMeta ? currentMeterMeta.name : currentSlug,
      };
      el.addMeter.append(
        new Option(meter.name || meter.slug, meter.slug)
      );
      el.addMeter.value = currentSlug;
      el.addMeter.disabled = true;
    } else if (!meters.length) {
      el.addMeter.append(new Option("Žádná měřidla", ""));
      el.addMeter.disabled = true;
      setAddStatus("Nejsou dostupná žádná měřidla.", "error");
    } else {
      meters.forEach((meter) => {
        el.addMeter.append(new Option(meter.name || meter.slug, meter.slug));
      });
      const preferred =
        meters.find((meter) => meter.slug === lastSelectedMeter)?.slug ||
        meters[0].slug;
      el.addMeter.value = preferred;
      lastSelectedMeter = preferred;
    }

    syncAddTokenField(true);
    if (isDetail) {
      setAddStatus("");
    }
  }

  function openAddPanel() {
    closeHelp(false);
    setAddStatus("");
    el.addPanel.hidden = false;
    el.addToggle.setAttribute("aria-expanded", "true");
    positionAddPanel();
    populateAddMeters().then(() => {
      if (el.addPanel.hidden) return;
      positionAddPanel();
      if (el.addMeter.disabled) el.addValueRange.focus();
      else el.addMeter.focus();
    });
  }

  function closeAddPanel(returnFocus = true) {
    if (el.addPanel.hidden) return;
    const focusInside = el.addPanel.contains(document.activeElement);
    el.addPanel.hidden = true;
    el.addToggle.setAttribute("aria-expanded", "false");
    if (returnFocus || focusInside) el.addToggle.focus();
  }

  function positionAddPanel() {
    if (el.addPanel.hidden) return;
    const style = el.addPanel.style;
    if (window.innerWidth > 640) {
      style.removeProperty("position");
      style.removeProperty("top");
      style.removeProperty("left");
      style.removeProperty("right");
      style.removeProperty("width");
      style.removeProperty("max-width");
      style.removeProperty("max-height");
      return;
    }
    const topbarBottom = document
      .querySelector(".topbar")
      .getBoundingClientRect().bottom;
    const top = Math.max(16, topbarBottom + 8);
    style.position = "fixed";
    style.top = `${Math.round(top)}px`;
    style.left = "1rem";
    style.right = "1rem";
    style.width = "auto";
    style.maxWidth = "none";
    style.maxHeight = `${Math.max(
      240,
      Math.round(window.innerHeight - top - 16)
    )}px`;
  }

  el.addToggle.addEventListener("click", () => {
    if (el.addPanel.hidden) openAddPanel();
    else closeAddPanel();
  });
  el.addClose.addEventListener("click", () => closeAddPanel());
  el.addCancel.addEventListener("click", () => closeAddPanel());

  window.addEventListener("resize", () => {
    if (!el.addPanel.hidden) positionAddPanel();
  });

  el.addMeter.addEventListener("change", () => {
    lastSelectedMeter = el.addMeter.value;
    syncAddTokenField(true);
    setAddStatus("");
  });

  el.addTokenClear.addEventListener("click", () => {
    const slug = el.addMeter.value;
    if (!slug) return;
    removeStoredToken(slug);
    syncAddTokenField(true);
    setAddStatus("Uložený token byl smazán.");
    el.addToken.focus();
  });

  el.addValueRange.addEventListener("input", () => {
    el.addValueNumber.value = Number(el.addValueRange.value).toFixed(2);
  });

  el.addValueNumber.addEventListener("input", () => {
    const value = Number(el.addValueNumber.value.replace(",", "."));
    if (Number.isFinite(value) && value >= 0 && value <= 1) {
      el.addValueRange.value = String(value);
    }
  });

  el.addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const slug = el.addMeter.value;
    const value = Number(el.addValueNumber.value.replace(",", "."));
    const comment = el.addComment.value.trim();
    const stored = readStoredToken(slug);
    const token = stored || el.addToken.value.trim();

    if (!slug) {
      setAddStatus("Vyberte měřidlo.", "error");
      return;
    }
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      setAddStatus("Hodnota musí být v rozsahu 0.00 až 1.00.", "error");
      el.addValueNumber.focus();
      return;
    }
    if (!token) {
      setAddStatus("Vložte token měřidla.", "error");
      el.addToken.focus();
      return;
    }

    setAddStatus("");
    el.addSubmit.disabled = true;
    el.addSubmit.textContent = "Ukládám…";

    try {
      const response = await fetch(
        `/api/meters/${encodeURIComponent(slug)}/readings`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Token": token,
          },
          body: JSON.stringify({
            value,
            ...(comment ? { comment } : {}),
          }),
        }
      );

      if (!response.ok) {
        let detail = "";
        try {
          const body = await response.json();
          if (typeof body.detail === "string") detail = body.detail;
        } catch (error) {
          /* use the generic message */
        }
        if (response.status === 401) {
          setAddStatus(
            stored
              ? "Uložený token je neplatný. Smažte ho a vložte nový."
              : "Token je neplatný.",
            "error"
          );
        } else if (response.status === 422) {
          setAddStatus(
            "Hodnotu nebo komentář server odmítl. Zkontrolujte je.",
            "error"
          );
        } else {
          setAddStatus(
            detail || `Uložení selhalo (HTTP ${response.status}).`,
            "error"
          );
        }
        return;
      }

      if (!stored) {
        writeStoredToken(slug, token);
        syncAddTokenField(true);
      }
      el.addComment.value = "";
      setAddStatus("Hodnota byla uložena.", "success");
      await refreshView();
    } catch (error) {
      console.error("Uložení hodnoty selhalo:", error);
      setAddStatus("Uložení se nepodařilo. Zkuste to znovu.", "error");
    } finally {
      el.addSubmit.textContent = "Uložit hodnotu";
      syncAddTokenField();
    }
  });

  document.addEventListener("click", (event) => {
    if (
      !el.addPanel.hidden &&
      event.target instanceof Element &&
      !event.target.closest(".add")
    ) {
      closeAddPanel(false);
    }
  });

  /* --------------------------------------------------------- overview UI */

  function makeNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function addMiniStat(container, label, value) {
    const item = makeNode("span");
    item.append(document.createTextNode(`${label} `));
    const strong = makeNode(
      "strong",
      null,
      Number.isFinite(value) ? value.toFixed(2) : "—"
    );
    item.append(strong);
    container.append(item);
  }

  function buildMeterCard(result) {
    const { meter, data, error } = result;
    const latest = data && data.latest ? data.latest : null;
    const stats = data ? data.stats : null;
    const points = data && Array.isArray(data.points) ? data.points : [];

    const card = makeNode("a", "card meter-card");
    card.href = `/m/${encodeURIComponent(meter.slug)}`;
    card.dataset.slug = meter.slug;
    card.setAttribute("aria-label", `Otevřít detail měřidla ${meter.name}`);
    if (meter.color) {
      card.classList.add("has-accent");
      card.style.setProperty("--meter-color", meter.color);
    }

    const head = makeNode("div", "meter-card-head");
    const heading = makeNode("div", "meter-card-heading");
    heading.append(makeNode("h3", "meter-card-title", meter.name));
    if (meter.description) {
      heading.append(
        makeNode("p", "meter-card-description", meter.description)
      );
    }
    const badge = makeNode("span", "badge");
    const badgeData = error
      ? { className: "badge--error", label: "chyba" }
      : badgeFor(latest ? latest.value : null);
    badge.className = `badge ${badgeData.className}`;
    badge.textContent = badgeData.label;
    head.append(heading, badge);

    const valueRow = makeNode("div", "meter-card-value");
    const value = makeNode("span", "value", latest ? latest.value.toFixed(2) : "—");
    if (latest) value.style.color = severityToken(latest.value);
    const age = makeNode(
      "span",
      "meter-card-age",
      latest ? formatAge(data.latest_age_seconds) : "zatím bez měření"
    );
    valueRow.append(value, age);

    const chartBox = makeNode("div", "meter-card-chart");
    const canvas = makeNode("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      `Graf měřidla ${meter.name} za posledních 24 hodin`
    );
    const empty = makeNode(
      "div",
      "meter-chart-empty",
      error
        ? "Data se nepodařilo načíst."
        : "Za posledních 24 hodin nejsou data."
    );
    empty.hidden = Boolean(points.length && !error);
    chartBox.append(canvas, empty);

    const foot = makeNode("div", "meter-card-foot");
    const statsBox = makeNode("div", "meter-card-stats");
    if (stats && stats.count > 0) {
      addMiniStat(statsBox, "min", stats.min);
      addMiniStat(statsBox, "průměr", stats.avg);
      addMiniStat(statsBox, "max", stats.max);
    } else {
      statsBox.textContent = "bez statistik";
    }
    const link = makeNode("span", "meter-card-link", "Detail →");
    foot.append(statsBox, link);

    card.append(head, valueRow, chartBox, foot);

    overviewCharts.push({
      canvas,
      points,
      windowEnd: data ? data.server_time : Date.now() / 1000,
      empty,
    });
    return card;
  }

  function renderOverview(results) {
    const activeSlug =
      document.activeElement instanceof Element
        ? document.activeElement.closest(".meter-card")?.dataset.slug
        : null;

    if (overviewObserver) overviewObserver.disconnect();
    overviewCharts.length = 0;

    const fragment = document.createDocumentFragment();
    results.forEach((result) => fragment.append(buildMeterCard(result)));
    el.meterGrid.replaceChildren(fragment);

    if (activeSlug) {
      const activeCard = el.meterGrid.querySelector(
        `.meter-card[data-slug="${activeSlug}"]`
      );
      if (activeCard) activeCard.focus({ preventScroll: true });
    }

    overviewObserver = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        const chart = overviewCharts.find(
          (item) => item.canvas === entry.target
        );
        if (chart) drawMiniChart(chart);
      });
    });
    overviewCharts.forEach((chart) => overviewObserver.observe(chart.canvas));
    overviewCharts.forEach(drawMiniChart);
  }

  function redrawOverview() {
    overviewCharts.forEach(drawMiniChart);
  }

  function drawMiniChart(chart) {
    const { canvas, points, windowEnd, empty } = chart;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !tokens.success) return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const plotW = Math.max(1, width - MINI_PAD.left - MINI_PAD.right);
    const plotH = Math.max(1, height - MINI_PAD.top - MINI_PAD.bottom);
    const yFor = (value) =>
      MINI_PAD.top + (1 - clamp(value, 0, 1)) * plotH;
    const plotRadius = parseFloat(tokens.radiusLg) || 8;
    const font = `500 12px ${tokens.fontSans}`;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(
      MINI_PAD.left,
      MINI_PAD.top,
      plotW,
      plotH,
      plotRadius
    );
    ctx.clip();
    ctx.fillStyle = tokens.surfaceLow;
    ctx.fillRect(MINI_PAD.left, MINI_PAD.top, plotW, plotH);

    const bands = ctx.createLinearGradient(
      0,
      MINI_PAD.top,
      0,
      MINI_PAD.top + plotH
    );
    bands.addColorStop(0, translucent(tokens.errorContainer, 0.42));
    bands.addColorStop(0.5, translucent(tokens.surfaceLow, 0));
    bands.addColorStop(1, translucent(tokens.successContainer, 0.42));
    ctx.fillStyle = bands;
    ctx.fillRect(MINI_PAD.left, MINI_PAD.top, plotW, plotH);
    ctx.restore();

    ctx.font = font;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    [0, 0.5, 1].forEach((value) => {
      const y = yFor(value);
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = tokens.outlineVariant;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(MINI_PAD.left, y + 0.5);
      ctx.lineTo(MINI_PAD.left + plotW, y + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = tokens.onSurfaceVariant;
      ctx.fillText(value.toFixed(2), MINI_PAD.left - 8, y);
    });

    if (!points.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    const span = HOURS * 3600;
    const start = windowEnd - span;
    const xFor = (t) =>
      MINI_PAD.left +
      clamp(((t - start) / span) * plotW, 0, plotW);

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(
      MINI_PAD.left,
      MINI_PAD.top,
      plotW,
      plotH,
      plotRadius
    );
    ctx.clip();
    ctx.beginPath();
    points.forEach((point, index) => {
      const x = xFor(point.t);
      const y = yFor(point.v);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(xFor(points[points.length - 1].t), MINI_PAD.top + plotH);
    ctx.lineTo(xFor(points[0].t), MINI_PAD.top + plotH);
    ctx.closePath();
    const area = ctx.createLinearGradient(
      0,
      MINI_PAD.top,
      0,
      MINI_PAD.top + plotH
    );
    area.addColorStop(0, translucent(tokens.errorContainer, 0.32));
    area.addColorStop(1, translucent(tokens.successContainer, 0.32));
    ctx.fillStyle = area;
    ctx.fill();
    ctx.restore();

    const line = ctx.createLinearGradient(
      0,
      MINI_PAD.top,
      0,
      MINI_PAD.top + plotH
    );
    line.addColorStop(0, tokens.error);
    line.addColorStop(0.5, tokens.secondary);
    line.addColorStop(1, tokens.success);
    ctx.beginPath();
    points.forEach((point, index) => {
      const x = xFor(point.t);
      const y = yFor(point.v);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = line;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  }

  async function loadOverview() {
    if (!el.meterGrid.childElementCount) {
      el.overviewStatus.hidden = false;
      el.overviewStatus.classList.remove("is-error");
      el.overviewStatus.textContent = "Načítám měřidla…";
    }

    try {
      const list = await fetchJSON("/api/meters");
      const meters = Array.isArray(list.meters) ? list.meters : [];
      knownMeters = meters;
      const results = await Promise.all(
        meters.map(async (meter) => {
          try {
            const data = await fetchJSON(
              `/api/meters/${encodeURIComponent(meter.slug)}/readings?hours=${HOURS}`
            );
            return { meter, data, error: null };
          } catch (error) {
            return { meter, data: null, error };
          }
        })
      );

      if (!meters.length) {
        if (overviewObserver) overviewObserver.disconnect();
        overviewCharts.length = 0;
        el.meterGrid.replaceChildren();
        el.meterCount.hidden = true;
        el.overviewEmpty.hidden = false;
        el.overviewStatus.hidden = true;
      } else {
        el.meterCount.textContent = meterCountLabel(meters.length);
        el.meterCount.hidden = false;
        el.overviewEmpty.hidden = true;
        el.overviewStatus.hidden = true;
        renderOverview(results);
      }
      el.overviewStatus.classList.remove("is-error");
      setRefresh(true);
    } catch (error) {
      console.error("Nepodařilo se načíst měřidla:", error);
      el.overviewStatus.hidden = false;
      el.overviewStatus.classList.add("is-error");
      el.overviewStatus.textContent = "Měřidla se nepodařilo načíst.";
      el.overviewStatus.title = error.message;
      setRefresh(false);
    }
  }

  function initOverview() {
    el.detailView.hidden = true;
    el.overviewView.hidden = false;
    currentMeterMeta = null;
    refreshView = loadOverview;
    document.body.classList.remove("has-meter-accent");
    document.body.style.removeProperty("--meter-color");
    document.title = "Přehled · Nahovnost metr";
    activeRedraw = redrawOverview;
    loadOverview();
    scheduleRefresh(loadOverview);
  }

  /* ---------------------------------------------------------- detail UI */

  let width = 0;
  let height = 0;
  const ctx = el.chart.getContext("2d");

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
    const left = clamp(x, tipWidth / 2 + 4, width - tipWidth / 2 - 4);
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
    if (index >= 0) {
      positionTooltip(index, x);
      showHoverInfo(state.points[index]);
    } else {
      el.tooltip.hidden = true;
      resetHoverInfo();
    }
  }

  function handleLeave() {
    if (state.hover === -1) return;
    state.hover = -1;
    el.tooltip.hidden = true;
    resetHoverInfo();
    drawChart();
  }

  const HOVER_IDLE = "Přejeďte grafem pro zobrazení komentáře.";

  function resetHoverInfo() {
    el.hoverMeta.textContent = "—";
    el.hoverText.textContent = HOVER_IDLE;
    el.hoverBox.classList.add("is-empty");
    el.hoverText.scrollTop = 0;
  }

  function showHoverInfo(point) {
    el.hoverMeta.textContent = `${point.v.toFixed(2)} · ${dateTimeFmt.format(
      new Date(point.t * 1000)
    )}`;
    el.hoverText.textContent = point.c ? point.c : "Bez komentáře.";
    el.hoverBox.classList.toggle("is-empty", !point.c);
    el.hoverText.scrollTop = 0;
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
    setRefresh(true);
  }

  async function loadDetail() {
    try {
      const data = await fetchJSON(
        `/api/meters/${encodeURIComponent(currentSlug)}/readings?hours=${HOURS}`
      );
      state.points = Array.isArray(data.points) ? data.points : [];
      state.stats = data.stats || null;
      state.latest = data.latest || null;
      state.windowEnd = data.server_time || Date.now() / 1000;
      state.fetchedAt = Date.now();
      state.hover = -1;
      el.tooltip.hidden = true;
      resetHoverInfo();

      el.detailContent.hidden = false;
      el.detailError.hidden = true;
      renderSummary();
      drawChart();
    } catch (error) {
      console.error("Nepodařilo se načíst data měřidla:", error);
      if (error.status === 404 || error.status === 503) {
        showDetailError(error);
      } else {
        setRefresh(false);
      }
    }
  }

  function showDetailError(error) {
    el.detailContent.hidden = true;
    el.detailError.hidden = false;
    el.detailErrorText.textContent =
      error.status === 404
        ? "Měřidlo s tímto slugem v konfiguraci neexistuje. Zkontrolujte meters.json."
        : error.message || "Zkontrolujte konfiguraci měřidel.";
    el.meterTitle.textContent = "Měřidlo";
    el.meterDescription.hidden = true;
    currentMeterMeta = null;
    document.body.classList.remove("has-meter-accent");
    document.body.style.removeProperty("--meter-color");
    document.title = "Měřidlo nenalezeno · Nahovnost metr";
    setRefresh(false, `Načtení selhalo ${timeFmt.format(new Date())}`);
  }

  async function initDetail() {
    el.overviewView.hidden = true;
    el.detailView.hidden = false;
    refreshView = loadDetail;
    activeRedraw = drawChart;

    new ResizeObserver(resize).observe(el.chart);
    el.chart.addEventListener("mousemove", handleMove);
    el.chartLive.addEventListener("mouseleave", handleLeave);
    el.chart.addEventListener(
      "touchstart",
      (event) => {
        if (!event.touches.length) return;
        const rect = el.chart.getBoundingClientRect();
        const x = event.touches[0].clientX - rect.left;
        const index = nearestPoint(x);
        state.hover = index;
        drawChart();
        if (index >= 0) {
          positionTooltip(index, x);
          showHoverInfo(state.points[index]);
        } else {
          el.tooltip.hidden = true;
          resetHoverInfo();
        }
      },
      { passive: true }
    );
    el.chart.addEventListener("touchend", () => {
      el.tooltip.hidden = true;
    });

    try {
      const meta = await fetchJSON(
        `/api/meters/${encodeURIComponent(currentSlug)}`
      );
      currentMeterMeta = meta;
      knownMeters = [meta];
      el.meterTitle.textContent = meta.name;
      if (meta.description) {
        el.meterDescription.textContent = meta.description;
        el.meterDescription.hidden = false;
      } else {
        el.meterDescription.hidden = true;
      }
      if (meta.color) {
        document.body.classList.add("has-meter-accent");
        document.body.style.setProperty("--meter-color", meta.color);
      } else {
        document.body.classList.remove("has-meter-accent");
        document.body.style.removeProperty("--meter-color");
      }
      document.title = `${meta.name} · Nahovnost metr`;
      el.detailError.hidden = true;
      el.detailContent.hidden = false;
      resize();
      await loadDetail();
      scheduleRefresh(loadDetail);
    } catch (error) {
      showDetailError(error);
    }
  }

  function scheduleRefresh(refresh) {
    window.setTimeout(async () => {
      if (!document.hidden) await refresh();
      scheduleRefresh(refresh);
    }, REFRESH_MS);
  }

  /* ----------------------------------------------------------------- init */

  syncThemeButton();
  readTokens();
  if (isDetail) initDetail();
  else initOverview();

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => activeRedraw());
  }
})();
