// Unit tests for the pure scraper logic. No DOM, no browser — the collector
// (collectProfileSignals) harvests raw signals in the page; everything tested
// here operates on plain strings/objects, so it runs under `node --test`.
//
//   npm test        # or: node --test

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseProfileFromRaw,
  parseVoyagerModels,
  parseDomSignals,
  mergeProfile,
  looksLikeDateRange,
  sanitizeName,
  sanitizeCompanyName,
  sanitizeLocation,
  sanitizeTitle,
  deriveIsCurrent,
  buildDateRange,
  canonicalCompanyUrl,
  pickMostRecentPosition,
  collectProfileSignals,
} from "../extension/js/scraper.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A realistic Voyager bootstrap blob: {data, included:[Profile, Positions,
// Company]}. Uses the older com.linkedin.voyager.identity.* $types.
function voyagerBlob() {
  return JSON.stringify({
    data: { "*elements": ["urn:li:fs_profile:ada-lovelace"] },
    included: [
      {
        $type: "com.linkedin.voyager.identity.profile.Profile",
        entityUrn: "urn:li:fs_profile:ada-lovelace",
        publicIdentifier: "ada-lovelace",
        firstName: "Ada",
        lastName: "Lovelace",
        headline: "Software Engineer at Foo",
        geoLocationName: "London, England, United Kingdom",
        "*positions": ["urn:li:fs_position:1", "urn:li:fs_position:2"],
      },
      {
        $type: "com.linkedin.voyager.identity.profile.Position",
        entityUrn: "urn:li:fs_position:1",
        title: "Senior Engineer",
        companyName: "Foo",
        companyUrn: "urn:li:fs_company:123",
        timePeriod: { startDate: { month: 2, year: 2026 } }, // no endDate => current
      },
      {
        $type: "com.linkedin.voyager.identity.profile.Position",
        entityUrn: "urn:li:fs_position:2",
        title: "Engineer",
        companyName: "Bar",
        companyUrn: "urn:li:fs_company:999",
        timePeriod: {
          startDate: { month: 1, year: 2020 },
          endDate: { month: 12, year: 2023 },
        },
      },
      {
        $type: "com.linkedin.voyager.entities.shared.MiniCompany",
        entityUrn: "urn:li:fs_company:123",
        name: "Foo",
        universalName: "foo",
      },
    ],
  });
}

// The known production failure: the company anchor's textContent was a
// title+company+daterange blob, and there was no page name.
function prodGarbageDom() {
  return {
    slug: "cynthiabellmcgillis",
    voyager: [], // SPA navigation: no bootstrap JSON present
    topCard: { h1Text: null, leafTexts: [] },
    experience: {
      boldTexts: [
        "VP, Marketing",
        "Acme Corp · Full-time",
        "Feb 2026 - Jun 2026 · 5 mos",
      ],
      companyAnchorText: "VP, MarketingFeb 2026 - Jun 2026 · 5 mos",
      companyHref: "https://www.linkedin.com/company/acme/",
    },
  };
}

