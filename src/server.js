// =============================================================================
// TSN Ads Manager — MCP Server
// =============================================================================
// Exposes your live Google Ads data (via the TSN Ads Manager WordPress plugin's
// REST API) as MCP tools that Claude can call in conversation.
//
//   Claude  ->  this server  ->  TSN Ads Manager REST  ->  Google Ads
//
// Transport: Streamable HTTP (the current standard; SSE is deprecated).
// No build step — plain ESM JavaScript. `npm install` then `node src/server.js`.
//
// v110 — adds WRITE tools (negatives, campaign bid/budget, keywords) plus the
// optimizer trigger. Every write tool is dry-run by default. The real safety
// caps live in the WordPress plugin, not here: this server is not a trusted
// component and nothing it sends can exceed the plugin's limits.
//
// v114 — adds create_ad_group, matching the plugin's new /mutate/ad-group route.
// Also corrects the cap wording in two tool descriptions: as of plugin v114 the
// per-campaign CPC and budget limits are EDITABLE SETTINGS rather than hardcoded
// constants, and there is a new account-wide daily ceiling on top of them. A
// description that names a fixed dollar figure would be quietly wrong the moment
// Greg changes one, so the descriptions now say the limits exist without
// asserting their values — the plugin is the authority and reports the real
// number in any refusal.
//
// v115.5 / server 1.3.0 — adds get_digest_last_run, reading the plugin's new
// /digest/last-run route. The daily digest records how its analysis call went on
// every run, and that record includes the raw model response when a run failed.
// Before this tool the only way to read a failed run was to open the WordPress
// admin screen and paste it into a chat by hand.
//
// v115.7 / server 1.4.0 — adds create_rsa and set_ad_status, matching the
// plugin's new /mutate/rsa and /mutate/ad-status routes. Together they let
// Claude finish a copy change end to end: write the ad (always PAUSED), then
// enable it and pause the one it replaces, each as its own dry-run-first call.
// Campaign status is still not reachable — these act on single ads inside
// campaigns that are already running, so they cannot turn spend on.
//
// Configuration (via environment / .env — see .env.example):
//   TSNAM_API_BASE   e.g. https://tsncommunications.ai/wp-json/tsnam/v1
//   TSNAM_API_TOKEN  the Bearer token shown on the TSN Ads Manager admin page
//   MCP_SECRET       a secret that protects THIS server's endpoint
//   MCP_AUTH_MODE    "bearer" (default) or "path"  (see README)
//   PORT             default 8787
// =============================================================================

import "dotenv/config"; // loads a local .env file if present (no-op under cPanel's env-var UI)
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---- Config ----------------------------------------------------------------

const API_BASE  = (process.env.TSNAM_API_BASE  || "").replace(/\/+$/, "");
const API_TOKEN = process.env.TSNAM_API_TOKEN || "";
const MCP_SECRET = process.env.MCP_SECRET || "";
const AUTH_MODE  = (process.env.MCP_AUTH_MODE || "bearer").toLowerCase();
const PORT       = parseInt(process.env.PORT || "8787", 10);

if (!API_BASE)  console.error("[tsnam-mcp] WARNING: TSNAM_API_BASE is not set.");
if (!API_TOKEN) console.error("[tsnam-mcp] WARNING: TSNAM_API_TOKEN is not set.");
if (!MCP_SECRET) console.error("[tsnam-mcp] WARNING: MCP_SECRET is not set — the endpoint is UNPROTECTED.");

// ---- Helper: call the WordPress REST API -----------------------------------

async function wpRequest(method, path, { params = {}, body = null } = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const init = {
    method,
    headers: {
      "Authorization": "Bearer " + API_TOKEN,
      "Accept": "application/json",
    },
  };
  if (body !== null) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let resp;
  try {
    resp = await fetch(url, init);
  } catch (e) {
    return { ok: false, error: `Could not reach TSN Ads Manager at ${url.origin}: ${e.message}` };
  }

  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); }
  catch { return { ok: false, error: `Non-JSON response (HTTP ${resp.status}): ${text.slice(0, 300)}` }; }

  if (!resp.ok || data.ok === false) {
    return { ok: false, error: data.error || `HTTP ${resp.status} from TSN Ads Manager`, status: resp.status, ...data };
  }
  return data;
}

