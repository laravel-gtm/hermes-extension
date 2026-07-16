// LinkedIn profile capture.
//
// The scrape happens in two clearly separated halves so the fragile logic can
// be unit-tested without a browser:
//
//   1. collectProfileSignals() — INJECTED into the LinkedIn tab via
//      chrome.scripting.executeScript({ func }). Chrome serialises this
//      function with .toString() and runs it in the page's isolated world, so
//      it MUST be fully self-contained: no imports, no references to anything
//      in this module's scope, nothing but DOM/window APIs. Its only job is to
//      wait for the profile to hydrate and then harvest *raw material* —
//      LinkedIn's embedded Voyager JSON blobs plus a handful of raw DOM text
//      candidates. It does no interpretation, so it stays small and stable.
//
//   2. parseProfileFromRaw() and its helpers — PURE functions that run back in
//      the popup (normal module scope). They turn the raw material into the
//      final payload, preferring the structured Voyager JSON and falling back
//      to the DOM text, and they validate every field so garbage (a company
//      name that is really a date-range blob, a name with digits, …) degrades
//      to null instead of being emitted. Because they take plain
//      strings/objects, they are exercised directly against saved fixtures in
//      test/scraper.test.mjs.
//
// The payload shape returned by parseProfileFromRaw() is the contract the
// Hermes app consumes (see docs/api-contract.md):
//   { fullName, headline, location,
//     mostRecentPosition: { title, companyName, companyUrl, isCurrent, dateRange } | null }
// Every field is independently nullable except isCurrent, which is always a
// boolean.

// ---------------------------------------------------------------------------
// Injected collector (self-contained — do not reference module scope here)
// ---------------------------------------------------------------------------

