import { DEFAULT_MODEL, isAllowedModel } from "../modelRegistry.js";

const fetchFn = globalThis.fetch;
if (!fetchFn) {
  throw new Error("Global fetch is not available. Run on Node 18+ or provide a fetch polyfill.");
}

let cachedToken = null;
let cachedTime = 0;
let loginPromise = null;

export async function login() {
  if (loginPromise) return loginPromise;
  loginPromise = doLogin();
  try {
    return await loginPromise;
  } finally {
    loginPromise = null;
  }
}

export async function getToken() {
  if (cachedToken && (Date.now() - cachedTime) < tokenExpireMs()) return cachedToken;
  return login();
}

export async function chat(messages, model = process.env.DEFAULT_MODEL || DEFAULT_MODEL) {
  const data = await chatCompletion({ messages, model });
  return extractAssistantContent(data);
}

export async function chatCompletion({ messages, model = process.env.DEFAULT_MODEL || DEFAULT_MODEL, tools, tool_choice: toolChoice }) {
  const resolvedModel = resolveModel(model);
  const token = await getToken();
  const body = {
    model: resolvedModel,
    messages
  };

  if (tools?.length) {
    body.tools = tools;
  }

  if (toolChoice) {
    body.tool_choice = toolChoice;
  }

  const res = await fetchWithTimeout(chatUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Cookie: `token=${token}`
    },
    body: JSON.stringify(body)
  });

  if (res.status === 401) {
    cachedToken = null;
    cachedTime = 0;
    await login();
    return chatCompletion({ messages, model, tools, tool_choice: toolChoice });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chat request failed (${res.status}) ${text}`);
  }

  return res.json().catch(() => null);
}

export async function generateImage(prompt, model = process.env.DEFAULT_MODEL) {
  const resolvedModel = resolveModel(model);
  const token = await getToken();
  const imageUrl = process.env.SWU_IMAGE_URL || chatUrl();

  const res = await fetchWithTimeout(imageUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Cookie: `token=${token}`
    },
    body: JSON.stringify({ model: resolvedModel, prompt, type: "image" })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Image request failed (${res.status}) ${text}`);
  }

  const data = await res.json().catch(() => null);
  return normalizeImageResponse(data);
}

function extractAssistantContent(data) {
  return data?.choices?.[0]?.message?.content ?? data?.reply ?? data?.response ?? null;
}

function normalizeImageResponse(data) {
  if (data == null) {
    console.error("generateImage: upstream returned empty body");
    return null;
  }

  if (data.image) return { image: data.image, meta: data };
  if (data.images && Array.isArray(data.images) && data.images.length) return { image: data.images[0], meta: data };
  if (data?.choices?.[0]?.image) return { image: data.choices[0].image, meta: data };
  if (data?.choices?.[0]?.message?.content) return { image: data.choices[0].message.content, meta: data };

  const found = findImageInObj(data);
  if (found) return { image: found, meta: data };

  console.error("generateImage: no image found in upstream response:", JSON.stringify(data).slice(0, 2000));
  return null;
}

function findImageInObj(obj, seen = new WeakSet()) {
  if (!obj) return null;

  if (typeof obj === "string") {
    const value = obj.trim();
    if (value.startsWith("data:")) return value;
    if (value.startsWith("http://") || value.startsWith("https://")) return value;
    if (/^[A-Za-z0-9+/=\\r\\n]+$/.test(value) && value.length > 100) {
      return `data:image/png;base64,${value.replace(/\\s+/g, "")}`;
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

    for (const key of Object.keys(obj)) {
      if (["b64_json", "b64", "base64", "image", "image_url", "url", "artifact", "artifacts", "image_data", "data", "choices"].includes(key)) {
        const found = findImageInObj(obj[key], seen);
        if (found) return found;
      }
    }

    for (const key of Object.keys(obj)) {
      const found = findImageInObj(obj[key], seen);
      if (found) return found;
    }
  }

  return null;
}

async function doLogin() {
  const user = process.env.SWU_USER;
  const password = process.env.SWU_PASSWORD;
  if (!user || !password) throw new Error("SWU credentials not set in environment");

  const res = await fetchWithTimeout(loginUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, password }),
    redirect: "manual"
  });

  if (!res.ok && res.status !== 302) {
    const text = await res.text().catch(() => "");
    throw new Error(`Login failed (${res.status}) ${text}`);
  }

  const cookie = res.headers.get("set-cookie");
  if (cookie) {
    const token = cookie.split(";")[0].replace("token=", "");
    if (!token) throw new Error("Token cookie malformed");
    cachedToken = token;
    cachedTime = Date.now();
    return cachedToken;
  }

  try {
    const json = await res.json();
    if (json?.token) {
      cachedToken = json.token;
      cachedTime = Date.now();
      return cachedToken;
    }
  } catch {
    // Ignore non-JSON login responses.
  }

  throw new Error("No token returned from login");
}

async function fetchWithTimeout(url, options) {
  const timeoutMs = Number(process.env.API_TIMEOUT_MS) || 60 * 1000;
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: ac.signal
    });
  } finally {
    clearTimeout(tid);
  }
}

function resolveModel(model) {
  if (isAllowedModel(model)) {
    return model;
  }

  if (isAllowedModel(process.env.DEFAULT_MODEL)) {
    return process.env.DEFAULT_MODEL;
  }

  return DEFAULT_MODEL;
}

function loginUrl() {
  return process.env.SWU_LOGIN_URL || "https://swuai.swu.ac.th/api/v1/auths/ldap";
}

function chatUrl() {
  return process.env.SWU_CHAT_URL || "https://swuai.swu.ac.th/api/chat/completions";
}

function tokenExpireMs() {
  return Number(process.env.TOKEN_EXPIRE_MS) || 60 * 60 * 1000;
}
