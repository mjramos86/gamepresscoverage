// Node wrapper around the shared report renderer in web/report-core.js.
import { queryHits, queryStreams } from "./lib/db.js";
import { renderReport, selectForReport, computeStats, streamMetrics } from "../web/report-core.js";

export { computeStats, streamMetrics };

export function buildReport(project, { from, to, lang } = {}) {
  const { hits, streams } = selectForReport(project, queryHits({ projectId: project.id }), queryStreams({ projectId: project.id }), from, to);
  return renderReport(project, { hits, streams, from, to, lang });
}
