import fs from "fs";
import path from "path";

const __dirname = path.resolve();

const fetchFn = globalThis.fetch;
if (!fetchFn) {
  throw new Error("Global fetch is not available. Run on Node 18+ or provide a fetch polyfill.");
}

const LOGIN_URL = process.env.SWU_LOGIN_URL || "https://swuai.swu.ac.th/api/v1/auths/ldap";
const CHAT_URL = process.env.SWU_CHAT_URL || "https://swuai.swu.ac.th/api/chat/completions";

const TOKEN_FILE = path.join(__dirname, process.env.TOKEN_FILE || "token.json");
const TOKEN_EXPIRE = Number(process.env.TOKEN_EXPIRE_MS) || 60 * 60 * 1000; // 1 hour

let cachedToken = null;

function saveToken(token) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, time: Date.now() }, null, 2), { mode: 0o600 });
  } catch (err) {
    console.warn("Could not save token to disk:", err.message);
  }
}

function loadToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch (err) {
    console.warn("Could not read token file:", err.message);
    return null;
  }
}

export async function login() {
  const user = process.env.SWU_USER;
  const password = process.env.SWU_PASSWORD;

  if (!user || !password) throw new Error("SWU credentials not set in environment variables");

  const res = await fetchFn(LOGIN_URL, {
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
  if (!cookie) throw new Error("No token cookie returned from login");

  const token = cookie.split(";")[0].replace("token=", "");

  cachedToken = token;
  saveToken(token);

  return token;
}

export async function getToken() {
  if (cachedToken) return cachedToken;

  const cached = loadToken();
  if (cached && Date.now() - cached.time < TOKEN_EXPIRE) {
    cachedToken = cached.token;
    return cachedToken;
  }

  return await login();
}

export async function chat(messages, model = process.env.DEFAULT_MODEL || "google/gemini-2.5-flash") {
  const token = await getToken();

  const res = await fetchFn(CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Cookie: `token=${token}`
    },
    body: JSON.stringify({ model, messages }),
    timeout: 30_000
  });

  if (res.status === 401) {
    cachedToken = null; // force re-login
    await login();
    return chat(messages, model);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chat request failed (${res.status}) ${text}`);
  }

  const data = await res.json();

  return data?.choices?.[0]?.message?.content ?? null;
}