// Runs in the LinkedIn page. Returns raw, un-interpreted signals; all parsing
// and validation happens later in parseProfileFromRaw(). Async so it can wait
// out lazy hydration — executeScript awaits the returned promise and hands the
// resolved value back as InjectionResult.result.
export async function collectProfileSignals() {
  const STEP_MS = 250;
  const MAX_ATTEMPTS = 16; // ~4s of hydration budget
  const MAX_BLOB_CHARS = 4_000_000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const clean = (value) => {
    const text = (value == null ? "" : String(value)).replace(/\s+/g, " ").trim();
    return text || null;
  };

  const profileSlug = () => {
    try {
      const match = (window.location.pathname || "").match(/\/in\/([^/]+)/i);
      return match ? decodeURIComponent(match[1]) : null;
    } catch {
      return null;
    }
  };

  // LinkedIn bootstraps Voyager API responses into <code> (and sometimes
  // <script type="application/json">) elements. Keep only blobs that look like
  // JSON and mention a relevant marker, so the payload shuttled back across the
  // executeScript boundary stays small.
  const collectVoyagerBlobs = () => {
    const blobs = [];
    try {
      const nodes = document.querySelectorAll('code, script[type="application/json"]');
      for (const node of nodes) {
        const text = node.textContent;
        if (!text) continue;
        const trimmed = text.trim();
        if (trimmed.length < 2 || trimmed.length > MAX_BLOB_CHARS) continue;
        if (trimmed[0] !== "{" && trimmed[0] !== "[") continue;
        if (!/firstName|com\.linkedin\.voyager|"included"|Position|publicIdentifier/.test(trimmed)) {
          continue;
        }
        blobs.push(trimmed);
      }
    } catch {
      // ignore — degrade to whatever we collected
    }
    return blobs;
  };

  const topCardH1 = () => {
    try {
      const h1 = document.querySelector("main h1") || document.querySelector("h1");
      return clean(h1 && h1.textContent);
    } catch {
      return null;
    }
  };

  // The top card orders plain-text leaves as name (h1), headline, location,
  // then linked actions/stats. Collect leaf text in DOM order, skipping links
  // and buttons; the pure layer applies noise filtering and picks headline vs
  // location. We only harvest here.
  const collectTopCard = () => {
    const result = { h1Text: null, leafTexts: [] };
    try {
      const h1 = document.querySelector("main h1") || document.querySelector("h1");
      if (!h1) return result;
      result.h1Text = clean(h1.textContent);

      const card =
        h1.closest("section") ||
        (h1.parentElement && h1.parentElement.parentElement) ||
        h1.parentElement;
      if (!card) return result;

      const leaves = Array.from(card.querySelectorAll("*")).filter(
        (el) => el.children.length === 0 && !el.closest("a") && !el.closest("button"),
      );
      for (const el of leaves) {
        const text = clean(el.textContent);
        if (text) result.leafTexts.push(text);
      }
    } catch {
      // ignore
    }
    return result;
  };

  const collectExperience = () => {
    const result = { boldTexts: [], companyAnchorText: null, companyHref: null };
    try {
      let section = null;
      const anchor = document.getElementById("experience");
      if (anchor) {
        section =
          anchor.closest("section") ||
          (anchor.parentElement && anchor.parentElement.closest("section"));
      }
      if (!section) {
        const heading = Array.from(document.querySelectorAll("h2")).find(
          (el) => (clean(el.textContent) || "").toLowerCase() === "experience",
        );
        section = heading ? heading.closest("section") : null;
      }
      if (!section) return result;

      const list = section.querySelector("ul");
      const topEntry = list && list.querySelector("li");
      if (!topEntry) return result;

      const companyAnchor = topEntry.querySelector('a[href*="/company/"]');
      if (companyAnchor) {
        result.companyAnchorText = clean(companyAnchor.textContent);
        result.companyHref = companyAnchor.href || null;
      }

      // A grouped multi-role entry nests each role in its own <li>; the topmost
      // nested role holds this entry's most-recent title/dates.
      const nestedTopRole = topEntry.querySelector("ul li");
      const scope = nestedTopRole || topEntry;

      // LinkedIn mirrors visible text into aria-hidden spans (paired with a
      // visually-hidden accessible copy) — the most stable hook short of exact
      // class names.
      result.boldTexts = Array.from(scope.querySelectorAll('span[aria-hidden="true"]'))
        .map((el) => clean(el.textContent))
        .filter(Boolean);
    } catch {
      // ignore
    }
    return result;
  };

  // Consider the page ready once the top card has painted, or once bootstrap
  // JSON carrying a member name is present. The capture button can fire before
  // either is true on a cold/slow load, so poll briefly.
  const hydrated = () => {
    if (topCardH1()) return true;
    try {
      const nodes = document.querySelectorAll('code, script[type="application/json"]');
      for (const node of nodes) {
        if ((node.textContent || "").includes('"firstName"')) return true;
      }
    } catch {
      // ignore
    }
    return false;
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (hydrated()) break;
    await sleep(STEP_MS);
  }

  return {
    slug: profileSlug(),
    voyager: collectVoyagerBlobs(),
    topCard: collectTopCard(),
    experience: collectExperience(),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (testable — no DOM, no globals)
// ---------------------------------------------------------------------------

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function cleanText(value) {
  const text = (value == null ? "" : String(value)).replace(/\s+/g, " ").trim();
  return text || null;
}

// A date-range / tenure fragment. This is legitimate content for `dateRange`
// but is junk anywhere it does not belong (name, company, title). Catching it
// is what prevents the known production bug where companyName came back as
// "VP, MarketingFeb 2026 - Jun 2026 · 5 mos".
export function looksLikeDateRange(text) {
  if (!text) return false;
  const t = String(text);
  return (
    // "2020 - 2022", "2020 – Present", "ene 2024 - actualidad"
    (/\b\d{4}\b/.test(t) && /[-–—]|present|current|actualidad|heute|aujourd|至今/i.test(t)) ||
    // "· 5 mos", "· 3 yrs", localised month/year unit after a bullet
    /·\s*\d+\s*(mo|mos|month|months|yr|yrs|year|years|an|ans|mois|año|años|ano|anos)\b/i.test(t) ||
    // "Feb 2026 -", "Jan 2020 –"
    /^[A-Za-zÀ-ÿ.]{3,}\s+\d{4}\s*[-–—]/.test(t) ||
    /\bpresent\b/i.test(t)
  );
}

export function sanitizeName(value) {
  const t = cleanText(value);
  if (!t) return null;
  if (looksLikeDateRange(t)) return null;
  if (/\d/.test(t)) return null; // real member names don't carry digits
  if (t.includes("·")) return null; // a bullet means a compound blob, not a name
  if (t.length > 100) return null;
  return t;
}

export function sanitizeHeadline(value) {
  const t = cleanText(value);
  if (!t) return null;
  if (looksLikeDateRange(t)) return null; // a bare date range is never a headline
  if (t.length > 300) return null;
  return t;
}

export function sanitizeLocation(value) {
  const t = cleanText(value);
  if (!t) return null;
  if (looksLikeDateRange(t)) return null;
  if (/(^|\s)\d[\d,]*\+?\s*(connections?|followers?)$/i.test(t)) return null;
  if (/^(connections?|followers?)$/i.test(t)) return null;
  if (t.length > 120) return null;
  return t;
}

export function sanitizeTitle(value) {
  const t = cleanText(value);
  if (!t) return null;
  if (looksLikeDateRange(t)) return null;
  if (t.length > 200) return null;
  return t;
}

// Company names legitimately contain "·" only as a separator before the
// employment type ("Acme Corp · Full-time"); keep the part before it. Anything
// that still looks like a date range after that is junk.
export function sanitizeCompanyName(value, title) {
  let t = cleanText(value);
  if (!t) return null;
  if (t.includes("·")) {
    t = cleanText(t.split("·")[0]);
    if (!t) return null;
  }
  if (looksLikeDateRange(t)) return null;
  const cleanTitle = cleanText(title);
  if (cleanTitle && t === cleanTitle) return null;
  // The anchor sometimes wraps the whole entry (title + company + dates);
  // reject an over-long value that swallows the title.
  if (cleanTitle && t.includes(cleanTitle) && t.length > cleanTitle.length + 40) return null;
  if (/\d/.test(t) && looksLikeDateRange(t)) return null;
  if (t.length > 120) return null;
  return t;
}

// "Present" is English-only; a completed range always carries two years, so a
// single year is the locale-independent signal that a role is ongoing
// ("ene 2024 - actualidad"). Prefer an explicit boolean (from Voyager's
// endDate presence) when we have one.
export function deriveIsCurrent(dateRange, explicit) {
  if (typeof explicit === "boolean") return explicit;
  if (!dateRange) return false;
  if (/present|current|actualidad|heute|aujourd|ongoing|至今/i.test(dateRange)) return true;
  const years = (dateRange.match(/\d{4}/g) || []).length;
  return years === 1;
}

function formatYearMonth(ym) {
  if (!ym || !ym.year) return null;
  const month = ym.month ? MONTHS[ym.month - 1] || "" : "";
  return (month ? `${month} ` : "") + ym.year;
}

export function buildDateRange(start, end) {
  const startText = formatYearMonth(start);
  if (!startText) return null;
  const endText = end && end.year ? formatYearMonth(end) : "Present";
  return `${startText} - ${endText}`;
}

export function canonicalCompanyUrl(href) {
  if (!href) return null;
  try {
    const url = new URL(href, "https://www.linkedin.com");
    const host = url.hostname.replace(/^www\./i, "");
    if (!/(^|\.)linkedin\.com$/i.test(host)) return null;
    if (!/\/company\//i.test(url.pathname)) return null;
    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Voyager JSON extraction (pure)
// ---------------------------------------------------------------------------

// Walk every parsed blob and collect every object carrying a $type. Bounded in
// depth and count so a pathological payload can't hang the popup.
function collectModels(blobs) {
  const models = [];
  const MAX_MODELS = 60000;
  const MAX_DEPTH = 8;

  const walk = (node, depth) => {
    if (!node || depth > MAX_DEPTH || models.length >= MAX_MODELS) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node === "object") {
      if (typeof node.$type === "string") models.push(node);
      for (const key in node) {
        const value = node[key];
        if (value && typeof value === "object") walk(value, depth + 1);
      }
    }
  };

  for (const blob of blobs || []) {
    let json;
    try {
      json = JSON.parse(blob);
    } catch {
      continue;
    }
    walk(json, 0);
  }
  return models;
}

function indexByUrn(models) {
  const byUrn = new Map();
  for (const model of models) {
    const urn = model.entityUrn;
    if (typeof urn === "string" && !byUrn.has(urn)) byUrn.set(urn, model);
  }
  return byUrn;
}

function pickProfile(models, slug) {
  const profiles = models.filter(
    (m) =>
      typeof m.$type === "string" &&
      /(^|\.)(Mini)?Profile$/.test(m.$type) &&
      (m.firstName || m.lastName),
  );
  if (!profiles.length) return null;

  if (slug) {
    const bySlug = profiles.find(
      (p) => (p.publicIdentifier || "").toLowerCase() === slug.toLowerCase(),
    );
    if (bySlug) return bySlug;
  }
  // Prefer a full Profile carrying a headline over a MiniProfile.
  return (
    profiles.find((p) => p.$type.endsWith(".Profile") && p.headline != null) ||
    profiles.find((p) => p.$type.endsWith(".Profile")) ||
    profiles[0]
  );
}

function resolveGeoLocation(profile, byUrn) {
  const ref =
    profile["*geoLocation"] ||
    profile.geoLocationUrn ||
    profile["*profileGeoLocation"] ||
    profile["*location"];
  const model = typeof ref === "string" ? byUrn.get(ref) : null;
  const candidates = [model, profile.geoLocation, profile.location].filter(Boolean);
  for (const candidate of candidates) {
    const raw =
      (candidate.defaultLocalizedName && candidate.defaultLocalizedName.value) ||
      candidate.defaultLocalizedName ||
      (candidate.geo &&
        candidate.geo.defaultLocalizedName &&
        candidate.geo.defaultLocalizedName.value) ||
      candidate.name;
    const cleaned = sanitizeLocation(typeof raw === "string" ? raw : raw && raw.value);
    if (cleaned) return cleaned;
  }
  return null;
}

function resolveCompanyUrl(position, byUrn) {
  const ref = position["*company"] || position.companyUrn || position["*companyUrn"];
  const model = typeof ref === "string" ? byUrn.get(ref) : null;
  const candidates = [model, position.company, position.companyResolutionResult].filter(Boolean);
  for (const candidate of candidates) {
    if (typeof candidate.url === "string") {
      const url = canonicalCompanyUrl(candidate.url);
      if (url) return url;
    }
    if (candidate.universalName) {
      return `https://www.linkedin.com/company/${encodeURIComponent(candidate.universalName)}`;
    }
    const urn = candidate.entityUrn || "";
    const idMatch = urn.match(/company:(\d+)/i);
    if (idMatch) return `https://www.linkedin.com/company/${idMatch[1]}`;
  }
  const refString = typeof ref === "string" ? ref : "";
  const idMatch = refString.match(/company:(\d+)/i);
  if (idMatch) return `https://www.linkedin.com/company/${idMatch[1]}`;
  return null;
}

function collectPositions(models, byUrn) {
  return models
    .filter(
      (m) =>
        typeof m.$type === "string" &&
        /Position$/.test(m.$type) &&
        (m.title || m.companyName),
    )
    .map((position) => {
      const period = position.timePeriod || position.dateRange || {};
      return {
        title: position.title,
        companyName: position.companyName,
        start: period.startDate || period.start || null,
        end: period.endDate || period.end || null,
        companyUrl: resolveCompanyUrl(position, byUrn),
      };
    });
}

export function pickMostRecentPosition(positions) {
  if (!positions.length) return null;
  const score = (position) => {
    const start = position.start;
    if (!start || !start.year) return -1;
    return start.year * 12 + (start.month || 0);
  };
  const current = positions.filter((p) => !p.end || !p.end.year);
  const pool = current.length ? current : positions;
  let best = pool[0];
  for (const position of pool) {
    if (score(position) > score(best)) best = position;
  }
  return best;
}

// Parse LinkedIn's embedded Voyager JSON blobs into a partial payload. Any
// field it can't confidently resolve is simply absent, so the DOM fallback can
// fill it in later. Never throws garbage — every field is validated.
export function parseVoyagerModels(blobs, slug) {
  const out = {};
  const models = collectModels(blobs);
  if (!models.length) return out;

  const byUrn = indexByUrn(models);

  const profile = pickProfile(models, slug);
  if (profile) {
    const name = [cleanText(profile.firstName), cleanText(profile.lastName)]
      .filter(Boolean)
      .join(" ");
    out.fullName = sanitizeName(name);
    out.headline = sanitizeHeadline(profile.headline || profile.occupation);
    out.location =
      sanitizeLocation(profile.geoLocationName || profile.locationName) ||
      resolveGeoLocation(profile, byUrn);
  }

  const best = pickMostRecentPosition(collectPositions(models, byUrn));
  if (best) {
    const title = sanitizeTitle(best.title);
    out.mostRecentPosition = {
      title,
      companyName: sanitizeCompanyName(best.companyName, best.title),
      companyUrl: best.companyUrl || null,
      isCurrent: !best.end || !best.end.year,
      dateRange: buildDateRange(best.start, best.end),
    };
  }

  return out;
}

// ---------------------------------------------------------------------------
// DOM fallback extraction (pure — operates on the collector's raw text)
// ---------------------------------------------------------------------------

function isNoiseText(text, fullName) {
  return (
    !text ||
    text === fullName ||
    /^\d+(st|nd|rd)\+?\s*degree connection$/i.test(text) ||
    /^·?\s*\d+(st|nd|rd|th)\+?$/i.test(text) ||
    /^\(?\s*(he|she|they|ze|xe|ey)\s*\/\s*[a-z]+\s*\)?$/i.test(text) ||
    /^contact info$/i.test(text) ||
    /connections?$/i.test(text) ||
    /followers?$/i.test(text)
  );
}

function pickHeadlineAndLocation(leafTexts, fullName) {
  const seen = new Set();
  const candidates = [];
  for (const raw of leafTexts || []) {
    const text = cleanText(raw);
    if (isNoiseText(text, fullName) || seen.has(text)) continue;
    seen.add(text);
    candidates.push(text);
  }
  return {
    headline: sanitizeHeadline(candidates[0]),
    location: sanitizeLocation(candidates[1]),
  };
}

function pickDomPosition(experience) {
  const bold = (experience.boldTexts || []).map(cleanText).filter(Boolean);
  const title = sanitizeTitle(bold[0]);

  let companyName = sanitizeCompanyName(experience.companyAnchorText, title);
  if (!companyName) companyName = sanitizeCompanyName(bold[1], title);

  const dateCandidate = bold.find((t) => /\d{4}/.test(t) || /present/i.test(t));
  const dateRange = cleanText(dateCandidate);
  const companyUrl = canonicalCompanyUrl(experience.companyHref);

  if (!title && !companyName && !dateRange && !companyUrl) return null;

  return {
    title,
    companyName,
    companyUrl,
    isCurrent: deriveIsCurrent(dateRange),
    dateRange,
  };
}

export function parseDomSignals(raw) {
  const out = {};
  const topCard = (raw && raw.topCard) || {};
  const fullName = sanitizeName(topCard.h1Text);
  out.fullName = fullName;

  const { headline, location } = pickHeadlineAndLocation(topCard.leafTexts, fullName);
  out.headline = headline;
  out.location = location;

  const position = pickDomPosition((raw && raw.experience) || {});
  if (position) out.mostRecentPosition = position;

  return out;
}

// ---------------------------------------------------------------------------
// Merge + entry point (pure)
// ---------------------------------------------------------------------------

function preferred(primary, fallback) {
  if (primary != null && primary !== "") return primary;
  return fallback != null ? fallback : null;
}

function mergePosition(primary, fallback) {
  const p = primary || {};
  const f = fallback || {};
  const hasPrimary = primary && (p.title || p.companyName || p.companyUrl || p.dateRange);
  const hasFallback = fallback && (f.title || f.companyName || f.companyUrl || f.dateRange);
  if (!hasPrimary && !hasFallback) return null;

  const title = preferred(p.title, f.title);
  const companyName = preferred(p.companyName, f.companyName);
  const companyUrl = preferred(p.companyUrl, f.companyUrl);
  const dateRange = preferred(p.dateRange, f.dateRange);

  let isCurrent;
  if (hasPrimary && typeof p.isCurrent === "boolean") isCurrent = p.isCurrent;
  else if (hasFallback && typeof f.isCurrent === "boolean") isCurrent = f.isCurrent;
  else isCurrent = deriveIsCurrent(dateRange);

  return { title, companyName, companyUrl, isCurrent: !!isCurrent, dateRange };
}

export function mergeProfile(primary, fallback) {
  const p = primary || {};
  const f = fallback || {};
  return {
    fullName: preferred(p.fullName, f.fullName),
    headline: preferred(p.headline, f.headline),
    location: preferred(p.location, f.location),
    mostRecentPosition: mergePosition(p.mostRecentPosition, f.mostRecentPosition),
  };
}

function emptyPayload() {
  return { fullName: null, headline: null, location: null, mostRecentPosition: null };
}

// Turn the collector's raw signals into the final payload. Voyager JSON is the
// primary source; the DOM text fills any gaps. Both halves are wrapped so a
// parse failure in one never blocks the other, and the whole thing degrades to
// an all-null payload rather than throwing.
export function parseProfileFromRaw(raw) {
  if (!raw || typeof raw !== "object") return emptyPayload();

  let voyager = {};
  try {
    voyager = parseVoyagerModels(raw.voyager || [], raw.slug || null);
  } catch {
    voyager = {};
  }

  let dom = {};
  try {
    dom = parseDomSignals(raw);
  } catch {
    dom = {};
  }

  return mergeProfile(voyager, dom);
}
