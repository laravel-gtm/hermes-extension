import { getSession, setSession, clearSession } from "./js/storage.js";
import {
  fetchMe,
  logout,
  submitProfile,
  checkVersion,
  createScreenshotUpload,
  uploadScreenshot,
  UnauthorizedError,
} from "./js/api.js";
import { isLinkedInUrl, isLinkedInProfileUrl, normalizeProfileUrl } from "./js/linkedin.js";
import { collectProfileSignals, parseProfileFromRaw, hasUsableProfileData } from "./js/scraper.js";

const FALLBACK_RELEASE_URL = "https://github.com/laravel-gtm/hermes-extension/releases/latest";

const states = {
  loading: document.getElementById("state-loading"),
  unsupported: document.getElementById("state-unsupported"),
  notLinkedIn: document.getElementById("state-not-linkedin"),
  signedOut: document.getElementById("state-signed-out"),
  noProfile: document.getElementById("state-no-profile"),
  profile: document.getElementById("state-profile"),
};

const els = {
  openLinkedInBtn: document.getElementById("open-linkedin-btn"),
  signInBtn: document.getElementById("sign-in-btn"),
  signOutBtn1: document.getElementById("sign-out-btn-1"),
  signOutBtn2: document.getElementById("sign-out-btn-2"),
  addProfileBtn: document.getElementById("add-profile-btn"),
  accountName1: document.getElementById("account-name-1"),
  accountEmail1: document.getElementById("account-email-1"),
  accountName2: document.getElementById("account-name-2"),
  accountEmail2: document.getElementById("account-email-2"),
  profileUrl: document.getElementById("profile-url"),
  feedback: document.getElementById("feedback"),
  getLatestBtn: document.getElementById("get-latest-btn"),
  previewStatus: document.getElementById("preview-status"),
  previewFields: document.getElementById("preview-fields"),
  previewName: document.getElementById("preview-name"),
  previewHeadline: document.getElementById("preview-headline"),
  previewLocation: document.getElementById("preview-location"),
  previewPosition: document.getElementById("preview-position"),
  screenshotStatus: document.getElementById("screenshot-status"),
};

// The capture chain kicked off when the popup opened on a profile: the DOM
// scrape (previewed for the rep's QC) plus the screenshot frames uploaded
// to object storage. The Add button submits exactly what this resolved to —
// { page, screenshots } — and the pipeline extracts profile data from the
// screenshots server-side after submission.
let pendingCapture = null;

function showState(name) {
  for (const [key, section] of Object.entries(states)) {
    section.hidden = key !== name;
  }
}

function showFeedback(message, kind) {
  els.feedback.textContent = message;
  els.feedback.className = `feedback ${kind}`;
  els.feedback.hidden = false;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Scraping is best-effort: LinkedIn's DOM is obfuscated and changes without
// notice, so any failure here (including on pages executeScript can't touch,
// e.g. chrome:// or a not-yet-loaded tab) must fall back to null rather than
// block the URL-only submission that already works today.
//
// The injected collector only harvests raw signals from the page; the parsing
// and validation run here in the popup (parseProfileFromRaw), where they're
// unit-tested. See extension/js/scraper.js.
async function capturePageData(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: collectProfileSignals,
    });
    const raw = results?.[0]?.result;
    return raw ? parseProfileFromRaw(raw) : null;
  } catch {
    return null;
  }
}

async function handleUnauthorized() {
  await clearSession();
  showState("signedOut");
}

// Injected into the page to position the viewport for a screenshot frame.
// Self-contained (serialized via executeScript) — no module scope access.
// LinkedIn's rebuilt UI scrolls an inner container inside an open shadow
// root, not the window, so when the document itself has nothing to scroll
// this hunts down the tallest scrollable element across document + open
// shadow roots and scrolls that instead.
function scrollForCapture(top) {
  const findScroller = () => {
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollHeight > doc.clientHeight + 10) return doc;

    const roots = [];
    const walk = (root) => {
      roots.push(root);
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    try {
      walk(document);
    } catch {
      return doc;
    }

    let best = doc;
    let bestOverflow = 0;
    for (const root of roots) {
      for (const el of root.querySelectorAll("*")) {
        const overflow = el.scrollHeight - el.clientHeight;
        if (overflow > bestOverflow && el.clientHeight > 200) {
          const style = getComputedStyle(el);
          if (/(auto|scroll|overlay)/.test(style.overflowY)) {
            best = el;
            bestOverflow = overflow;
          }
        }
      }
    }
    return best;
  };

  const el = findScroller();
  el.scrollTop = top;
  const isDocument = el === (document.scrollingElement || document.documentElement);
  return {
    top: el.scrollTop,
    viewport: isDocument ? window.innerHeight : el.clientHeight,
    max: el.scrollHeight,
  };
}