// A bootstrap payload carrying two people at once — e.g. Ada's own profile
// plus a "people also viewed" recommendation for Bob, each with their own
// current position. Only Ada's position is reachable from Ada's profile via
// *profilePositionGroups; Bob's is not referenced by Ada at all.
function voyagerBlobWithUnrelatedPerson() {
  return JSON.stringify({
    included: [
      {
        $type: "com.linkedin.voyager.identity.profile.Profile",
        entityUrn: "urn:li:fs_profile:ada-lovelace",
        publicIdentifier: "ada-lovelace",
        firstName: "Ada",
        lastName: "Lovelace",
        headline: "Engineer at AdaCo",
        "*profilePositionGroups": ["urn:li:fs_position:ada-1"],
      },
      {
        $type: "com.linkedin.voyager.identity.profile.Position",
        entityUrn: "urn:li:fs_position:ada-1",
        title: "CEO",
        companyName: "AdaCo",
        timePeriod: { startDate: { month: 1, year: 2020 } },
      },
      {
        $type: "com.linkedin.voyager.identity.profile.Profile",
        entityUrn: "urn:li:fs_profile:bob",
        publicIdentifier: "bob",
        firstName: "Bob",
        lastName: "Recommended",
      },
      {
        $type: "com.linkedin.voyager.identity.profile.Position",
        entityUrn: "urn:li:fs_position:bob-1",
        title: "CEO",
        companyName: "BobCo",
        // Later start date than Ada's — would win a global scan across all
        // Position models in the blob if positions weren't URN-scoped.
        timePeriod: { startDate: { month: 1, year: 2026 } },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Voyager extraction
// ---------------------------------------------------------------------------

test("parseVoyagerModels extracts clean fields from bootstrap JSON", () => {
  const out = parseVoyagerModels([voyagerBlob()], "ada-lovelace");
  assert.equal(out.fullName, "Ada Lovelace");
  assert.equal(out.headline, "Software Engineer at Foo");
  assert.equal(out.location, "London, England, United Kingdom");
  assert.ok(out.mostRecentPosition);
  assert.equal(out.mostRecentPosition.title, "Senior Engineer");
  assert.equal(out.mostRecentPosition.companyName, "Foo");
  assert.equal(out.mostRecentPosition.companyUrl, "https://www.linkedin.com/company/foo");
  assert.equal(out.mostRecentPosition.isCurrent, true);
  assert.equal(out.mostRecentPosition.dateRange, "Feb 2026 - Present");
});

test("parseVoyagerModels picks the current role over an older completed one", () => {
  const out = parseVoyagerModels([voyagerBlob()], null);
  assert.equal(out.mostRecentPosition.companyName, "Foo"); // not "Bar"
  assert.equal(out.mostRecentPosition.isCurrent, true);
});

test("parseVoyagerModels returns {} when no models are present", () => {
  assert.deepEqual(parseVoyagerModels(["not json"], null), {});
  assert.deepEqual(parseVoyagerModels([], null), {});
});

// ---------------------------------------------------------------------------
// Stale/wrong-person Voyager blobs (SPA navigation leaves the old bootstrap
// JSON in the DOM) must never be treated as authoritative for the new page.
// ---------------------------------------------------------------------------

test("parseVoyagerModels returns nothing when the slug matches nobody in the blob", () => {
  // The blob only describes ada-lovelace; the page has since navigated to a
  // different person entirely. No profile, no position — not Ada's.
  const out = parseVoyagerModels([voyagerBlob()], "brand-new-person");
  assert.deepEqual(out, {});
});

test("parseProfileFromRaw lets fresh DOM text correct a stale Voyager blob", () => {
  const raw = {
    slug: "brand-new-person",
    voyager: [voyagerBlob()], // stale: still describes ada-lovelace
    topCard: {
      h1Text: "New Person",
      leafTexts: ["New Person", "Founder at NewCo"],
    },
    experience: { boldTexts: [], companyAnchorText: null, companyHref: null },
  };
  const payload = parseProfileFromRaw(raw);
  assert.equal(payload.fullName, "New Person");
  assert.notEqual(payload.fullName, "Ada Lovelace");
});

test("parseVoyagerModels never attributes another profile's position to the selected one", () => {
  const out = parseVoyagerModels([voyagerBlobWithUnrelatedPerson()], "ada-lovelace");
  assert.equal(out.fullName, "Ada Lovelace");
  assert.ok(out.mostRecentPosition);
  assert.equal(out.mostRecentPosition.companyName, "AdaCo");
  assert.notEqual(out.mostRecentPosition.companyName, "BobCo");
});

test("a missing or empty timePeriod is treated as unknown, never current", () => {
  for (const timePeriod of [undefined, {}]) {
    const blob = JSON.stringify({
      included: [
        {
          $type: "com.linkedin.voyager.identity.profile.Profile",
          entityUrn: "urn:li:fs_profile:x",
          publicIdentifier: "x",
          firstName: "X",
          lastName: "Y",
          "*profilePositionGroups": ["urn:li:fs_position:1"],
        },
        {
          $type: "com.linkedin.voyager.identity.profile.Position",
          entityUrn: "urn:li:fs_position:1",
          title: "Advisor",
          companyName: "SomeCo",
          ...(timePeriod === undefined ? {} : { timePeriod }),
        },
      ],
    });
    const out = parseVoyagerModels([blob], "x");
    assert.ok(out.mostRecentPosition);
    assert.equal(out.mostRecentPosition.isCurrent, false);
    assert.equal(out.mostRecentPosition.dateRange, null);
  }
});

test("a lone MiniProfile never claims an unlinked position from the blob", () => {
  const blob = JSON.stringify({
    included: [
      {
        $type: "com.linkedin.voyager.identity.profile.MiniProfile",
        entityUrn: "urn:li:fs_miniProfile:target",
        publicIdentifier: "target",
        firstName: "Target",
        lastName: "Person",
      },
      {
        $type: "com.linkedin.voyager.identity.profile.Position",
        entityUrn: "urn:li:fs_position:wrong",
        title: "CEO",
        companyName: "WrongCo",
        timePeriod: { startDate: { year: 2026 } },
      },
    ],
  });

  const out = parseVoyagerModels([blob], "target");
  assert.equal(out.fullName, "Target Person");
  assert.equal(out.mostRecentPosition, undefined);
});

test("parseVoyagerModels resolves companyName from the referenced company model when missing inline", () => {
  const blob = JSON.stringify({
    included: [
      {
        $type: "com.linkedin.voyager.identity.profile.Profile",
        entityUrn: "urn:li:fs_profile:x",
        publicIdentifier: "x",
        firstName: "X",
        lastName: "Y",
        "*profilePositionGroups": ["urn:li:fs_position:1"],
      },
      {
        $type: "com.linkedin.voyager.identity.profile.Position",
        entityUrn: "urn:li:fs_position:1",
        title: "CTO",
        companyUrn: "urn:li:fs_company:1", // no inline companyName
        timePeriod: { startDate: { month: 1, year: 2026 } },
      },
      {
        $type: "com.linkedin.voyager.entities.shared.MiniCompany",
        entityUrn: "urn:li:fs_company:1",
        name: "Resolved Co",
        universalName: "resolvedco",
      },
    ],
  });
  const out = parseVoyagerModels([blob], "x");
  assert.equal(out.mostRecentPosition.companyName, "Resolved Co");
});

// ---------------------------------------------------------------------------
// Voyager-first: structured data wins over garbage DOM
// ---------------------------------------------------------------------------

test("Voyager data overrides garbage DOM signals", () => {
  const raw = { ...prodGarbageDom(), voyager: [voyagerBlob()], slug: "ada-lovelace" };
  const payload = parseProfileFromRaw(raw);
  assert.equal(payload.fullName, "Ada Lovelace");
  assert.equal(payload.mostRecentPosition.companyName, "Foo");
  assert.equal(payload.mostRecentPosition.companyUrl, "https://www.linkedin.com/company/foo");
});

// ---------------------------------------------------------------------------
// DOM fallback + the production failure
// ---------------------------------------------------------------------------

test("DOM fallback never emits the title+daterange blob as companyName", () => {
  const payload = parseProfileFromRaw(prodGarbageDom());
  const pos = payload.mostRecentPosition;
  assert.ok(pos);
  assert.equal(pos.title, "VP, Marketing");
  // The garbage anchor text is rejected; the clean company recovered from the
  // aria-hidden span fallback.
  assert.equal(pos.companyName, "Acme Corp");
  assert.ok(!/·\s*\d+\s*mos|Feb 2026 -/.test(pos.companyName || ""));
  assert.equal(pos.companyUrl, "https://www.linkedin.com/company/acme");
  assert.equal(pos.dateRange, "Feb 2026 - Jun 2026 · 5 mos");
  assert.equal(pos.isCurrent, false); // two years => completed
});

test("DOM fallback rejects garbage company even with no clean alternative", () => {
  const raw = {
    slug: "x",
    voyager: [],
    topCard: { h1Text: null, leafTexts: [] },
    experience: {
      boldTexts: ["VP, Marketing", "Feb 2026 - Jun 2026 · 5 mos"],
      companyAnchorText: "VP, MarketingFeb 2026 - Jun 2026 · 5 mos",
      companyHref: null,
    },
  };
  const pos = parseProfileFromRaw(raw).mostRecentPosition;
  assert.equal(pos.title, "VP, Marketing");
  assert.equal(pos.companyName, null); // null, never junk
});

test("DOM top card picks headline then location, skipping noise", () => {
  const raw = {
    slug: "ada",
    voyager: [],
    topCard: {
      h1Text: "Ada Lovelace",
      leafTexts: [
        "Ada Lovelace",
        "Ada Lovelace", // duplicate
        "1st degree connection",
        "She/Her",
        "Software Engineer at Foo",
        "London, England, United Kingdom",
        "500+ connections",
        "Contact info",
      ],
    },
    experience: { boldTexts: [], companyAnchorText: null, companyHref: null },
  };
  const payload = parseProfileFromRaw(raw);
  assert.equal(payload.fullName, "Ada Lovelace");
  assert.equal(payload.headline, "Software Engineer at Foo");
  assert.equal(payload.location, "London, England, United Kingdom");
});

test("a missing headline never promotes the location leaf into the headline slot", () => {
  const raw = {
    slug: "ada",
    voyager: [],
    topCard: {
      h1Text: "Ada Lovelace",
      leafTexts: ["Ada Lovelace", "San Francisco Bay Area", "500+ connections"],
    },
    experience: { boldTexts: [], companyAnchorText: null, companyHref: null },
  };
  const payload = parseProfileFromRaw(raw);
  assert.equal(payload.headline, null);
  assert.equal(payload.location, "San Francisco Bay Area");
});

test("pickDomPosition never derives dateRange/isCurrent from a bare four-digit title", () => {
  const raw = {
    slug: "x",
    voyager: [],
    topCard: { h1Text: null, leafTexts: [] },
    experience: {
      boldTexts: ["Summer 2024 Intern", "Acme", "May 2024 - Aug 2024 · 4 mos"],
      companyAnchorText: "Acme",
      companyHref: null,
    },
  };
  const pos = parseProfileFromRaw(raw).mostRecentPosition;
  assert.equal(pos.title, "Summer 2024 Intern");
  assert.equal(pos.dateRange, "May 2024 - Aug 2024 · 4 mos");
  assert.equal(pos.isCurrent, false); // a completed internship, not ongoing
});

test("pickDomPosition leaves dateRange null when nothing matches date-range grammar", () => {
  const raw = {
    slug: "x",
    voyager: [],
    topCard: { h1Text: null, leafTexts: [] },
    experience: {
      boldTexts: ["Co-Founder, Techstars 2024", "Techstars"],
      companyAnchorText: "Techstars",
      companyHref: null,
    },
  };
  const pos = parseProfileFromRaw(raw).mostRecentPosition;
  assert.equal(pos.title, "Co-Founder, Techstars 2024");
  assert.equal(pos.dateRange, null);
  assert.equal(pos.isCurrent, false);
});

test("a year-dash title is preserved and never treated as a date range", () => {
  const raw = {
    slug: "x",
    voyager: [],
    topCard: { h1Text: null, leafTexts: [] },
    experience: {
      boldTexts: ["Summer 2024 - Intern", "Acme"],
      companyAnchorText: "Acme",
      companyHref: null,
    },
  };

  const pos = parseProfileFromRaw(raw).mostRecentPosition;
  assert.equal(pos.title, "Summer 2024 - Intern");
  assert.equal(pos.dateRange, null);
  assert.equal(pos.isCurrent, false);
});

// ---------------------------------------------------------------------------
// Empty / defensive
// ---------------------------------------------------------------------------

test("parseProfileFromRaw degrades to all-null on empty/garbage input", () => {
  const empty = { fullName: null, headline: null, location: null, mostRecentPosition: null };
  assert.deepEqual(parseProfileFromRaw(null), empty);
  assert.deepEqual(parseProfileFromRaw(undefined), empty);
  assert.deepEqual(parseProfileFromRaw({}), empty);
  assert.deepEqual(parseProfileFromRaw("nope"), empty);
});

test("payload always keeps the exact contract shape", () => {
  const payload = parseProfileFromRaw(prodGarbageDom());
  assert.deepEqual(Object.keys(payload).sort(), [
    "fullName",
    "headline",
    "location",
    "mostRecentPosition",
  ]);
  assert.deepEqual(Object.keys(payload.mostRecentPosition).sort(), [
    "companyName",
    "companyUrl",
    "dateRange",
    "isCurrent",
    "title",
  ]);
  assert.equal(typeof payload.mostRecentPosition.isCurrent, "boolean");
});

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

test("looksLikeDateRange flags date/tenure fragments", () => {
  for (const t of [
    "Feb 2026 - Jun 2026 · 5 mos",
    "2020 - 2022",
    "Jan 2020 – Present",
    "ene 2024 - actualidad",
    "· 3 yrs",
    "Present",
  ]) {
    assert.equal(looksLikeDateRange(t), true, `expected date-like: ${t}`);
  }
  for (const t of [
    "Acme Corp",
    "VP, Marketing",
    "Feb 2026 -",
    "2020 Companies",
    "3M",
    "1-800-Flowers",
  ]) {
    assert.equal(looksLikeDateRange(t), false, `expected NOT date-like: ${t}`);
  }
});

test("looksLikeDateRange requires the year to participate in a real date-range pattern", () => {
  // The hyphen belongs to "Co-Founder" and has nothing to do with the year —
  // this must not be flagged just because both happen to appear somewhere.
  assert.equal(looksLikeDateRange("Co-Founder, Techstars 2024"), false);
  assert.equal(looksLikeDateRange("Ex-Google, Ex-Facebook (2015-2020)"), true); // a real range still matches
});

test("sanitizeTitle keeps a valid title with an unrelated hyphen and a year", () => {
  assert.equal(sanitizeTitle("Co-Founder, Techstars 2024"), "Co-Founder, Techstars 2024");
});

test("sanitizeCompanyName strips employment type and rejects date blobs", () => {
  assert.equal(sanitizeCompanyName("Acme Corp · Full-time", "VP"), "Acme Corp");
  assert.equal(sanitizeCompanyName("VP, MarketingFeb 2026 - Jun 2026 · 5 mos", "VP, Marketing"), null);
  assert.equal(sanitizeCompanyName("Feb 2026 - Jun 2026", null), null);
  assert.equal(sanitizeCompanyName("Foo", "Foo"), null); // equals title
  assert.equal(sanitizeCompanyName("2020 Companies", null), "2020 Companies"); // real company w/ digits
  assert.equal(sanitizeCompanyName("   ", null), null);
});

test("sanitizeName rejects digits, bullets and date ranges", () => {
  assert.equal(sanitizeName("Ada Lovelace"), "Ada Lovelace");
  assert.equal(sanitizeName("VP, Marketing · Feb 2026"), null);
  assert.equal(sanitizeName("Agent 47"), null);
  assert.equal(sanitizeName(""), null);
});

test("sanitizeLocation rejects connection/follower counts", () => {
  assert.equal(sanitizeLocation("San Francisco Bay Area"), "San Francisco Bay Area");
  assert.equal(sanitizeLocation("500+ connections"), null);
  assert.equal(sanitizeLocation("1,234 followers"), null);
});

test("sanitizeTitle keeps real titles, drops date ranges", () => {
  assert.equal(sanitizeTitle("Senior Staff Engineer, Level 3"), "Senior Staff Engineer, Level 3");
  assert.equal(sanitizeTitle("Feb 2026 - Present"), null);
});

test("deriveIsCurrent is locale-safe", () => {
  assert.equal(deriveIsCurrent(null, true), true); // explicit wins
  assert.equal(deriveIsCurrent("2020 - 2022", true), true); // explicit wins over text
  assert.equal(deriveIsCurrent("Jan 2020 - Present"), true);
  assert.equal(deriveIsCurrent("ene 2024 - actualidad"), true);
  assert.equal(deriveIsCurrent("2024"), true); // single year => ongoing
  assert.equal(deriveIsCurrent("2020 - 2022"), false);
  assert.equal(deriveIsCurrent(null), false);
});

test("buildDateRange formats month/year with a Present fallback", () => {
  assert.equal(buildDateRange({ month: 2, year: 2026 }, null), "Feb 2026 - Present");
  assert.equal(
    buildDateRange({ month: 1, year: 2020 }, { month: 12, year: 2023 }),
    "Jan 2020 - Dec 2023",
  );
  assert.equal(buildDateRange({ year: 2020 }, { year: 2022 }), "2020 - 2022");
  assert.equal(buildDateRange(null, null), null);
});

test("canonicalCompanyUrl normalizes and rejects non-company URLs", () => {
  assert.equal(
    canonicalCompanyUrl("https://www.linkedin.com/company/acme/"),
    "https://www.linkedin.com/company/acme",
  );
  assert.equal(canonicalCompanyUrl("/company/acme"), "https://www.linkedin.com/company/acme");
  assert.equal(canonicalCompanyUrl("https://www.linkedin.com/in/ada"), null);
  assert.equal(canonicalCompanyUrl("https://evil.com/company/acme"), null);
  assert.equal(canonicalCompanyUrl(null), null);
});

test("pickMostRecentPosition prefers current, then latest start", () => {
  const positions = [
    { title: "Old", start: { year: 2018, month: 1 }, end: { year: 2020, month: 1 } },
    { title: "Newer done", start: { year: 2021, month: 6 }, end: { year: 2024, month: 1 } },
    { title: "Current", start: { year: 2020, month: 3 }, end: null },
  ];
  assert.equal(pickMostRecentPosition(positions).title, "Current");
  assert.equal(pickMostRecentPosition([]), null);
});

test("mergeProfile prefers primary, fills gaps from fallback", () => {
  const primary = { fullName: "Ada Lovelace", headline: null, location: null };
  const fallback = {
    fullName: "Ignored",
    headline: "Engineer",
    location: "London",
    mostRecentPosition: { title: "Eng", companyName: "Foo", companyUrl: null, isCurrent: true, dateRange: null },
  };
  const merged = mergeProfile(primary, fallback);
  assert.equal(merged.fullName, "Ada Lovelace");
  assert.equal(merged.headline, "Engineer");
  assert.equal(merged.location, "London");
  assert.equal(merged.mostRecentPosition.companyName, "Foo");
});

test("mergeProfile never stitches a Voyager field onto a different DOM role", () => {
  // Voyager's latest-start side role has no companyName; the DOM's top entry
  // is a completely different main role at MainCo. The two must never blend.
  const primary = {
    mostRecentPosition: {
      title: "Side-job CTO",
      companyName: null,
      companyUrl: null,
      isCurrent: true,
      dateRange: "Jan 2026 - Present",
    },
  };
  const fallback = {
    mostRecentPosition: {
      title: "Chief Engineer",
      companyName: "MainCo",
      companyUrl: "https://www.linkedin.com/company/mainco",
      isCurrent: true,
      dateRange: "Jan 2020 - Present",
    },
  };
  const merged = mergeProfile(primary, fallback).mostRecentPosition;
  assert.equal(merged.title, "Side-job CTO");
  assert.equal(merged.companyName, null); // never borrowed from the unrelated DOM role
  assert.equal(merged.companyUrl, null);
  assert.equal(merged.dateRange, "Jan 2026 - Present");
});

test("mergePosition falls back to the whole DOM position only when Voyager gave none", () => {
  const fallback = {
    title: "Chief Engineer",
    companyName: "MainCo",
    companyUrl: "https://www.linkedin.com/company/mainco",
    isCurrent: true,
    dateRange: "Jan 2020 - Present",
  };
  const merged = mergeProfile({}, { mostRecentPosition: fallback }).mostRecentPosition;
  assert.deepEqual(merged, fallback);
});

// ---------------------------------------------------------------------------
// collectProfileSignals must survive the executeScript serialization
// boundary: Chrome calls .toString() on it and re-parses it in the page's
// isolated world, so it cannot close over anything in this module's scope.
// ---------------------------------------------------------------------------

test("collectProfileSignals stays self-contained across the executeScript serialization boundary", async () => {
  const source = collectProfileSignals.toString();
  // Reconstruct it exactly the way Chrome does: from its source text alone,
  // detached from every binding in this file. Any accidental reference to
  // outer module scope (a helper, an import) would throw here.
  const rebuilt = new Function(`return (${source});`)();

  const stubDocument = {
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
  };
  const stubWindow = { location: { pathname: "/in/ada-lovelace" } };

  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.window = stubWindow;
  globalThis.document = stubDocument;
  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };

  try {
    const result = await rebuilt();
    assert.equal(result.slug, "ada-lovelace");
    assert.deepEqual(result.voyager, []);
    assert.deepEqual(result.topCard, { h1Text: null, leafTexts: [] });
    assert.deepEqual(result.experience, { boldTexts: [], companyAnchorText: null, companyHref: null });
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("collectProfileSignals keeps waiting when stale JSON only mentions the current slug", async () => {
  const rebuilt = new Function(`return (${collectProfileSignals.toString()});`)();
  const staleBlob = JSON.stringify({
    included: [
      {
        $type: "com.linkedin.voyager.identity.profile.Profile",
        publicIdentifier: "old-person",
        firstName: "Old",
        lastName: "Person",
        trackingNote: "recommendation-for-new-person",
      },
    ],
  });

  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalSetTimeout = globalThis.setTimeout;
  let waits = 0;
  globalThis.window = { location: { pathname: "/in/new-person" } };
  globalThis.document = {
    querySelectorAll: (selector) =>
      selector === 'code, script[type="application/json"]' ? [{ textContent: staleBlob }] : [],
    querySelector: () => null,
    getElementById: () => null,
  };
  globalThis.setTimeout = (fn) => {
    waits += 1;
    fn();
    return 0;
  };

  try {
    const result = await rebuilt();
    assert.equal(waits, 16);
    assert.equal(result.slug, "new-person");
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.setTimeout = originalSetTimeout;
  }
});
