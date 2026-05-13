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

  const timeoutMs = Number(process.env.API_TIMEOUT_MS) || 60 * 1000;
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);

  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Cookie: `token=${token}`
    },
    body: JSON.stringify({ model, messages }),
    signal: ac.signal
  }).finally(() => clearTimeout(tid));

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
  return data?.choices?.[0]?.message?.content ?? data?.reply ?? null;
}

export async function generateImage(prompt, model = process.env.DEFAULT_MODEL) {
  const token = await getToken();
  const IMAGE_URL = process.env.SWU_IMAGE_URL || CHAT_URL; // fallback

  const timeoutMs = Number(process.env.API_TIMEOUT_MS) || 60 * 1000;
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);

  // New payload format: use chat-style messages with modalities
  const payload = {
    stream: false,
    model,
    modalities: ["image", "text"],
    messages: [
      {
        role: "user",
        content: prompt
      }
    ]
  };

  const res = await fetch(IMAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Cookie: `token=${token}`
    },
    body: JSON.stringify(payload),
    signal: ac.signal
  }).finally(() => clearTimeout(tid));

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Image request failed (${res.status}) ${text}`);
  }
  const data = await res.json().catch(() => null);

  // helper: search for image-like values in arbitrary response shapes
  function findImageInObj(obj, seen = new WeakSet()) {
    if (!obj) return null;
    if (typeof obj === "string") {
      const s = obj.trim();
      // try to parse JSON strings that may contain image fields
      if ((s.startsWith("{") || s.startsWith("[")) && s.length > 50) {
        try {
          const parsed = JSON.parse(s);
          return findImageInObj(parsed, seen);
        } catch (e) {
          // not JSON
        }
      }

      if (s.startsWith("data:")) return s;
      if (s.startsWith("http://") || s.startsWith("https://")) return s;
      // base64-only detection (naive): sufficiently long and base64 chars
      if (/^[A-Za-z0-9+/=\\r\\n]+$/.test(s) && s.length > 100) {
        return `data:image/png;base64,${s.replace(/\\s+/g, "")}`;
      }
      return null;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = findImageInObj(item, seen);
        if (found) return found;
      }
      return null;
    }

    if (typeof obj === "object") {
      if (seen.has(obj)) return null;
      seen.add(obj);

      // common paths
      if (obj.data && Array.isArray(obj.data) && obj.data.length) {
        for (const d of obj.data) {
          const f = findImageInObj(d, seen);
          if (f) return f;
        }
      }
      if (obj.choices && Array.isArray(obj.choices)) {
        for (const c of obj.choices) {
          const f = findImageInObj(c, seen);
          if (f) return f;
        }
      }

      for (const k of Object.keys(obj)) {
        const val = obj[k];
        // prefer obvious keys
        if (["b64_json", "b64", "base64", "image", "image_url", "url", "artifact", "artifacts", "image_data", "data"].includes(k)) {
          const found = findImageInObj(val, seen);
          if (found) return found;
        }
      }

      // fallback: scan all keys
      for (const k of Object.keys(obj)) {
        const found = findImageInObj(obj[k], seen);
        if (found) return found;
      }
    }
    return null;
  }

  if (data == null) {
    console.error("generateImage: upstream returned empty body");
    return null;
  }

  // quick checks for common shapes
  if (data.image) return { image: data.image, meta: data };
  if (data.images && Array.isArray(data.images) && data.images.length) return { image: data.images[0], meta: data };
  if (data?.choices?.[0]?.image) return { image: data.choices[0].image, meta: data };
  if (data?.choices?.[0]?.message?.content) return { image: data.choices[0].message.content, meta: data };

  const found = findImageInObj(data);
  if (found) return { image: found, meta: data };

  // no image found — log entire response for debugging
  console.error("generateImage: no image found in upstream response:", JSON.stringify(data).slice(0, 2000));
  return null;
}