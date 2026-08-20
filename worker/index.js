/**
 * The Midnight Pantry — combined Cloudflare Worker.
 *
 * Two jobs, one deploy:
 *   1. Site-wide login gate: everything except /api/recipes* requires a
 *      signed session cookie (set via POST /__login with SITE_PASSWORD).
 *      Once authed, the Worker reads the requested file straight out of
 *      the (private) GitHub repo via raw.githubusercontent.com with the
 *      same token used for writes, and serves it directly — there is no
 *      separate public GitHub Pages copy to route around. The repo MUST
 *      be private for this to actually gate anything; on a public repo,
 *      raw.githubusercontent.com would serve the same files to anyone
 *      without a token at all.
 *   2. Shared recipe library write API: POST/PUT/DELETE /api/recipes[...]
 *      checks an X-Site-Password header (same password) and commits
 *      changes to data/recipes.json in the repo via GitHub's Contents API.
 *
 * Required secrets (Settings -> Variables and Secrets on the Worker):
 *   SITE_PASSWORD  - the one password for both login and recipe writes
 *   SESSION_SECRET - long random string, signs the login session cookie
 *   GITHUB_TOKEN   - fine-grained PAT, Contents: Read and write, scoped
 *                    to just this one (private) repo
 *   GITHUB_REPO    - "owner/repo", e.g. "themprog/DApp-MealPlanning"
 *   GITHUB_BRANCH  - branch to read pages from / commit recipe changes to
 * Optional:
 *   RECIPES_PATH   - path to the recipes JSON in the repo (defaults below)
 */

const DEFAULT_RECIPES_PATH = "data/recipes.json";
const MIME_TYPES = {
  html: "text/html; charset=utf-8",
  json: "application/json",
  webmanifest: "application/manifest+json",
  js: "application/javascript",
  css: "text/css",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};
function mimeFor(path) {
  if (path === "manifest.json") return "application/manifest+json";
  const ext = path.split(".").pop().toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Site-Password",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    if (url.pathname.startsWith("/api/recipes")) {
      return handleRecipeApi(request, url, env, cors);
    }
    return handleSiteGate(request, url, env);
  },
};

/* ---------- site-wide login gate + serving files straight from git ---------- */

async function handleSiteGate(request, url, env) {
  const cookie = request.headers.get("Cookie") || "";

  if (url.pathname === "/__login" && request.method === "POST") {
    const form = await request.formData();
    const pw = form.get("password") || "";
    if (pw === env.SITE_PASSWORD) {
      const token = await sign(env.SESSION_SECRET);
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie": `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
        },
      });
    }
    return loginPage("Wrong password. Try again.");
  }

  // the auth check always runs before anything else touches the cache or GitHub —
  // nothing below this line is reachable without a valid session cookie.
  if (!(await isAuthed(cookie, env.SESSION_SECRET))) {
    return loginPage();
  }

  let path = url.pathname.replace(/^\/+/, "");
  if (path === "") path = "index.html";

  // short-lived edge cache so a page with several assets (index.html, the
  // recipe library, icons) doesn't re-hit GitHub for every single request —
  // 30s is enough to dedupe a page load's own asset fetches without going
  // stale in any way a person would notice.
  const cache = caches.default;
  const cacheKey = new Request(new URL("/" + path, url.origin).toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const res = await fetchRepoFile(env, path);
  if (res.status === 404) return new Response("Not found", { status: 404 });
  if (!res.ok) return new Response("Upstream error: HTTP " + res.status, { status: 502 });

  const body = await res.arrayBuffer();
  const response = new Response(body, {
    status: 200,
    headers: { "Content-Type": mimeFor(path), "Cache-Control": "public, max-age=30" },
  });
  await cache.put(cacheKey, response.clone());
  return response;
}

async function fetchRepoFile(env, path) {
  const rawUrl = `https://raw.githubusercontent.com/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/${path}`;
  return fetch(rawUrl, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "midnight-pantry-worker" },
  });
}

