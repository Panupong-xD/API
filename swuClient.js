import fs from "fs";
import path from "path";

const __dirname = path.resolve();

const fetchFn = globalThis.fetch;
if (!fetchFn) {
  throw new Error("Global fetch is not available. Run on Node 18+ or provide a fetch polyfill.");
}

/* swuClient.js - stateless (memory-only token cache) */
const LOGIN_URL = process.env.SWU_LOGIN_URL || "https://swuai.swu.ac.th/api/v1/auths/ldap";
const CHAT_URL = process.env.SWU_CHAT_URL || "https://swuai.swu.ac.th/api/chat/completions";
const TOKEN_EXPIRE_MS = Number(process.env.TOKEN_EXPIRE_MS) || 60 * 60 * 1000; // 1 hour

let cachedToken = null;
let cachedTime = 0;
let loginPromise = null;

async function _doLogin() {
  const user = process.env.SWU_USER;
  const password = process.env.SWU_PASSWORD;
  if (!user || !password) throw new Error("SWU credentials not set in environment");

  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, password }),
    redirect: "manual"
  });

  if (!res.ok && res.status !== 302) {
    const text = await res.text().catch(() => "");
    throw new Error(`Login failed (${res.status}) ${text}`);
  }

  // try cookie first
  const cookie = res.headers.get("set-cookie");
  if (cookie) {
    const token = cookie.split(";")[0].replace("token=", "");
    if (!token) throw new Error("Token cookie malformed");
    cachedToken = token;
    cachedTime = Date.now();
    return cachedToken;
  }

  // fallback: some endpoints return JSON { token: '...' }
  try {
    const json = await res.json();
    if (json && json.token) {
      cachedToken = json.token;
      cachedTime = Date.now();
      return cachedToken;
    }
  } catch (e) {
    // ignore
  }

  throw new Error("No token returned from login");
}

export async function login() {
  if (loginPromise) return loginPromise;
  loginPromise = _doLogin();
  try {
    const t = await loginPromise;
    return t;
  } finally {
    loginPromise = null;
  }
}

export async function getToken() {
  if (cachedToken && (Date.now() - cachedTime) < TOKEN_EXPIRE_MS) return cachedToken;
  return await login();
}

export async function chat(messages, model = process.env.DEFAULT_MODEL || "google/gemini-2.5-flash") {
  const token = await getToken();

  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Cookie: `token=${token}`
    },
    body: JSON.stringify({ model, messages }),
    // Cloud Run will manage timeouts; keep client-side reasonable
  });

  if (res.status === 401) {
    cachedToken = null;
    cachedTime = 0;
    await login();
    return chat(messages, model);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chat request failed (${res.status}) ${text}`);
  }

  const data = await res.json().catch(() => null);
  return data?.choices?.[0]?.message?.content ?? null;
}