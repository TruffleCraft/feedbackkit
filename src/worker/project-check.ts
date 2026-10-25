import { resolveDelivery, type FeedbackConfig } from "../shared/contract.js";
import { listFields, projectHtmlUrl } from "./providers/github-projects.js";
import type { FetchFn } from "./providers/github.js";
import type { Env } from "./env.js";

// System check for GitHub Project delivery (#110). fieldsReadable proves the
// token can read the project and names what FeedbackKit would skip;
// draftWriteVerified only comes from a real delivered test report, because
// reading fields says nothing about write access.

export interface ProjectCheck {
  org: string;
  number: number;
  url: string;
  patSecret: string;
  patPresent: boolean;
  fieldsReadable: boolean | null; // null: no token to check with
  reason: string | null;
  /** Fields or options FeedbackKit would skip ("field \"Type\"", "option \"bug\" in \"Type\""). */
  missing: string[];
  /** Time of the last delivered test report (POST /api/admin/projects/:id/test-report). */
  draftWriteVerified: number | null;
}

export async function checkProject(env: Env, config: FeedbackConfig, fetchImpl?: FetchFn): Promise<ProjectCheck | null> {
  const p = config.tracker?.project;
  if (!p || !config.tracker) return null;
  const patSecret = p.patSecret ?? config.tracker.patSecret;
  const pat = env[patSecret] as string | undefined;
  const verified = await env.DB.prepare(
    "SELECT MAX(updated_at) AS at FROM feedback WHERE project_id = ?1 AND is_test = 1 AND delivery = 'project' AND delivery_state = 'delivered'",
  )
    .bind(config.projectId)
    .first<{ at: number | null }>();
  const out: ProjectCheck = {
    org: p.org,
    number: p.number,
    url: projectHtmlUrl(p),
    patSecret,
    patPresent: Boolean(pat),
    fieldsReadable: null,
    reason: null,
    missing: [],
    draftWriteVerified: verified?.at ? Number(verified.at) : null,
  };
  if (!pat) return out;
  try {
    const fields = await listFields({ pat, project: p, fetchImpl });
    out.fieldsReadable = true;
    const field = (name: string, dataType: string) => fields.find((f) => f.name.toLowerCase() === name.toLowerCase() && f.dataType === dataType);
    const needOption = (fieldName: string, option: string) => {
      const f = field(fieldName, "single_select");
      if (!f) return;
      if (!f.options.some((o) => o.name.toLowerCase() === option.toLowerCase())) out.missing.push(`option "${option}" in "${fieldName}"`);
    };
    if (!field(p.fields.type, "single_select")) out.missing.push(`single select field "${p.fields.type}"`);
    if (!field(p.fields.page, "text")) out.missing.push(`text field "${p.fields.page}"`);
    if (!field(p.fields.source, "single_select")) out.missing.push(`single select field "${p.fields.source}"`);
    const types = config.templates.filter((t) => resolveDelivery(config, t) === "project").map((t) => p.typeOptions[t.type] ?? t.type);
    for (const option of new Set(types)) needOption(p.fields.type, option);
    needOption(p.fields.source, "FeedbackKit");
    if (p.status) needOption("Status", p.status);
  } catch (e) {
    out.fieldsReadable = false;
    const status = (e as { status?: number }).status;
    out.reason =
      status === 404
        ? `project ${p.org} #${p.number} not found: it must be an organisation project, and the token needs "Projects: read and write" for ${p.org}`
        : status === 401 || status === 403
          ? `token ${patSecret} has no access to the project (needs the organisation permission "Projects: read and write")`
          : (e as Error).message;
  }
  return out;
}
