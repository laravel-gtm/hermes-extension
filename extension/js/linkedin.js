export function isLinkedInUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)linkedin\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

export function isLinkedInProfileUrl(url) {
  try {
    const parsed = new URL(url);
    // Mirror the server's validation: https only, base or www host. Other
    // subdomains (uk.linkedin.com, …) are rejected server-side, so don't
    // offer the add button for them.
    if (parsed.protocol !== "https:") return false;
    if (!/^(www\.)?linkedin\.com$/i.test(parsed.hostname)) return false;
    return /^\/in\/[^/]+/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function normalizeProfileUrl(url) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/in\/([^/]+)/i);
  if (!match) return null;
  const slug = match[1];
  return `https://www.linkedin.com/in/${slug}`;
}
