# Publishing/removing recipes from the shared library (optional, not deployed yet)

The recipe library that ships to everyone lives in
[`data/recipes.json`](data/recipes.json) in this repo. The app itself can
only read that file — recipes you add or delete while using the app stay on
your own device (in the browser's local storage), same as always.

This document describes an *optional* add-on: a small Cloudflare Worker that
lets you publish or remove a recipe from that shared file directly from the
app's "Edit recipe" screen, protected by a password. Nothing here is
deployed yet — until you set it up, the "🔒 Publish to shared library" /
"🔒 Remove" buttons in the app will just show a "set this up in Settings
first" message.

## Why a Worker, and why a password

The site is public — anyone with the URL can open it and use it locally.
That's fine for browsing and for each person's own local recipes. But
`data/recipes.json` is the *one* copy of the library everyone gets, so
writes to it need to be:

1. **Gated** — so a random visitor can't vandalize or spam the shared list.
2. **Done through git** — so every change is a real, reversible commit, not
   a silent overwrite.

The app itself can't safely hold a GitHub write token (it's public
JavaScript — anyone could read it out of the page source). A Cloudflare
Worker sitting between the app and GitHub can: the token lives in
Cloudflare's secret store, never in this repo, and the Worker only uses it
after checking a password you set.

This scopes the password to *writes only* — anyone can still browse and use
the app freely without ever seeing a login screen. (If you also want the
whole site behind a login, see `ACCESS-CONTROL.md` instead — the two are
independent and can be combined.)

## What it does

- `POST /api/recipes` — add a new recipe to `data/recipes.json`, committed
  to your repo with a message like "Add recipe: <name>".
- `PUT /api/recipes/:importId` — update an existing shared recipe.
- `DELETE /api/recipes/:importId` — remove a recipe from the shared file.

Every call requires an `X-Site-Password` header matching a password only
you know. Wrong password → `401`, no GitHub call is made.

Deletes only affect the shared file going forward — anyone who already
loaded that recipe into their own local copy keeps it (same local-first
model as everything else in the app). That's a feature, not a gap: nobody's
device gets wiped by a remote change.

## Setup steps

1. Create a free Cloudflare account (or reuse the one from
   `ACCESS-CONTROL.md`'s login-gate attempt) at
   https://dash.cloudflare.com/sign-up.
2. **Workers & Pages → Create → Workers → Create Worker.** Name it something
   like `midnight-pantry-recipes`.
3. Paste the script below into the online editor and deploy.
4. Create a GitHub **fine-grained personal access token**
   (https://github.com/settings/personal-access-tokens/new) scoped to
   **only this repository**, with **Contents: Read and write** permission
   and nothing else. Don't use a classic token with full repo/account
   access — the fine-grained one limits the blast radius if it ever leaks.
5. On the Worker, go to **Settings → Variables and Secrets** and add:
   - `SITE_PASSWORD` — whatever password you want to type in the app.
   - `GITHUB_TOKEN` — the fine-grained token from step 4.
   - `GITHUB_REPO` — `themprog/DApp-MealPlanning`.
   - `GITHUB_BRANCH` — the branch GitHub Pages is actually deploying from
     (check Settings → Pages in the repo, or just use whichever branch you
     want new recipes committed to — it doesn't have to be the same branch
     Claude Code sessions work on).
   - `ALLOWED_ORIGIN` — `https://themprog.github.io` (locks down which site
     is allowed to call this Worker; use `*` if you don't care).
6. Deploy. You'll get a URL like
   `https://midnight-pantry-recipes.<you>.workers.dev`.
7. In the app: **Settings → Shared recipe library**, paste that URL, tap
   Save. The 🔒 buttons on the recipe edit screen will start working.
8. To revoke: change `SITE_PASSWORD` (invalidates the password instantly)
   or delete/rotate the GitHub token (revokes write access entirely).

Every publish/update/delete becomes a normal commit — `git log` shows
exactly what changed and when, and `git revert` undoes any single one if
something goes wrong. A new commit to `data/recipes.json` also triggers a
normal GitHub Pages redeploy, same as any other push, so changes go live
the same way everything else does (a minute or so of lag, not instant).

## The Worker script

```js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Site-Password",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    if (!url.pathname.startsWith("/api/recipes")) {
      return json({ error: "Not found" }, 404, cors);
    }

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
      if (request.method === "PUT" && importId) {
        return await updateRecipe(importId, await request.json(), env, cors);
      }
      if (request.method === "DELETE" && importId) {
        return await deleteRecipe(importId, env, cors);
      }
    } catch (e) {
      return json({ error: e.message }, 500, cors);
    }
    return json({ error: "Method not allowed" }, 405, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });
}

const GH_API = "https://api.github.com";

function ghHeaders(env) {
  return {
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
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
  const path = env.RECIPES_PATH || "data/recipes.json";
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
```

This is untested against live Cloudflare/GitHub traffic (no way to verify
that from a sandboxed session without an actual Worker deployed and a real
GitHub token), but it's built directly on documented APIs — the Workers
`fetch`/`Request`/`Response` runtime and GitHub's
[Contents API](https://docs.github.com/en/rest/repos/contents) for reading
and writing a file with its `sha`. The client side (the 🔒 buttons and the
password-prompt sheet in `index.html`) is already built and unit-tested
against a stubbed version of this exact request/response shape
(`POST`/`PUT`/`DELETE` to `/api/recipes[...]` with an `X-Site-Password`
header, `{ok, importId}` / `{error}` JSON responses) — so once this Worker
is live, it should just work. Test it against the real deployment once
it's up and flag anything that doesn't behave as expected.
