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
  // either is true on a cold/slow load, so poll briefly. On an SPA navigation
  // the *previous* person's bootstrap JSON can still be sitting in the DOM —
  // only treat that JSON as signalling hydration when it actually mentions the
  // slug we're currently on, so a stale blob doesn't stop the wait early and
  // get treated as authoritative for the new page.
  const hydrated = () => {
    if (topCardH1()) return true;
    try {
      const slug = profileSlug();
      const escapedSlug = slug && slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const publicIdentifier = escapedSlug
        ? new RegExp(`"publicIdentifier"\\s*:\\s*"${escapedSlug}"`, "i")
        : null;
      const nodes = document.querySelectorAll('code, script[type="application/json"]');
      for (const node of nodes) {
        const text = node.textContent || "";
        if (!text.includes('"firstName"')) continue;
        if (!slug || publicIdentifier.test(text)) return true;
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
  const month =
    "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|ene(?:ro)?)\\.?";
  const endpoint = `(?:${month}\\s+)?\\d{4}`;
  const present = "(?:present|current|actualidad|heute|aujourd|至今)";
  const range = new RegExp(
    `${endpoint}\\s*[-–—]\\s*(?:${endpoint}|${present})(?![A-Za-zÀ-ÿ])`,
    "iu",
  );
  const ongoing = new RegExp(`${endpoint}\\s+${present}(?![A-Za-zÀ-ÿ])`, "iu");

  return (
    // A dash is only date syntax when it joins two valid endpoints. A year and
    // an unrelated hyphen in a title ("Summer 2024 - Intern") are not enough.
    range.test(t) ||
    // Preserve localized ongoing ranges that omit the dash ("2024 actualidad").
    ongoing.test(t) ||
    // "· 5 mos", "· 3 yrs", localised month/year unit after a bullet
    /·\s*\d+\s*(mo|mos|month|months|yr|yrs|year|years|an|ans|mois|año|años|ano|anos)\b/i.test(t) ||
    // A bare "Present" with no adjoining year is still an unambiguous
    // ongoing-role marker.
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

function isProfileModelType(type) {
  return typeof type === "string" && /(^|\.)(Mini)?Profile$/.test(type);
}

// A SPA navigation can leave the previous person's bootstrap JSON sitting in
// the DOM. When we know which profile we're looking at (the URL slug), a
// blob that doesn't contain a matching publicIdentifier is not evidence about
// the current page at all — returning no profile (rather than guessing at
// any full Profile/MiniProfile present) is what lets the DOM fallback speak
// for the page actually being viewed instead of a stale, unrelated person.
function pickProfile(models, slug) {
  const profiles = models.filter(
    (m) => isProfileModelType(m.$type) && (m.firstName || m.lastName),
  );
  if (!profiles.length) return null;

  if (slug) {
    return (
      profiles.find(
        (p) => (p.publicIdentifier || "").toLowerCase() === slug.toLowerCase(),
      ) || null
    );
  }

  // No slug to check against (e.g. not on a /in/ page) — prefer a full
  // Profile carrying a headline over a MiniProfile.
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

function resolveCompanyModel(position, byUrn) {
  const ref = position["*company"] || position.companyUrn || position["*companyUrn"];
  const model = typeof ref === "string" ? byUrn.get(ref) : null;
  return { ref, model };
}

function resolveCompanyUrl(position, byUrn) {
  const { ref, model } = resolveCompanyModel(position, byUrn);
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

// A Position often carries only a *company URN with no inline companyName;
// the referenced MiniCompany model (already sitting in the same blob) is the
// authoritative source for the name in that case.
function resolveCompanyName(position, byUrn) {
  const { model } = resolveCompanyModel(position, byUrn);
  const candidates = [model, position.company, position.companyResolutionResult].filter(Boolean);
  for (const candidate of candidates) {
    const raw =
      candidate.name ||
      (candidate.defaultLocalizedName && candidate.defaultLocalizedName.value) ||
      candidate.defaultLocalizedName;
    if (typeof raw === "string" && raw.trim()) return raw;
  }
  return null;
}

function isPositionModelType(type) {
  return typeof type === "string" && /Position$/.test(type);
}

// Voyager reference containers show up either as a bare array of URNs/embedded
// objects, or as a paged `{ "*elements": [...] }` / `{ elements: [...] }`
// wrapper. Normalise both shapes to a plain array of refs.
function asRefList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value["*elements"])) return value["*elements"];
    if (Array.isArray(value.elements)) return value.elements;
  }
  return null;
}

const POSITION_CONTAINER_FIELDS = [
  "*profilePositionGroups",
  "profilePositionGroups",
  "*positionGroupView",
  "positionGroupView",
  "*positionView",
  "positionView",
  "*positions",
  "positions",
];

// Walk from a profile's position-reference fields (view/group/element URNs)
// down to the concrete Position models they point at. Bounded in depth and
// deduplicated by entityUrn so a cyclical or pathological payload can't hang.
function walkPositionRefs(value, byUrn, depth, visited, out) {
  if (value == null || depth > 6) return;
  const list = asRefList(value);
  if (list) {
    for (const item of list) walkPositionRefs(item, byUrn, depth + 1, visited, out);
    return;
  }
  const model = typeof value === "string" ? byUrn.get(value) : value;
  if (!model || typeof model !== "object") return;
  const urn = model.entityUrn;
  if (urn) {
    if (visited.has(urn)) return;
    visited.add(urn);
  }
  if (isPositionModelType(model.$type)) {
    out.push(model);
    return;
  }
  for (const field of POSITION_CONTAINER_FIELDS) {
    if (field in model) walkPositionRefs(model[field], byUrn, depth + 1, visited, out);
  }
}

// Only positions reachable from the selected profile's own position
// view/group/element references count as this person's positions — a
// bootstrap payload can carry stale models, "people also viewed" profiles, or
// other unrelated Position entities alongside the real one.
function reachablePositionModels(profile, models, byUrn) {
  const out = [];
  const visited = new Set();
  for (const field of POSITION_CONTAINER_FIELDS) {
    if (field in profile) walkPositionRefs(profile[field], byUrn, 0, visited, out);
  }
  if (out.length) return out;

  if (profile.entityUrn) {
    const byBacklink = models.filter(
      (m) =>
        isPositionModelType(m.$type) &&
        (m["*profile"] === profile.entityUrn || m.profileUrn === profile.entityUrn),
    );
    if (byBacklink.length) return byBacklink;
  }

  // No linkage in either direction means no trustworthy attribution. Even a
  // blob with one named profile can contain unrelated Position models without
  // their corresponding Profile models, so let the DOM fallback speak.
  return [];
}

function collectPositions(positionModels, byUrn) {
  return positionModels
    .filter((m) => m.title || m.companyName)
    .map((position) => {
      const period = position.timePeriod || position.dateRange || {};
      const start = period.startDate || period.start || null;
      const end = period.endDate || period.end || null;
      const hasStart = !!(start && start.year);
      const hasEnd = !!(end && end.year);
      return {
        title: position.title,
        companyName: position.companyName || resolveCompanyName(position, byUrn),
        start: hasStart ? start : null,
        end: hasEnd ? end : null,
        hasTimePeriod: hasStart || hasEnd,
        hasStart,
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
  // A position lacking timePeriod entirely is unknown, not current — only a
  // position we positively know has no end date belongs in the current pool.
  const current = positions.filter(
    (p) => (p.hasStart ?? !!(p.start && p.start.year)) && (!p.end || !p.end.year),
  );
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
  // No confident match for the page we're actually on (e.g. a stale blob left
  // over from an SPA navigation) — stay completely silent rather than borrow
  // a name or position from unrelated JSON, and let the DOM fallback speak
  // for the current page instead.
  if (!profile) return out;

  const name = [cleanText(profile.firstName), cleanText(profile.lastName)]
    .filter(Boolean)
    .join(" ");
  out.fullName = sanitizeName(name);
  out.headline = sanitizeHeadline(profile.headline || profile.occupation);
  out.location =
    sanitizeLocation(profile.geoLocationName || profile.locationName) ||
    resolveGeoLocation(profile, byUrn);

  const positions = collectPositions(reachablePositionModels(profile, models, byUrn), byUrn);
  const best = pickMostRecentPosition(positions);
  if (best) {
    const title = sanitizeTitle(best.title);
    out.mostRecentPosition = {
      title,
      companyName: sanitizeCompanyName(best.companyName, best.title),
      companyUrl: best.companyUrl || null,
      isCurrent: best.hasStart === true && (!best.end || !best.end.year),
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

// Headlines describe a role ("Software Engineer at Foo", "Founder, Acme") and
// almost always carry a role/company marker; genuine locations don't. Used to
// stop a lone location leaf from being promoted into the headline slot when
// the headline itself is simply absent.
const HEADLINE_MARKERS =
  /[@|]|\bat\b|\bfounder\b|\bceo\b|\bcto\b|\bcoo\b|\bvp\b|\bfreelance\b|\bengineer\b|\bdirector\b|\bmanager\b|\bpresident\b|\bconsultant\b|\bdeveloper\b|\bdesigner\b|\banalyst\b|\bspecialist\b|\bintern\b|\bstudent\b|\bowner\b|\blead\b|\bhead of\b/i;

function looksLikeLocationCandidate(text) {
  if (!text) return false;
  if (HEADLINE_MARKERS.test(text)) return false;
  if (/\barea$/i.test(text)) return true;
  const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return false;
  return parts.every(
    (part) => part.length <= 40 && /^[A-ZÀ-Ý][A-Za-zÀ-ÿ'.-]*(\s+[A-Za-zÀ-ÿ0-9'.-]+)*$/.test(part),
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
  if (!candidates.length) return { headline: null, location: null };

  const [first, second] = candidates;

  // The top card normally orders leaves as headline then location. When the
  // headline is missing, the leading (or only) leaf is the location itself —
  // detect that with a location-shaped discriminator instead of trusting
  // position, so a lone location is never promoted into the headline slot.
  if (looksLikeLocationCandidate(first) && !looksLikeLocationCandidate(second)) {
    return { headline: null, location: sanitizeLocation(first) };
  }

  return {
    headline: sanitizeHeadline(first),
    location: sanitizeLocation(second),
  };
}

function pickDomPosition(experience) {
  const bold = (experience.boldTexts || []).map(cleanText).filter(Boolean);
  const title = sanitizeTitle(bold[0]);

  let companyName = sanitizeCompanyName(experience.companyAnchorText, title);
  if (!companyName) companyName = sanitizeCompanyName(bold[1], title);

  // Only a candidate that actually matches a date-range/tenure grammar counts
  // — a bare four-digit substring (e.g. inside a title like "Summer 2024
  // Intern") must never be picked up as the role's dates.
  const dateCandidate = bold.find((t) => looksLikeDateRange(t));
  const dateRange = dateCandidate ? cleanText(dateCandidate) : null;
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

function wholePosition(position) {
  return {
    title: position.title ?? null,
    companyName: position.companyName ?? null,
    companyUrl: position.companyUrl ?? null,
    isCurrent: !!position.isCurrent,
    dateRange: position.dateRange ?? null,
  };
}

// Voyager and the DOM can each only describe one whole role at a time — never
// stitch a title from one source onto a company/date from the other, since
// they may legitimately describe two different positions (e.g. Voyager's
// latest-start side role vs. the DOM's top-rendered main role). Only fall
// back to the DOM position when Voyager gave no position at all.
function mergePosition(primary, fallback) {
  if (primary && (primary.title || primary.companyName || primary.companyUrl || primary.dateRange)) {
    return wholePosition(primary);
  }
  if (fallback && (fallback.title || fallback.companyName || fallback.companyUrl || fallback.dateRange)) {
    return wholePosition(fallback);
  }
  return null;
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
