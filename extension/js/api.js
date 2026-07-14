import { BASE_URL, DEVICE_NAME } from "./config.js";

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

async function request(path, { method = "GET", token, body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

export async function submitProfile(token, url, page = null) {
  const { status, data } = await request("/api/extension/profiles", {
    method: "POST",
    token,
    body: { url, page },
  });
  return { status, data };
}