// Five frames ≈ 4.5 viewport-heights of profile — enough to reach the
// Experience section, which usually sits below Featured/Activity.
const SCREENSHOT_MAX_FRAMES = 5;
// captureVisibleTab is rate-limited (~2/sec) and lazy content needs a beat
// to paint after each scroll.
const SCREENSHOT_FRAME_DELAY_MS = 550;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Capture up to three sequential viewport screenshots (top of the profile
// first), scrolling ~90% of a viewport between frames and restoring the
// rep's scroll position afterwards. Returns JPEG blobs, [] on any failure.
async function captureScreenshotFrames(tabId) {
  const scrollTo = async (top) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: scrollForCapture,
      args: [top],
    });
    return results?.[0]?.result || null;
  };

  const frames = [];
  let originalTop = 0;
  try {
    const start = await scrollTo(0);
    if (!start) return [];
    originalTop = start.top;

    let previousTop = -1;
    for (let frame = 0; frame < SCREENSHOT_MAX_FRAMES; frame += 1) {
      const position = await scrollTo(frame * start.viewport * 0.9);
      if (!position || position.top === previousTop) break;
      previousTop = position.top;

      await sleep(SCREENSHOT_FRAME_DELAY_MS);
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 80 });
      frames.push(await (await fetch(dataUrl)).blob());

      // Bottom of the scroll container reached — nothing new below.
      if (position.top + position.viewport >= position.max - 10) break;
    }
  } catch {
    return [];
  } finally {
    try {
      await scrollTo(originalTop);
    } catch {
      // leave the page where it is
    }
  }
  return frames;
}

// Capture frames and upload each via a signed URL, returning the storage
// keys to reference in the submission. Extraction itself happens in the
// server-side pipeline after submit — the popup never waits on the vision
// model. Best-effort: any failure returns [] and the DOM/URL-only path
// proceeds as before.
async function captureAndUploadScreenshots(tabId) {
  try {
    const frames = await captureScreenshotFrames(tabId);
    if (!frames.length) return [];

    const { token } = await getSession();
    const keys = [];
    for (const blob of frames) {
      const upload = await createScreenshotUpload(token);
      if (!upload) break;
      if (await uploadScreenshot(upload.url, upload.headers, blob)) {
        keys.push(upload.key);
      }
    }
    return keys;
  } catch {
    return [];
  }
}

function renderScreenshotStatus(state, count = 0) {
  els.screenshotStatus.classList.remove("ok");
  els.screenshotStatus.hidden = false;
  if (state === "capturing") {
    els.screenshotStatus.textContent = "Capturing screenshots…";
  } else if (state === "attached") {
    els.screenshotStatus.textContent =
      `${count} screenshot${count === 1 ? "" : "s"} attached — Hermes extracts full details after submit.`;
    els.screenshotStatus.classList.add("ok");
  } else {
    els.screenshotStatus.textContent =
      "No screenshots captured — only the URL and details above will be sent.";
  }
}

function setPreviewField(el, value) {
  el.textContent = value || "—";
  el.classList.toggle("missing", !value);
}

function renderPreviewLoading() {
  els.previewStatus.textContent = "Reading profile…";
  els.previewStatus.classList.remove("warn");
  els.previewStatus.hidden = false;
  els.previewFields.hidden = true;
  els.screenshotStatus.hidden = true;
}

function describePosition(position) {
  if (!position) return null;
  const role = [position.title, position.companyName].filter(Boolean).join(" @ ");
  return [role, position.dateRange].filter(Boolean).join(" · ") || null;
}

// Fill the manual-QC preview with what was scraped, so the rep confirms the
// data before it is submitted. An unusable payload (which the backend would
// store as null anyway) becomes an explicit warning instead of a silent
// URL-only submission — the screenshot status line below says whether the
// pipeline will still extract details after submit.
function renderPreview(page) {
  if (!hasUsableProfileData(page)) {
    els.previewStatus.textContent = "Couldn't read the profile details from the page.";
    els.previewStatus.classList.add("warn");
    els.previewStatus.hidden = false;
    els.previewFields.hidden = true;
    return;
  }

  setPreviewField(els.previewName, page.fullName);
  setPreviewField(els.previewHeadline, page.headline);
  setPreviewField(els.previewLocation, page.location);
  setPreviewField(els.previewPosition, describePosition(page.mostRecentPosition));
  els.previewStatus.hidden = true;
  els.previewFields.hidden = false;
}

function showUnsupported(data) {
  const releaseUrl = data?.latest_release_url || FALLBACK_RELEASE_URL;
  els.getLatestBtn.onclick = () => {
    chrome.tabs.create({ url: releaseUrl });
    window.close();
  };
  showState("unsupported");
}

// Checked on every popup open. Fails open: any network error, timeout,
// non-200, or malformed body proceeds with the normal popup flow rather than
// bricking the popup because the version-check API is unreachable. Only an
// explicit 200 with supported === false blocks with the upgrade-only screen.
async function checkAndGateVersion() {
  try {
    const { status, data } = await checkVersion();
    if (status === 200 && data?.supported === false) {
      showUnsupported(data);
      return true;
    }
  } catch {
    // Fail open.
  }
  return false;
}

