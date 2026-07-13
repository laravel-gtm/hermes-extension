export function isLinkedInProfileUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) return false;
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