const wpGet  = (path, params = {})    => wpRequest("GET",  path, { params });
const wpPost = (path, body = {})      => wpRequest("POST", path, { body });

// Wrap any tool result as MCP text content (pretty JSON the model can read).
function result(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// Shared wording so every write tool teaches the same two-step habit.
const DRY_RUN_DESC =
  "Leave this true (the default) to preview. A dry run returns exactly what WOULD change and " +
  "touches nothing. Only set false after showing the user the dry-run plan and getting their " +
  "explicit go-ahead in that same conversation. Never set false on the first call for a change.";

// Spend limits are configured in WordPress and may be tightened at any time, so
// no tool description states a figure. The plugin refuses anything over a limit
// and names the actual number in the error, which is the only version that
// cannot go stale.
const CAPS_DESC =
  "The plugin enforces its own spend limits — a per-campaign CPC ceiling, a per-campaign daily " +
  "budget, and an account-wide daily total across all enabled campaigns — and rejects anything " +
  "above them, naming the limit in the error. Those limits are editable in WordPress, so do not " +
  "assume a particular figure; if a call is refused on a cap, report the plugin's message verbatim.";

// ---- Build the MCP server with its tools -----------------------------------

function buildServer() {
  const server = new McpServer({
    name: "tsn-ads-manager",
    version: "1.4.0",
  });

  // =========================================================================
  // READ TOOLS
  // =========================================================================

  server.registerTool(
    "get_health",
    {
      title: "Health check",
      description: "Check that the TSN Ads Manager connection is alive and whether Google Ads is connected. Returns plugin version and connection status. No parameters.",
      inputSchema: {},
    },
    async () => result(await wpGet("/health"))
  );

  server.registerTool(
    "list_campaigns",
    {
      title: "List campaigns",
      description: "List all Google Ads campaigns (excluding removed ones) with their status and daily budget. Use this to see what campaigns exist and get their IDs. No date range — this is the full roster regardless of recent activity.",
      inputSchema: {},
    },
    async () => result(await wpGet("/campaigns"))
  );

  server.registerTool(
    "get_account_performance",
    {
      title: "Account performance",
      description: "Get account-wide Google Ads performance totals for the last N days: spend, clicks, impressions, conversions, conversion value, CTR, average CPC, cost per conversion, and ROAS.",
      inputSchema: {
        days: z.number().int().min(1).max(365).default(30)
          .describe("Number of days back from today to include (1-365). Default 30."),
      },
    },
    async ({ days }) => result(await wpGet("/performance", { days }))
  );

  server.registerTool(
    "get_campaign_performance",
    {
      title: "Per-campaign performance",
      description: "Get performance broken out per campaign for the last N days (spend, clicks, impressions, conversions, CTR, cost per conversion), sorted by spend descending. Only campaigns with activity in the window appear. Use this to compare campaigns and spot the expensive or underperforming ones.",
      inputSchema: {
        days: z.number().int().min(1).max(365).default(30)
          .describe("Number of days back from today to include (1-365). Default 30."),
      },
    },
    async ({ days }) => result(await wpGet("/performance/campaigns", { days }))
  );

  server.registerTool(
    "get_search_terms",
    {
      title: "Search terms report",
      description: "Get the actual search terms people typed that triggered ads, with spend, clicks, impressions, and conversions, sorted by spend descending. This is the primary tool for finding wasted spend and candidate negative keywords.",
      inputSchema: {
        days: z.number().int().min(1).max(365).default(30)
          .describe("Number of days back from today to include (1-365). Default 30."),
        limit: z.number().int().min(1).max(2000).default(300)
          .describe("Maximum number of search term rows to return (1-2000). Default 300."),
      },
    },
    async ({ days, limit }) => result(await wpGet("/search-terms", { days, limit }))
  );

  server.registerTool(
    "get_digest_last_run",
    {
      title: "Last daily digest run",
      description:
        "Read how the most recent 8am daily digest analysis went: when it ran, whether it " +
        "parsed cleanly (ok), recovered only part of itself (salvaged), or failed, plus the " +
        "model, stop reason, decoder error, character count, and number of findings. When a " +
        "run did NOT parse cleanly, the raw model response is included so the cause can be " +
        "read rather than guessed at. Use this whenever the digest email reports a problem, " +
        "or to confirm a digest ran at all. Read-only. schema_enforced tells you whether the " +
        "call was constrained to the findings schema; false means the API refused the schema " +
        "and the run fell back to parsing free text, which is worth knowing before diagnosing " +
        "a parse failure.",
      inputSchema: {},
    },
    async () => result(await wpGet("/digest/last-run"))
  );

  server.registerTool(
    "run_gaql",
    {
      title: "Run GAQL query (read-only)",
      description: "Run a raw read-only Google Ads Query Language (GAQL) SELECT query against the connected account and return the raw results. Use this for custom reports the other tools don't cover. Only SELECT queries are permitted. Example: SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS",
      inputSchema: {
        query: z.string().min(1)
          .describe("A GAQL SELECT query. Must begin with SELECT. Read-only — cannot modify the account."),
      },
    },
    async ({ query }) => result(await wpGet("/gaql", { q: query }))
  );

  // =========================================================================
  // WRITE TOOLS — dry-run by default
  // =========================================================================

  server.registerTool(
    "add_negative_keywords",
    {
      title: "Add negative keywords",
      description:
        "Add campaign-level negative keywords to a Google Ads campaign. This is the main tool for cutting " +
        "wasted spend found via get_search_terms — competitor brand names, job seekers, DIY researchers. " +
        "Terms already present on the campaign are detected and skipped, so overlap is safe. " +
        "ALWAYS run once with dry_run true, show the user the plan, and only then re-run with dry_run false. " +
        "Reversible: a wrong negative can be deleted in the Google Ads UI.",
      inputSchema: {
        campaign_id: z.string().min(1)
          .describe("Numeric Google Ads campaign ID. Get it from list_campaigns."),
        keywords: z.array(z.string().min(1)).min(1).max(100)
          .describe("Negative keyword terms, without brackets or quotes. Max 100 per call."),
        match_type: z.enum(["BROAD", "PHRASE", "EXACT"]).default("BROAD")
          .describe("BROAD (default) blocks any query containing the term — right for competitor brands and junk topics. PHRASE and EXACT are narrower."),
        dry_run: z.boolean().default(true).describe(DRY_RUN_DESC),
      },
    },
    async ({ campaign_id, keywords, match_type, dry_run }) =>
      result(await wpPost("/mutate/negatives", { campaign_id, keywords, match_type, dry_run }))
  );

  server.registerTool(
    "set_campaign_bid",
    {
      title: "Set campaign CPC ceiling / daily budget",
      description:
        "Change a campaign's max CPC bid ceiling and/or its daily budget. Both are in dollars. " +
        "cpc_ceiling only applies to Maximize Clicks (TARGET_SPEND) campaigns — the call is refused with a " +
        "clear message on other bidding strategies. " + CAPS_DESC + " " +
        "A budget INCREASE is also checked against the account-wide ceiling and refused if the new total " +
        "would breach it; reductions are always allowed. " +
        "ALWAYS run once with dry_run true and get explicit confirmation before setting dry_run false — " +
        "this tool directly changes how fast money leaves the account.",
      inputSchema: {
        campaign_id: z.string().min(1)
          .describe("Numeric Google Ads campaign ID. Get it from list_campaigns."),
        cpc_ceiling: z.number().positive().optional()
          .describe("New max CPC bid ceiling in dollars, e.g. 2.50. Omit to leave unchanged."),
        daily_budget: z.number().positive().optional()
          .describe("New daily budget in dollars, e.g. 10.00. Omit to leave unchanged."),
        dry_run: z.boolean().default(true).describe(DRY_RUN_DESC),
      },
    },
    async ({ campaign_id, cpc_ceiling, daily_budget, dry_run }) =>
      result(await wpPost("/mutate/campaign-bid", { campaign_id, cpc_ceiling, daily_budget, dry_run }))
  );

  server.registerTool(
    "manage_keywords",
    {
      title: "Add or pause keywords",
      description:
        "Add keywords to an ad group, or pause existing ones by their text. Use action 'add' or 'pause'. " +
        "For 'add', keywords already present at that match type are skipped. For 'pause', keywords are matched " +
        "by text and any already-paused ones are left alone. " +
        "Get ad_group_id via list_ad_groups, or via run_gaql: SELECT ad_group.id, ad_group.name FROM ad_group WHERE campaign.id = <id>. " +
        "ALWAYS dry_run first and confirm with the user before committing. Adding keywords opens new spend; " +
        "check search volume before assuming a keyword will actually serve.",
      inputSchema: {
        ad_group_id: z.string().min(1)
          .describe("Numeric Google Ads ad group ID."),
        keywords: z.array(z.string().min(1)).min(1).max(50)
          .describe("Keyword texts, without brackets or quotes. Max 50 per call."),
        action: z.enum(["add", "pause"]).default("add")
          .describe("'add' creates new enabled keywords. 'pause' pauses existing ones matched by text."),
        match_type: z.enum(["BROAD", "PHRASE", "EXACT"]).default("PHRASE")
          .describe("Match type for 'add' (default PHRASE), and the match type recorded in the plan."),
        cpc_bid: z.number().positive().optional()
          .describe("Optional per-keyword max CPC in dollars. Omit to inherit the ad group bid. The plugin caps this at its configured CPC ceiling and reports the limit if exceeded."),
        dry_run: z.boolean().default(true).describe(DRY_RUN_DESC),
      },
    },
    async ({ ad_group_id, keywords, action, match_type, cpc_bid, dry_run }) =>
      result(await wpPost("/mutate/keywords", { ad_group_id, keywords, action, match_type, cpc_bid, dry_run }))
  );

  server.registerTool(
    "list_ad_groups",
    {
      title: "List ad groups in a campaign",
      description:
        "List the ad groups in a campaign with their IDs, names, status and default CPC bid. " +
        "Use this to get an ad_group_id for manage_keywords, or to check what already exists before " +
        "proposing a new ad group.",
      inputSchema: {
        campaign_id: z.string().min(1)
          .describe("Numeric Google Ads campaign ID. Get it from list_campaigns."),
      },
    },
    async ({ campaign_id }) =>
      result(await wpGet("/gaql", {
        q: `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.cpc_bid_micros ` +
           `FROM ad_group WHERE campaign.id = ${String(campaign_id).replace(/[^0-9]/g, "")} ` +
           `AND ad_group.status != 'REMOVED'`,
      }))
  );

  server.registerTool(
    "create_ad_group",
    {
      title: "Create an ad group",
      description:
        "Create a new ad group inside an EXISTING campaign, add its keywords, and clone a Google-approved " +
        "ad into it so it actually serves. Use this when a distinct intent cluster is being forced through " +
        "an ad group that does not match it. " +
        "IMPORTANT — the ad copy is CLONED from an already-approved ad elsewhere in the same campaign. That " +
        "is what makes this safe to automate: no new ad text means no new policy exposure, and the ad group " +
        "starts serving immediately. But cloned copy by definition does not speak to the new intent, so tell " +
        "the user that writing proper copy is a required follow-up, not an optional polish. " +
        "If the campaign has no approved ad to clone, the call is refused rather than leaving behind an ad " +
        "group that can never serve — build that one in the plugin's pusher instead, where the copy is reviewed. " +
        "This tool does NOT create campaigns. Campaign creation needs new ad copy, a landing page and a geo, " +
        "and it belongs in the pusher UI. " + CAPS_DESC + " " +
        "ALWAYS run once with dry_run true, show the user the plan, and only then re-run with dry_run false.",
      inputSchema: {
        campaign_id: z.string().min(1)
          .describe("Numeric Google Ads campaign ID of the EXISTING campaign to add the ad group to. Get it from list_campaigns."),
        name: z.string().min(1)
          .describe("Name for the new ad group. If the name is already taken in that campaign, the plugin appends a date suffix rather than failing."),
        keywords: z.array(z.string().min(1)).min(1).max(50)
          .describe("Keyword texts for the new ad group, without brackets or quotes. Max 50. An ad group with no keywords cannot serve, so at least one is required."),
        match_type: z.enum(["BROAD", "PHRASE", "EXACT"]).default("PHRASE")
          .describe("Match type for the new keywords. PHRASE is the working default for this account; BROAD pulls unrelated intent faster than negatives can catch it at small budgets."),
        cpc_bid: z.number().positive().optional()
          .describe("Optional default max CPC for the ad group, in dollars. Omit for the plugin default of $1.00. Subject to the configured CPC cap."),
        dry_run: z.boolean().default(true).describe(DRY_RUN_DESC),
      },
    },
    async ({ campaign_id, name, keywords, match_type, cpc_bid, dry_run }) =>
      result(await wpPost("/mutate/ad-group", { campaign_id, name, keywords, match_type, cpc_bid, dry_run }))
  );

  server.registerTool(
    "create_rsa",
    {
      title: "Create a responsive search ad (paused)",
      description:
        "Create a new responsive search ad from copy the user has already read, inside an existing ad group. " +
        "The ad is ALWAYS created PAUSED — there is no option to create it enabled. Enabling is a separate " +
        "set_ad_status call, so writing copy and running copy stay two decisions. " +
        "Pass campaign_id to add it beside that campaign's live ad, or ad_group_id to target an ad group directly. " +
        "The final URL defaults to the live ad's URL, and the plugin always forces ?kw={keyword} onto it so the " +
        "landing page can echo the search term. Limits are enforced in the plugin: headlines 30 characters (3 to 15), " +
        "descriptions 90 characters (2 to 4), display paths 15 characters. An over-long line is REFUSED and named, " +
        "never truncated — fix it and resend. Show the user every headline and description before the live call. " +
        "ALWAYS run once with dry_run true, show the user the plan, and only then re-run with dry_run false.",
      inputSchema: {
        campaign_id: z.string().optional()
          .describe("Numeric campaign ID. The ad goes into the ad group holding that campaign's live approved ad."),
        ad_group_id: z.string().optional()
          .describe("Numeric ad group ID, to target a specific ad group. Takes precedence over campaign_id."),
        headlines: z.array(z.string().min(1)).min(3).max(15)
          .describe("3 to 15 headlines, 30 characters or fewer each. Unique. No third-party brand names."),
        descriptions: z.array(z.string().min(1)).min(2).max(4)
          .describe("2 to 4 descriptions, 90 characters or fewer each."),
        final_url: z.string().optional()
          .describe("Optional. Omit to reuse the live ad's landing page. ?kw={keyword} is added either way."),
        path1: z.string().max(15).optional().describe("Optional display path, 15 characters max."),
        path2: z.string().max(15).optional().describe("Optional second display path, 15 characters max."),
        dry_run: z.boolean().default(true).describe(DRY_RUN_DESC),
      },
    },
    async ({ campaign_id, ad_group_id, headlines, descriptions, final_url, path1, path2, dry_run }) =>
      result(await wpPost("/mutate/rsa", { campaign_id, ad_group_id, headlines, descriptions, final_url, path1, path2, dry_run }))
  );

  server.registerTool(
    "set_ad_status",
    {
      title: "Enable or pause one ad",
      description:
        "Enable or pause a single ad by ad_group_id and ad_id. Use it to switch a reviewed paused ad on, and to " +
        "pause the ad it replaces. The dry run reports the ad's current status and Google's policy review, and " +
        "warns if the ad is disapproved or its campaign is not running — read those before the live call. " +
        "This never changes campaign status; a paused campaign stays paused. " +
        "Get ad IDs from run_gaql, e.g. SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.status FROM ad_group_ad " +
        "WHERE campaign.id = <id>. " +
        "ALWAYS run once with dry_run true, show the user the plan, and only then re-run with dry_run false.",
      inputSchema: {
        ad_group_id: z.string().min(1).describe("Numeric ad group ID."),
        ad_id: z.string().min(1).describe("Numeric ad ID (the part after ~ in an adGroupAds resource name)."),
        status: z.enum(["ENABLED", "PAUSED"]).describe("ENABLED to run the ad, PAUSED to stop it. REMOVED is deliberately not offered."),
        dry_run: z.boolean().default(true).describe(DRY_RUN_DESC),
      },
    },
    async ({ ad_group_id, ad_id, status, dry_run }) =>
      result(await wpPost("/mutate/ad-status", { ad_group_id, ad_id, status, dry_run }))
  );

  server.registerTool(
    "run_optimizer",
    {
      title: "Run the optimizer",
      description:
        "Trigger one optimizer mining pass. It scans recent search terms, scores them for relevance against " +
        "the configured campaign offers, and queues negative-keyword proposals for review. Safe to call: it " +
        "does not mutate the account unless auto-apply has been switched on in the plugin settings. " +
        "Returns a summary of what was scanned, flagged, and queued. Review the resulting proposals on the " +
        "Optimizer tab in WordPress, or act on them with add_negative_keywords.",
      inputSchema: {},
    },
    async () => result(await wpPost("/optimizer/run", {}))
  );

  return server;
}

// ---- HTTP layer (Streamable HTTP, stateless) -------------------------------

const app = express();
app.use(express.json({ limit: "1mb" }));

// Liveness probe for you / your monitoring (does NOT touch Google Ads).
app.get("/", (_req, res) => res.json({ ok: true, service: "tsnam-ads-mcp", transport: "streamable-http" }));

// The MCP endpoint handler (shared by both auth modes).
async function handleMcp(req, res) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,   // stateless: new transport per request, proxy-friendly
    enableJsonResponse: true,
  });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

