// Injected into the active tab via chrome.scripting.executeScript, so this
// function must be fully self-contained: no closures over module state, no
// imports, nothing but DOM/window APIs. It runs in an isolated world against
// LinkedIn's real (obfuscated, frequently-changing) markup, so every step is
// wrapped defensively and every field degrades to null instead of throwing.
export function scrapeLinkedInProfile() {
  const clean = (value) => {
    const text = (value || "").replace(/\s+/g, " ").trim();
    return text || null;
  };

  const isNoiseText = (text, fullName) =>
    !text ||
    text === fullName ||
    /^\d+(st|nd|rd)\+?\s*degree connection$/i.test(text) ||
    /connections?$/i.test(text) ||
    /followers?$/i.test(text);

  function extractFullName() {
    try {
      const h1 = document.querySelector("main h1") || document.querySelector("h1");
      return clean(h1 && h1.textContent);
    } catch {
      return null;
    }
  }

  // LinkedIn's top card has no stable class names, but it consistently
  // orders plain-text leaves as: name (h1), headline, location, then
  // linked action/stat text (Connect, Message, "500+ connections", ...).
  // Reading leaf text nodes in DOM order and skipping anything inside an
  // <a>/<button> (the linked stats and actions) approximates that order
  // without depending on any specific class or attribute.
  function extractHeadlineAndLocation(fullName) {
    const empty = { headline: null, location: null };
    try {
      const h1 = document.querySelector("main h1") || document.querySelector("h1");
      if (!h1) return empty;

      const card = h1.closest("section") || h1.parentElement?.parentElement || h1.parentElement;
      if (!card) return empty;

      const leaves = Array.from(card.querySelectorAll("*")).filter(
        (el) => el.children.length === 0 && !el.closest("a") && !el.closest("button"),
      );

      const candidates = [];
      const seen = new Set();
      for (const el of leaves) {
        const text = clean(el.textContent);
        if (isNoiseText(text, fullName) || seen.has(text)) continue;
        seen.add(text);
        candidates.push(text);
      }

      return {
        headline: candidates[0] || null,
        location: candidates[1] || null,
      };
    } catch {
      return empty;
    }
  }

  function findExperienceSection() {
    try {
      const anchor = document.getElementById("experience");
      const anchorSection = anchor && (anchor.closest("section") || anchor.parentElement?.closest("section"));
      if (anchorSection) return anchorSection;

      const heading = Array.from(document.querySelectorAll("h2")).find(
        (el) => (clean(el.textContent) || "").toLowerCase() === "experience",
      );
      return (heading && heading.closest("section")) || null;
    } catch {
      return null;
    }
  }

  // LinkedIn sometimes groups multiple roles at the same company under one
  // top-level entry, with each role as its own nested <li>. Take the
  // outermost entry's company link (present either way) but the topmost
  // nested role's title/dates when a group is present.
  function extractMostRecentPosition() {
    try {
      const section = findExperienceSection();
      if (!section) return null;

      const list = section.querySelector("ul");
      const topEntry = list && list.querySelector("li");
      if (!topEntry) return null;

      const companyAnchor = topEntry.querySelector('a[href*="/company/"]');
      let companyUrl = null;
      if (companyAnchor && companyAnchor.href) {
        try {
          const parsed = new URL(companyAnchor.href);
          companyUrl = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
        } catch {
          companyUrl = companyAnchor.href;
        }
      }

      const nestedTopRole = topEntry.querySelector("ul li");
      const titleScope = nestedTopRole || topEntry;

      // LinkedIn duplicates visible text into aria-hidden spans (paired with
      // a visually-hidden accessible copy) for title, company, and dates —
      // these are the most stable hooks available short of exact class names.
      const boldCandidates = Array.from(titleScope.querySelectorAll('span[aria-hidden="true"]'))
        .map((el) => clean(el.textContent))
        .filter(Boolean);

      const title = boldCandidates[0] || null;

      let companyName = clean(companyAnchor && companyAnchor.textContent);
      if (companyName && title && companyName.includes(title)) {
        // The company anchor sometimes wraps the entire entry (title +
        // company + dates) rather than just the company name; fall back to
        // the next bold candidate, which is usually "Company · Employment type".
        companyName = (boldCandidates[1] || "").split("·")[0].trim() || null;
      }

      const dateCandidate = boldCandidates.find((text) => /\d{4}/.test(text) || /present/i.test(text));
      const dateRange = dateCandidate || null;
      const isCurrent = /present/i.test(dateRange || "");

      return {
        title,
        companyName: companyName || null,
        companyUrl,
        isCurrent,
        dateRange,
      };
    } catch {
      return null;
    }
  }

  const fullName = extractFullName();
  const { headline, location } = extractHeadlineAndLocation(fullName);
  const mostRecentPosition = extractMostRecentPosition();

  return { fullName, headline, location, mostRecentPosition };
}
