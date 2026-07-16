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
    "Feb 2026 -",
    "2020 - 2022",
    "Jan 2020 – Present",
    "ene 2024 - actualidad",
    "· 3 yrs",
    "Present",
  ]) {
    assert.equal(looksLikeDateRange(t), true, `expected date-like: ${t}`);
  }
  for (const t of ["Acme Corp", "VP, Marketing", "2020 Companies", "3M", "1-800-Flowers"]) {
    assert.equal(looksLikeDateRange(t), false, `expected NOT date-like: ${t}`);
  }
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