if (AUTH_MODE === "path") {
  // Secret lives in the URL path: POST /mcp/<MCP_SECRET>
  // Use this mode for the claude.ai web "authless" custom connector, where Claude
  // can't send a custom header. The unguessable path is what protects it.
  app.post("/mcp/:secret", async (req, res) => {
    if (!MCP_SECRET || req.params.secret !== MCP_SECRET) {
      return res.status(404).end(); // 404, not 401 — don't confirm the path exists
    }
    await handleMcp(req, res);
  });
} else {
  // Default: bearer-token in the Authorization header on POST /mcp
  // Use this mode for MCP Inspector, Claude Desktop, and the Claude API.
  app.post("/mcp", async (req, res) => {
    const auth = req.get("authorization") || "";
    const m = auth.match(/Bearer\s+(.+)/i);
    const provided = m ? m[1].trim() : "";
    if (!MCP_SECRET || provided !== MCP_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    await handleMcp(req, res);
  });
}

app.listen(PORT, "0.0.0.0", () => {
  // Bind to localhost; terminate TLS and expose publicly via your reverse proxy.
  console.error(`[tsnam-mcp] listening on http://0.0.0.0:${PORT}  (auth mode: ${AUTH_MODE})`);
  console.error(`[tsnam-mcp] upstream: ${API_BASE || "(unset)"}`);
});