async function render() {
  showState("loading");

  const tab = await getActiveTab();
  const tabUrl = tab?.url || "";

  // The extension only does anything on LinkedIn — show the blank state
  // everywhere else, signed in or not.
  if (!isLinkedInUrl(tabUrl)) {
    showState("notLinkedIn");
    return;
  }

  const { token, user } = await getSession();

  if (!token) {
    showState("signedOut");
    return;
  }

  let freshUser = user;
  try {
    const me = await fetchMe(token);
    freshUser = me?.user || user;
    if (freshUser) await setSession(token, freshUser);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      await handleUnauthorized();
      return;
    }
    // Network/other error: fall back to cached user info rather than blocking the popup.
  }

  if (isLinkedInProfileUrl(tabUrl)) {
    els.accountName2.textContent = freshUser?.name || "";
    els.accountEmail2.textContent = freshUser?.email || "";
    els.profileUrl.textContent = normalizeProfileUrl(tabUrl);
    els.feedback.hidden = true;
    els.addProfileBtn.disabled = false;
    els.addProfileBtn.textContent = "Add profile to Hermes";
    renderPreviewLoading();
    showState("profile");

    // Capture as soon as the popup opens: the fast DOM scrape renders
    // immediately for the rep's QC, then screenshot frames upload in the
    // background and update the status line. The Add button submits
    // exactly what the finished chain resolves to; the pipeline extracts
    // profile data from the screenshots server-side. Guard against a
    // re-render (e.g. after sign-in) having started a newer capture.
    const capture = (async () => {
      if (tab?.id == null) return { page: null, screenshots: [] };
      const page = await capturePageData(tab.id);
      if (pendingCapture === capture) {
        renderPreview(page);
        renderScreenshotStatus("capturing");
      }
      const screenshots = await captureAndUploadScreenshots(tab.id);
      if (pendingCapture === capture) {
        renderScreenshotStatus(screenshots.length ? "attached" : "failed", screenshots.length);
      }
      return { page, screenshots };
    })();
    pendingCapture = capture;
  } else {
    els.accountName1.textContent = freshUser?.name || "";
    els.accountEmail1.textContent = freshUser?.email || "";
    showState("noProfile");
  }
}

els.openLinkedInBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.linkedin.com" });
  window.close();
});

els.signInBtn.addEventListener("click", () => {
  els.signInBtn.disabled = true;
  els.signInBtn.textContent = "Signing in…";

  // The flow runs in the background service worker: the auth window steals
  // focus and Chrome closes this popup, so any work here would die mid-flow.
  // The worker finishes the exchange and stores the session either way; if
  // this popup is still alive when it responds, re-render in place.
  chrome.runtime.sendMessage({ type: "hermes:sign-in" }, (response) => {
    if (response?.ok) {
      render();
      return;
    }

    els.signInBtn.disabled = false;
    els.signInBtn.textContent = "Sign in with Google";

    if (chrome.runtime.lastError || !response) {
      // Usually means the background service worker isn't registered —
      // e.g. the extension wasn't reloaded after an update.
      alert(
        `Couldn't reach the extension's background worker (${chrome.runtime.lastError?.message || "no response"}). ` +
          "Reload the extension from chrome://extensions and try again.",
      );
      return;
    }

    alert(response.error || "Sign-in failed. Please try again.");
  });
});

async function handleSignOut() {
  const { token } = await getSession();
  try {
    if (token) await logout(token);
  } catch {
    // Ignore errors revoking the token server-side; we still clear locally.
  }
  await clearSession();
  showState("signedOut");
}

els.signOutBtn1.addEventListener("click", handleSignOut);
els.signOutBtn2.addEventListener("click", handleSignOut);

els.addProfileBtn.addEventListener("click", async () => {
  els.addProfileBtn.disabled = true;
  els.addProfileBtn.textContent = "Adding…";
  els.feedback.hidden = true;
  try {
    const { token } = await getSession();
    const tab = await getActiveTab();
    const url = normalizeProfileUrl(tab?.url || "");
    // Submit the same payload the preview showed — the whole point of the
    // manual QC step — rather than scraping again behind the rep's back.
    const { page, screenshots } = pendingCapture
      ? await pendingCapture
      : { page: null, screenshots: [] };
    const { status, data } = await submitProfile(
      token,
      url,
      page,
      screenshots.length ? screenshots : null,
    );

    if (status === 201) {
      showFeedback("Profile queued for Hermes.", "success");
    } else if (status === 200 && data?.status === "unsupported_version") {
      // The backend bumped the supported floor while the popup was open.
      showUnsupported(data);
      return;
    } else if (status === 200) {
      showFeedback("Profile already added.", "duplicate");
    } else if (status === 422) {
      showFeedback(data?.message || "That doesn't look like a valid profile URL.", "error");
    } else {
      showFeedback("Something went wrong. Please try again.", "error");
    }
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      await handleUnauthorized();
      return;
    }
    showFeedback("Network error. Please try again.", "error");
  } finally {
    els.addProfileBtn.disabled = false;
    els.addProfileBtn.textContent = "Add profile to Hermes";
  }
});

(async () => {
  const gated = await checkAndGateVersion();
  if (!gated) render();
})();