function loginPage(error) {
  return new Response(
    `<!doctype html><html><body style="font-family:sans-serif;background:#14111C;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
      <form method="POST" action="/__login" style="background:#1E1A29;padding:24px;border-radius:12px;width:280px;">
        <h2 style="margin-top:0;">The Midnight Pantry</h2>
        ${error ? `<p style="color:#f66;">${error}</p>` : ""}
        <input type="password" name="password" placeholder="Password" autofocus
          style="width:100%;padding:10px;margin-bottom:12px;border-radius:8px;border:1px solid #342C47;background:#262133;color:#eee;box-sizing:border-box;">
        <button style="width:100%;padding:10px;border-radius:8px;border:none;background:#B893E8;color:#160f1f;font-weight:700;">Enter</button>
      </form>
    </body></html>`,
    { status: 401, headers: { "Content-Type": "text/html" } }
  );
}

async function sign(secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("authed"));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function isAuthed(cookieHeader, secret) {
  const match = cookieHeader.match(/session=([^;]+)/);
  if (!match) return false;
  return match[1] === (await sign(secret));
}

/* ---------- recipe library write API ---------- */

async function handleRecipeApi(request, url, env, cors) {
  const password = request.headers.get("X-Site-Password") || "";
  if (!env.SITE_PASSWORD || password !== env.SITE_PASSWORD) {
    return json({ error: "Wrong password" }, 401, cors);
  }
  try {
    if (request.method === "POST" && url.pathname === "/api/recipes") {
      return await addRecipe(await request.json(), env, cors);
    }
    const importId = url.pathname.startsWith("/api/recipes/")
      ? decodeURIComponent(url.pathname.slice("/api/recipes/".length))
      : null;
    if (request.method === "PUT" && importId) return await updateRecipe(importId, await request.json(), env, cors);
    if (request.method === "DELETE" && importId) return await deleteRecipe(importId, env, cors);
  } catch (e) {
    return json({ error: e.message }, 500, cors);
  }
  return json({ error: "Method not allowed" }, 405, cors);
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });
}

const GH_API = "https://api.github.com";

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "midnight-pantry-worker",
  };
}

function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}
function b64DecodeUtf8(str) {
  const binary = atob(str.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function getRecipesFile(env) {
  const path = env.RECIPES_PATH || DEFAULT_RECIPES_PATH;
  const res = await fetch(
    `${GH_API}/repos/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`,
    { headers: ghHeaders(env) }
  );
  if (!res.ok) throw new Error("Couldn't read recipes.json from GitHub: HTTP " + res.status);
  const data = await res.json();
  return { content: JSON.parse(b64DecodeUtf8(data.content)), sha: data.sha, path };
}

async function putRecipesFile(env, content, sha, path, message) {
  const body = {
    message,
    content: b64EncodeUtf8(JSON.stringify(content)),
    sha,
    branch: env.GITHUB_BRANCH,
  };
  const res = await fetch(`${GH_API}/repos/${env.GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error("GitHub commit failed: HTTP " + res.status + " " + errText.slice(0, 200));
  }
  return await res.json();
}

async function addRecipe(recipe, env, cors) {
  if (!recipe || !recipe.name) return json({ error: "Recipe needs at least a name" }, 400, cors);
  const { content, sha, path } = await getRecipesFile(env);
  const importId = "user-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  content.unshift({ ...recipe, importId });
  await putRecipesFile(env, content, sha, path, `Add recipe: ${recipe.name}`);
  return json({ ok: true, importId }, 200, cors);
}

async function updateRecipe(importId, recipe, env, cors) {
  const { content, sha, path } = await getRecipesFile(env);
  const idx = content.findIndex(r => r.importId === importId);
  if (idx === -1) return json({ error: "No recipe with that importId" }, 404, cors);
  content[idx] = { ...content[idx], ...recipe, importId };
  await putRecipesFile(env, content, sha, path, `Update recipe: ${recipe.name || importId}`);
  return json({ ok: true }, 200, cors);
}

async function deleteRecipe(importId, env, cors) {
  const { content, sha, path } = await getRecipesFile(env);
  const next = content.filter(r => r.importId !== importId);
  if (next.length === content.length) return json({ error: "No recipe with that importId" }, 404, cors);
  await putRecipesFile(env, next, sha, path, `Remove recipe: ${importId}`);
  return json({ ok: true }, 200, cors);
}
