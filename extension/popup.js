import { getSession, setSession, clearSession } from "./js/storage.js";
import { fetchMe, logout, submitProfile, UnauthorizedError } from "./js/api.js";
import { isLinkedInUrl, isLinkedInProfileUrl, normalizeProfileUrl } from "./js/linkedin.js";
import { scrapeLinkedInProfile } from "./js/scraper.js";

const states = {
  loading: document.getElementById("state-loading"),
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
};

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

async function getActiveTabUrl() {
  const tab = await getActiveTab();
  return tab?.url || "";
}

// Scraping is best-effort: LinkedIn's DOM is obfuscated and changes without
// notice, so any failure here (including on pages executeScript can't touch,
// e.g. chrome:// or a not-yet-loaded tab) must fall back to null rather than
// block the URL-only submission that already works today.
async function capturePageData(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: scrapeLinkedInProfile,
    });
    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}

async function handleUnauthorized() {
  await clearSession();
  showState("signedOut");
}

async function render() {
  showState("loading");

  const tabUrl = await getActiveTabUrl();

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
    showState("profile");
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
    const page = tab?.id != null ? await capturePageData(tab.id) : null;
    const { status, data } = await submitProfile(token, url, page);

    if (status === 201) {
      showFeedback("Profile queued for Hermes.", "success");
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

render();
