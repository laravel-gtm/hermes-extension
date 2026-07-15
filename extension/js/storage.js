import { STORAGE_KEYS } from "./config.js";

export async function getSession() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.token,
    STORAGE_KEYS.user,
  ]);
  return {
    token: data[STORAGE_KEYS.token] || null,
    user: data[STORAGE_KEYS.user] || null,
  };
}

export async function setSession(token, user) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.token]: token,
    [STORAGE_KEYS.user]: user,
  });
}

export async function clearSession() {
  await chrome.storage.local.remove([STORAGE_KEYS.token, STORAGE_KEYS.user]);
}
