import { AUTH_START_URL } from "./config.js";

export function launchGoogleSignIn() {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: AUTH_START_URL, interactive: true },
      (redirectUrl) => {
        if (chrome.runtime.lastError || !redirectUrl) {
          reject(new Error(chrome.runtime.lastError?.message || "Sign-in was cancelled."));
          return;
        }
        const code = new URL(redirectUrl).searchParams.get("code");
        if (!code) {
          reject(new Error("No authorization code returned."));
          return;
        }
        resolve(code);
      }
    );
  });
}
