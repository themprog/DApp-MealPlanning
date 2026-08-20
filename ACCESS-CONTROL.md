> **Update:** this and the shared-library write API below were merged into
> one deployable script at [`worker/index.js`](worker/index.js) — that's
> the actual source of truth now. The script below is kept for reference /
> the "why," but if you're pasting something into Cloudflare, use the file.
>
> **Also since this was written:** the design below proxies to a *public*
> GitHub Pages URL, which means that URL still works directly for anyone
> who has it — a proxy in front of an otherwise-public site can't force
> traffic through itself. `worker/index.js` fixes this properly: the repo
> goes **private**, GitHub Pages is no longer used at all, and the Worker
> reads files straight out of git (via `raw.githubusercontent.com` with
> the same token used for recipe writes) after the login check passes.
> There is no public copy left to route around.

# Adding a real login gate

The app is hosted on GitHub Pages, which is always fully public once a repo's
Pages source is enabled — there's no password/login option at that layer, and
since the repo itself is public, anything hardcoded into `index.html` (a
client-side password, an API key, etc.) is visible to anyone via view-source.
That rules out a JS-only "password screen" as real security — it would just
put the secret in the one place we don't want it: git.

Real access control needs *something* sitting in front of the static site
that can check a credential before the page is ever served. The plan below
does that without needing a custom domain and without putting any secret in
this repo.

## Recommended approach: Cloudflare Worker as an auth proxy

A tiny script running on Cloudflare's free tier, in front of the GitHub Pages
site. It shows a login form; only after the right password is submitted does
it forward the request through to `themprog.github.io/DApp-MealPlanning/...`
and return that response. The password lives in Cloudflare's secret store,
never in this repo.

**Why this over the alternatives:**
- **No custom domain required** — Cloudflare Workers get a free
  `<name>.<you>.workers.dev` address immediately.
- **No GitHub App / repo access needed** — unlike Cloudflare Pages (which
  didn't go smoothly last time), Workers deploy independently of GitHub
  entirely, so nothing about repo permissions can trip this up.
- **Free** — Workers' free tier is 100,000 requests/day, no credit card.

**Trade-off to know going in:** this is a single shared password, not
per-person accounts — fine for "keep randoms off my app," not a multi-user
system. If you want real per-person logins later (e.g. email one-time
codes), that's what Cloudflare Access does instead — see the alternative
below.

### Setup steps (whenever you're ready)

1. Create a free account at https://dash.cloudflare.com/sign-up (or reuse the
   one from the earlier Cloudflare Pages attempt).
2. **Workers & Pages → Create → Workers → Create Worker.** Give it a name,
   e.g. `midnight-pantry-gate`.
3. Open the online code editor and replace the default script with the one
   below.
4. **Settings → Variables and Secrets** on the Worker: add a secret named
   `SITE_PASSWORD` (whatever password you want) and another named
   `SESSION_SECRET` (any long random string — this signs the login cookie,
   it's not something you type in). Both stay in Cloudflare only.
5. Deploy. You'll get a URL like `https://midnight-pantry-gate.<you>.workers.dev`
   — that's the new link to open on your phone / add to your home screen
   instead of the raw GitHub Pages URL. It'll show a login form first, then
   the real app once you're in (session lasts 30 days per browser).
6. To revoke access for everyone at once (e.g. you think the password
   leaked), just change `SITE_PASSWORD` and `SESSION_SECRET` — every
   existing session is invalidated instantly.

### The Worker script

```js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cookie = request.headers.get("Cookie") || "";

    if (url.pathname === "/__login" && request.method === "POST") {
      const form = await request.formData();
      const pw = form.get("password") || "";
      if (pw === env.SITE_PASSWORD) {
        const token = await sign(env.SESSION_SECRET);
        return new Response(null, {
          status: 302,
          headers: {
            "Location": "/",
            "Set-Cookie": `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
          },
        });
      }
      return loginPage("Wrong password. Try again.");
    }

    if (!(await isAuthed(cookie, env.SESSION_SECRET))) {
      return loginPage();
    }

    // Authenticated — proxy through to the real site.
    const originUrl = "https://themprog.github.io/DApp-MealPlanning" + url.pathname + url.search;
    const res = await fetch(new Request(originUrl, request));
    return new Response(res.body, res);
  },
};

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
```

This is untested against live Cloudflare traffic (no way to verify that from
this session without an actual Worker deployed), but it's built directly on
Cloudflare's documented Worker runtime APIs (`export default { fetch(request,
env) }`, the standard `Request`/`Response`/`fetch()` objects, and the Web
Crypto `crypto.subtle` API), so the shape should be right. Test it against
the real deployment once it's live and flag anything that doesn't behave as
expected.

## Alternative: Cloudflare Access + a custom domain

If you'd rather have real per-person logins (email one-time-code, no shared
password) instead of the single-password Worker above, Cloudflare Access is
the no-code option — but it requires a custom domain whose DNS you control,
pointed at Cloudflare, with a CNAME to `themprog.github.io` (GitHub Pages
supports custom domains natively). More setup than the Worker route (buying/
owning a domain), but no code to maintain and supports multiple people
cleanly. Worth it if this is going to be shared with more than just you.

## What "skip for now" means today

The site stays reachable by anyone with the exact URL
(`https://themprog.github.io/DApp-MealPlanning/`) — not indexed by search
engines, not discoverable by guessing, but not password-gated either. No
actual app data is exposed even without a login (everything you enter lives
only in your own browser's local storage, never on the server), so the
practical risk today is low — this is about closing that gap later, not an
urgent hole.
