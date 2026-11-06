#!/usr/bin/env node
import "./lib/env.js";
import "./lib/dbflag.js";
import fs from "node:fs";
import path from "node:path";
import { pollAll } from "./poll.js";
import { buildReport } from "./report.js";
import { exportStatic } from "./export.js";
import { seedDemo } from "./demo.js";
import { loadOutlets, getProject } from "./lib/config.js";
import { fetchFeed } from "./collectors/rss.js";
import { closeDb } from "./lib/db.js";

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      out[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
    } else out._.push(a);
  }
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);
const a = args(rest);

try {
  switch (cmd) {
    case "poll":
      await pollAll({ force: Boolean(a.force), only: a.project || null, alert: !a["no-alerts"] });
      break;
    case "report": {
      if (!a.project) throw new Error("usage: npm run report -- --project <id> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--lang fr|en]");
      const project = getProject(a.project);
      if (!project) throw new Error(`unknown project ${a.project}`);
      const to = a.to || new Date().toISOString().slice(0, 10);
      const from = a.from || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
      const html = buildReport(project, { from, to, lang: a.lang });
      const file = path.join("reports", `${project.id}_${from}_${to}.html`);
      fs.mkdirSync("reports", { recursive: true });
      fs.writeFileSync(file, html);
      console.log(`Report written to ${file} (open it in a browser; use Print → Save as PDF for a PDF).`);
      break;
    }
    case "export":
      exportStatic(a.out || "site");
      break;
    case "demo":
      seedDemo();
      break;
    case "check-feeds": {
      for (const o of loadOutlets().filter((x) => x.feed)) {
        try {
          const f = await fetchFeed(o.feed);
          console.log(`OK    ${o.name.padEnd(24)} ${String(f.items.length).padStart(3)} items  ${o.feed}`);
        } catch (err) {
          console.log(`FAIL  ${o.name.padEnd(24)} ${err.message}  ${o.feed}`);
        }
      }
      break;
    }
    default:
      console.log("Commands: poll [--force] [--project id] [--no-alerts] | report --project id [--from] [--to] [--lang] | export [--out dir] | demo | check-feeds");
      process.exitCode = cmd ? 1 : 0;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  closeDb();
}
