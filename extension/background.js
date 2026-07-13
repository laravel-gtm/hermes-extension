import { exchangeCode } from "./js/api.js";
import { launchGoogleSignIn } from "./js/auth.js";
import { setSession } from "./js/storage.js";

// The sign-in flow must run here, not in the popup: launchWebAuthFlow opens
// an auth window, which steals focus and makes Chrome close the popup —
// killing its JS context before the code can be exchanged and stored. The
// service worker survives that, so the session is saved even though the
// popup is gone by the time Google redirects back.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "hermes:sign-in") return undefined;

  (async () => {
    try {
      const code = await launchGoogleSignIn();
      const result = await exchangeCode(code);
      if (!result?.token) throw new Error("Sign-in failed. Please try again.");
      await setSession(result.token, result.user);
      sendResponse({ ok: true, user: result.user });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || "Sign-in failed. Please try again." });
    }
  })();

  return true; // keep the message channel open for the async response
});
