// Minimal .env loader (no dependency). Existing process.env values win.
import fs from "node:fs";

export function loadEnv(file = ".env") {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnv();

// In GitHub Actions the workflow passes every repository secret as one JSON blob, so keys added
// from the dashboard (including per-game webhooks) work without editing the workflow file.
if (process.env.ALL_SECRETS) {
  try {
    for (const [k, v] of Object.entries(JSON.parse(process.env.ALL_SECRETS))) {
      if (k !== "github_token" && typeof v === "string" && v && !process.env[k]) process.env[k] = v;
    }
  } catch {
    /* ignore malformed */
  }
  delete process.env.ALL_SECRETS;
}
