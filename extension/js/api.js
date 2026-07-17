import { BASE_URL, DEVICE_NAME } from "./config.js";

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

async function request(path, { method = "GET", token, body, signal } = {}) {
  const headers = {
    Accept: "application/json",
    "X-Hermes-Extension-Version": chrome.runtime.getManifest().version,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  if (response.status === 401) {
    throw new UnauthorizedError();
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return { status: response.status, data };
}

export async function exchangeCode(code) {
  const { data } = await request("/api/extension/auth/exchange", {
    method: "POST",
    body: { code, device_name: DEVICE_NAME },
  });
  return data;
}

export async function fetchMe(token) {
  const { data } = await request("/api/extension/me", { token });
  return data;
}

export async function logout(token) {
  await request("/api/extension/auth/logout", { method: "POST", token });
}

const VERSION_CHECK_TIMEOUT_MS = 3000;

// The popup gates on this call before rendering anything, so it must never
// hang: a slow or unresponsive server should fail open like any other error.
export async function checkVersion() {
  const version = encodeURIComponent(chrome.runtime.getManifest().version);
  const { status, data } = await request(`/api/extension/version?version=${version}`, {
    signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
  });
  return { status, data };
}

// Ask the API for a one-time signed URL to upload a screenshot frame to
// object storage. Returns { key, url, headers } or null.
export async function createScreenshotUpload(token) {
  const { status, data } = await request("/api/extension/screenshots", {
    method: "POST",
    token,
  });
  return status === 201 && data?.url && data?.key ? data : null;
}

// PUT one JPEG frame straight to object storage via the signed URL — the
// image bytes never pass through the Hermes app.
export async function uploadScreenshot(url, headers, blob) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg", ...(headers || {}) },
    body: blob,
  });
  return response.ok;
}

export async function submitProfile(token, url, page = null, screenshots = null) {
  const { status, data } = await request("/api/extension/profiles", {
    method: "POST",
    token,
    body: { url, page, screenshots },
  });
  return { status, data };
}
