/**
 * Generates a permit via ``POST /chat?module=ptw`` and extracts the
 * tool result.
 *
 * The orchestrator returns ``tool_results: [{tool, input, result}]`` -
 * we expect ``build_ptw_template`` to be one of them. If the LLM
 * returned prose without using the tool, we raise so the UI can show a
 * "model did not produce a structured permit" message instead of
 * fabricating fields client-side.
 */
import type { OutputFormat, PtwFormState, GeneratedPermit } from './types.js';
import { buildPtwPrompt } from './prompt.js';

export interface GeneratePtwOptions {
  baseUrl: string;
  token: string;
  form: PtwFormState;
  outputFormat: OutputFormat;
  userRole?: string;
  jurisdiction?: string | null;
}

export async function generatePermitViaChat(opts: GeneratePtwOptions): Promise<GeneratedPermit> {
  const body = {
    message: buildPtwPrompt(opts.form, opts.outputFormat),
    module: 'ptw',
    user_role: opts.userRole ?? null,
    jurisdiction: opts.jurisdiction ?? null,
    asset_context: opts.form.asset_id,
    offline_mode: false,
  };

  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify(body),
  };
  const resp = await fetch(new URL('/chat', opts.baseUrl).toString(), init);
  if (!resp.ok) {
    throw new Error(`/chat module=ptw failed (${resp.status})`);
  }
  const data = (await resp.json()) as {
    answer: string;
    tool_results?: Array<{ tool: string; input?: unknown; result?: unknown }>;
    flags?: string[];
  };
  const toolResult = (data.tool_results ?? []).find((tr) => tr.tool === 'build_ptw_template');
  if (!toolResult || !toolResult.result) {
    throw new Error(
      'The model did not use the build_ptw_template tool. Try again or simplify the inputs.',
    );
  }
  return toolResult.result as GeneratedPermit;
}

/**
 * Renders the generated permit as an HTML document for ``expo-print``.
 *
 * Plain HTML (no JS, no external CSS) so the print pipeline produces a
 * deterministic PDF on iOS / Android / Web without the dev needing to
 * ship a template file. Section ordering tracks the backend schema.
 */
export function permitToHtml(permit: GeneratedPermit): string {
  const safe = escapeHtml;
  const bullets = (items: string[]): string =>
    items.length === 0
      ? '<li><em>none</em></li>'
      : items.map((i) => `<li>${safe(i)}</li>`).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${safe(permit.permit_id)}</title>
<style>
  body { font: 13px/1.45 -apple-system, "Segoe UI", system-ui, sans-serif; padding: 24pt; color: #1c222b; }
  h1 { font-size: 18pt; margin: 0 0 4pt; }
  h2 { font-size: 12pt; margin: 16pt 0 4pt; text-transform: uppercase; letter-spacing: .5pt; color: #5e6776; }
  .banner { padding: 10pt 12pt; border-left: 4pt solid #1f6fb8; background: #dfeefd; color: #0a3d6b; margin-bottom: 12pt; }
  .field { margin: 4pt 0; }
  .field b { color: #2e3641; }
  .signoff { border: 1pt solid #bcc4d0; padding: 10pt; margin-top: 18pt; }
  ul { margin: 4pt 0 4pt 18pt; padding: 0; }
  .meta { color: #5e6776; font-size: 11pt; }
</style>
</head><body>
  <div class="banner"><b>DECISION SUPPORT ONLY</b><br>${safe(permit.banner)}</div>
  <h1>${safe(permit.format === 'toolbox_talk' ? 'Toolbox-talk briefing' : 'Permit to Work - draft')}</h1>
  <div class="meta">Permit ID: ${safe(permit.permit_id)} · Generated ${safe(permit.generated_utc)}</div>

  <h2>Job</h2>
  <div class="field"><b>Work type:</b> ${safe(permit.work_type)}</div>
  <div class="field"><b>Location:</b> ${safe(permit.location)}</div>
  <div class="field"><b>Description:</b> ${safe(permit.job_description)}</div>

  <h2>Hazards</h2>
  <ul>${bullets(permit.hazards)}</ul>

  <h2>Controls</h2>
  <ul>${bullets(permit.controls.merged)}</ul>

  <h2>Isolations</h2>
  <ul>${bullets(permit.isolations)}</ul>

  <h2>Required PPE</h2>
  <ul>${bullets(permit.required_ppe.merged)}</ul>

  ${permit.briefing ? `<h2>Briefing</h2><ul>${bullets(permit.briefing)}</ul>` : ''}

  <div class="signoff">
    <h2 style="margin-top:0">Sign-off</h2>
    <div class="field"><b>Permit Issuer:</b> ${safe(permit.sign_off.permit_issuer.name ?? '________________________')} <span class="meta">${permit.sign_off.permit_issuer.signed_utc ? `signed ${safe(permit.sign_off.permit_issuer.signed_utc)}` : 'unsigned'}</span></div>
    <div class="field"><b>Performing Authority:</b> ${safe(permit.sign_off.performing_authority.name ?? '________________________')} <span class="meta">${permit.sign_off.performing_authority.signed_utc ? `signed ${safe(permit.sign_off.performing_authority.signed_utc)}` : 'unsigned'}</span></div>
  </div>

  <p class="meta" style="margin-top:24pt">Audit hash: ${safe(permit.audit_sha256)}</p>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
