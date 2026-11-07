// Minimal GitHub REST client for the dashboard. The repository is the "backend":
// config files live on `main`, collected data on the `coverage-data` branch, and the
// polling job runs in GitHub Actions. The personal access token never leaves this browser
// except to api.github.com.
const API = "https://api.github.com";

function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class GitHub {
  constructor({ owner, repo, token, branch = "main", dataBranch = "coverage-data", workflow = "poll.yml" }) {
    Object.assign(this, { owner, repo, token, branch, dataBranch, workflow });
  }

  async req(path, { method = "GET", body, accept = "application/vnd.github+json" } = {}) {
    const res = await fetch(`${API}/repos/${this.owner}/${this.repo}${path}`, {
      method,
      cache: "no-store",
      headers: {
        accept,
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = JSON.parse(text).message; } catch { /* not JSON */ }
      throw new GitHubError(res.status, msg || `GitHub API error ${res.status}`);
    }
    if (accept.includes("raw")) return text;
    return text ? JSON.parse(text) : null;
  }

  repoInfo() {
    return this.req("");
  }

  /** Read a JSON file; returns { json, sha } or null if it doesn't exist. */
  async readJson(path, ref = this.branch) {
    try {
      const f = await this.req(`/contents/${path}?ref=${encodeURIComponent(ref)}`);
      if (f.content) return { json: JSON.parse(b64decodeUtf8(f.content)), sha: f.sha };
      // files > 1 MB come back without inline content
      const raw = await this.req(`/contents/${path}?ref=${encodeURIComponent(ref)}`, { accept: "application/vnd.github.raw+json" });
      return { json: JSON.parse(raw), sha: f.sha };
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async readRawJson(path, ref) {
    try {
      return JSON.parse(await this.req(`/contents/${path}?ref=${encodeURIComponent(ref)}`, { accept: "application/vnd.github.raw+json" }));
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Read-modify-write a JSON file on the config branch. `mutate(json)` is re-applied to the
   * latest version if someone else changed the file meanwhile (409/422 conflict).
   */
  async updateJson(path, mutate, message, fallback = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = await this.readJson(path);
      const json = structuredClone(cur?.json ?? fallback);
      const next = mutate(json) ?? json;
      try {
        await this.req(`/contents/${path}`, {
          method: "PUT",
          body: { message, content: b64encodeUtf8(JSON.stringify(next, null, 2) + "\n"), branch: this.branch, ...(cur ? { sha: cur.sha } : {}) },
        });
        return next;
      } catch (err) {
        if ((err.status === 409 || err.status === 422) && attempt < 3) continue;
        throw err;
      }
    }
  }

  async dispatchPoll({ force = false } = {}) {
    await this.req(`/actions/workflows/${this.workflow}/dispatches`, { method: "POST", body: { ref: this.branch, inputs: { force: String(force) } } });
  }

  async latestRuns(n = 3) {
    const r = await this.req(`/actions/workflows/${this.workflow}/runs?per_page=${n}`);
    return r.workflow_runs || [];
  }

  async secretNames() {
    const r = await this.req("/actions/secrets?per_page=100");
    return new Set((r.secrets || []).map((s) => s.name));
  }

  /** Store an encrypted Actions secret (libsodium sealed box with the repo's public key). */
  async setSecret(name, value) {
    const sodium = await loadSodium();
    const key = await this.req("/actions/secrets/public-key");
    const sealed = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL));
    await this.req(`/actions/secrets/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: { encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL), key_id: key.key_id },
    });
  }

  async deleteSecret(name) {
    await this.req(`/actions/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
  }
}

let sodiumPromise;
export function loadSodium() {
  sodiumPromise ??= new Promise((resolve, reject) => {
    const base = new URL("./vendor/", import.meta.url);
    const add = (file) =>
      new Promise((ok, fail) => {
        const s = document.createElement("script");
        s.src = new URL(file, base).href;
        s.onload = ok;
        s.onerror = () => fail(new Error(`could not load ${file}`));
        document.head.append(s);
      });
    add("libsodium.js")
      .then(() => add("libsodium-wrappers.js"))
      .then(() => window.sodium.ready)
      .then(() => resolve(window.sodium), reject);
  });
  return sodiumPromise;
}
