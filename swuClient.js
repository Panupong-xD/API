import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const LOGIN_URL = "https://swuai.swu.ac.th/api/v1/auths/ldap";
const CHAT_URL = "https://swuai.swu.ac.th/api/chat/completions";

const TOKEN_FILE = "./token.json";
const TOKEN_EXPIRE = 60 * 60 * 1000; // 1 hour

let cachedToken = null;

// ---------------- SAVE TOKEN ----------------
function saveToken(token) {
  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify({ token, time: Date.now() }, null, 2)
  );
}

// ---------------- LOAD TOKEN ----------------
function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;

  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE));
  } catch {
    return null;
  }
}

// ---------------- LOGIN ----------------
export async function login() {
  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user: process.env.SWU_USER,
      password: process.env.SWU_PASSWORD
    })
  });

  console.log("LOGIN STATUS:", res.status);

  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("No token cookie returned");

  const token = cookie.split(";")[0].replace("token=", "");

  cachedToken = token;
  saveToken(token);

  return token;
}

// ---------------- GET TOKEN ----------------
export async function getToken() {
  if (cachedToken) return cachedToken;

  const cached = loadToken();

  if (cached && Date.now() - cached.time < TOKEN_EXPIRE) {
    cachedToken = cached.token;
    return cachedToken;
  }

  return await login();
}

// ---------------- CHAT ----------------
export async function chat(messages, model = "google/gemini-2.5-flash") {
  const token = await getToken();

  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Cookie: `token=${token}`
    },
    body: JSON.stringify({
      model,
      messages
    })
  });

  if (res.status === 401) {
    console.log("🔁 Token expired → re-login");
    await login();
    return chat(messages, model);
  }

  const data = await res.json();

  return data?.choices?.[0]?.message?.content;
}