// =============================================================================
// TSN Ads Manager, MCP Server
// =============================================================================
// Exposes your live Google Ads data (via the TSN Ads Manager WordPress plugin's
// REST API) as MCP tools that Claude can call in conversation.
//
//   Claude  ->  this server  ->  TSN Ads Manager REST  ->  Google Ads
//
// Transport: Streamable HTTP (the current standard; SSE is deprecated).
// No build step, plain ESM JavaScript. `npm install` then `node src/server.js`.
//
// v110, adds WRITE tools (negatives, campaign bid/budget, keywords) plus the
// optimizer trigger. Every write tool is dry-run by default. The real safety
// caps live in the WordPress plugin, not here: this server is not a trusted
// component and nothing it sends can exceed the plugin's limits.
//
// v114, adds create_ad_group, matching the plugin's new /mutate/ad-group route.
// Also corrects the cap wording in two tool descriptions: as of plugin v114 the
// per-campaign CPC and budget limits are EDITABLE SETTINGS rather than hardcoded
// constants, and there is a new account-wide daily ceiling on top of them. A
// description that names a fixed dollar figure would be quietly wrong the moment
// Greg changes one, so the descriptions now say the limits exist without
// asserting their values, the plugin is the authority and reports the real
// number in any refusal.
//
// v115.5 / server 1.3.0, adds get_digest_last_run, reading the plugin's new
// /digest/last-run route. The daily digest records how its analysis call went on
// every run, and that record includes the raw model response when a run failed.
// Before this tool the only way to read a failed run was to open the WordPress
// admin screen and paste it into a chat by hand.
//
// v115.7 / server 1.4.0, adds create_rsa and set_ad_status, matching the
// plugin's new /mutate/rsa and /mutate/ad-status routes. Together they let
// Claude finish a copy change end to end: write the ad (always PAUSED), then
// enable it and pause the one it replaces, each as its own dry-run-first call.
// Campaign status is still not reachable, these act on single ads inside
// campaigns that are already running, so they cannot turn spend on.
//
// server 1.5.0 (plugin v115.9.2+): adds get_platform_performance (Google,
// Microsoft and ChatGPT in one call, each with a status), list_recent_changes
// and undo_change, reading the plugin's /performance/platforms,
// /proposals/recent and /proposals/{id}/undo routes. undo_change keeps the
// dry-run-first habit: the dry run is answered here from /proposals/recent and
// touches nothing; only the live call reaches the plugin, which applies the
// kill switch and every spend cap to the way back.
//
// server 1.6.0 (plugin v115.9.4+): adds update_conversion_goal, reading the
// plugin's /mutate/conversion-goal route. It sets one campaign conversion goal
// biddable or not biddable. Dry run first, as always: the dry run names every
// primary conversion action that will start counting. A live change is
// recorded as an applied change, so list_recent_changes shows it and
// undo_change reverses it.
//
// server 1.8.0 (plugin v116.3.0+): adds list_open_findings and apply_finding,
// reading the plugin's /proposals/open and /proposals/{id}/apply routes. They
// let Claude read what the daily digest proposed, in full, and apply one item
// the owner has said yes to in chat, through the same dispatcher as the
// review page (kill switch, caps and undo included). Landing page findings are
// written to the site through Site Bridge first; apply_finding then checks the
// live page and closes them. Dry run first, as always.
//
// server 1.7.0 (plugin v116.1.0+): adds ten tools, reading the plugin's
// /spyfu/* routes and /competitors/list. Eight are read-only SpyFu lookups
// (usage, domain overview, organic keywords, keyword stats, competitors, ad
// history, paid keywords, keyword gap). Two read and save the approved
// competitor list, a WordPress setting; the save is dry run first. SpyFu bills per row returned, and the
// guards are the plugin's, not this server's: a per-lookup row limit, the
// monthly row ceiling on the Competitors screen, and a 30-day cache. Every
// answer carries a "spend" block with the rows it cost and the rows left.
//
// Configuration (via environment / .env, see .env.example):
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
if (!MCP_SECRET) console.error("[tsnam-mcp] WARNING: MCP_SECRET is not set, the endpoint is UNPROTECTED.");

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
  "The plugin enforces its own spend limits, a per-campaign CPC ceiling, a per-campaign daily " +
  "budget, and an account-wide daily total across all enabled campaigns, and rejects anything " +
  "above them, naming the limit in the error. Those limits are editable in WordPress, so do not " +
  "assume a particular figure; if a call is refused on a cap, report the plugin's message verbatim.";

// Shared wording for the SpyFu lookups, so each one states the cost rule once.
const SPYFU_SPEND_DESC =
  " SpyFu bills per row returned. The plugin caps every lookup at 100 rows, enforces the monthly row " +
  "ceiling set on the Competitors screen, and caches each answer for 30 days, so a repeat costs nothing. " +
  "Every answer includes a spend block: report rows_spent and rows_left to the user when a lookup was not cached. " +
  "SpyFu figures are estimates that lag by weeks, and small advertisers often return little or nothing.";

const SPYFU_DOMAIN = z.string().min(3)
  .describe("A root domain such as example.com. A full URL is accepted and reduced to its domain.");

const spyfuLimit = (dflt) => z.number().int().min(1).max(100).default(dflt)
  .describe(`How many rows to buy. Default ${dflt}, hard maximum 100. Ask for the fewest that answer the question.`);

// ---- Build the MCP server with its tools -----------------------------------

function buildServer() {
  const server = new McpServer({
    name: "tsn-ads-manager",
    version: "1.8.0",
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
      description: "List all Google Ads campaigns (excluding removed ones) with their status and daily budget. Use this to see what campaigns exist and get their IDs. No date range, this is the full roster regardless of recent activity.",
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
          .describe("A GAQL SELECT query. Must begin with SELECT. Read-only, cannot modify the account."),
      },
    },
    async ({ query }) => result(await wpGet("/gaql", { q: query }))
  );

  // =========================================================================
  // SPYFU LOOKUPS (read-only, metered)
  // =========================================================================

  server.registerTool(
    "spyfu_usage",
    {
      title: "SpyFu usage this month",
      description:
        "Rows the plugin has bought from SpyFu this month, the monthly row ceiling, rows left, and the " +
        "rate per 1,000 rows for each lookup. Free: it does not call SpyFu. Check it before a run of " +
        "several lookups. No parameters.",
      inputSchema: {},
    },
    async () => result(await wpGet("/spyfu/usage"))
  );

  server.registerTool(
    "spyfu_domain_overview",
    {
      title: "SpyFu domain overview",
      description:
        "One domain's latest SpyFu snapshot: organic keyword count, estimated organic clicks and their " +
        "value, paid keyword count, estimated monthly ad budget and paid clicks, and domain strength. " +
        "Costs 1 row. Use it first to see whether SpyFu knows a domain at all before buying larger lookups." +
        SPYFU_SPEND_DESC,
      inputSchema: { domain: SPYFU_DOMAIN },
    },
    async ({ domain }) => result(await wpGet("/spyfu/domain-overview", { domain }))
  );

  server.registerTool(
    "spyfu_domain_keywords",
    {
      title: "SpyFu organic keywords for a domain",
      description:
        "The organic keywords a domain ranks for, with position, ranking URL, search volume, keyword " +
        "difficulty, estimated organic clicks and cost per click. This is the organic side, for SEO " +
        "questions. For what a domain pays for, use spyfu_competitor_paid_keywords." + SPYFU_SPEND_DESC,
      inputSchema: {
        domain: SPYFU_DOMAIN,
        limit: spyfuLimit(25),
        sort: z.enum(["clicks", "volume"]).default("clicks")
          .describe("clicks (default) ranks by the organic clicks the domain gets from each keyword. volume ranks by search volume."),
      },
    },
    async ({ domain, limit, sort }) => result(await wpGet("/spyfu/domain-keywords", { domain, limit, sort }))
  );

  server.registerTool(
    "spyfu_keyword_stats",
    {
      title: "SpyFu keyword stats",
      description:
        "Search volume, ranking difficulty, cost per click by match type, estimated monthly cost and " +
        "number of advertisers for a list of exact keywords. One row per keyword that SpyFu knows; " +
        "keywords it has no data for come back under no_data and cost nothing." + SPYFU_SPEND_DESC,
      inputSchema: {
        keywords: z.array(z.string().min(1)).min(1).max(50)
          .describe("Exact keywords, no brackets or quotes. Max 50 per call."),
      },
    },
    async ({ keywords }) => result(await wpGet("/spyfu/keyword-stats", { keywords: keywords.join(",") }))
  );

  server.registerTool(
    "spyfu_competitors",
    {
      title: "SpyFu top competitors",
      description:
        "Who competes with a domain, by keyword overlap. type paid (default) lists domains bidding on the " +
        "same keywords; type organic lists domains ranking for the same keywords. Each row is marked " +
        "approved true or false against the saved approved list. SpyFu's list mixes real rivals with " +
        "directories, software firms and job boards, so ALWAYS show the names to the user and let them " +
        "strike any before saving the list with set_approved_competitors or building anything on it." +
        SPYFU_SPEND_DESC,
      inputSchema: {
        domain: z.string().optional()
          .describe("Domain to find competitors for. Leave out to use TSN's own domain from the plugin settings."),
        type: z.enum(["paid", "organic"]).default("paid")
          .describe("paid (default) for Google Ads competitors, organic for search ranking competitors."),
        limit: spyfuLimit(10),
      },
    },
    async ({ domain, type, limit }) =>
      result(await wpGet("/spyfu/competitors", { domain, type: type === "organic" ? "seo" : "ppc", limit }))
  );

  server.registerTool(
    "spyfu_ad_history",
    {
      title: "SpyFu competitor ad copy",
      description:
        "A domain's best-performing Google ad copy: headline, body, display URL, the keyword it ran on " +
        "and when it was last seen. Identical ads on several keywords are merged, with the other keywords " +
        "under also_on. This is the most expensive lookup per row, so keep the limit modest. Treat the " +
        "copy as raw material: write new ads for TSN, never reuse competitor wording or brand names, and " +
        "push new ads with create_rsa (always PAUSED) only after the user has read them." + SPYFU_SPEND_DESC,
      inputSchema: { domain: SPYFU_DOMAIN, limit: spyfuLimit(25) },
    },
    async ({ domain, limit }) => result(await wpGet("/spyfu/ad-history", { domain, limit }))
  );

  server.registerTool(
    "spyfu_competitor_paid_keywords",
    {
      title: "SpyFu competitor paid keywords",
      description:
        "The paid keywords SpyFu rates most successful for a domain over the past year, with search " +
        "volume, cost per click by match type, estimated monthly cost and number of advertisers. Before " +
        "recommending any, check them against get_search_terms and the campaign's existing keywords and " +
        "negatives, and recommend only the few that fit a live campaign and its landing page. Add " +
        "approved ones with manage_keywords (dry run first)." + SPYFU_SPEND_DESC,
      inputSchema: { domain: SPYFU_DOMAIN, limit: spyfuLimit(25) },
    },
    async ({ domain, limit }) => result(await wpGet("/spyfu/paid-keywords", { domain, limit }))
  );

  server.registerTool(
    "spyfu_keyword_gap",
    {
      title: "SpyFu paid keyword gap",
      description:
        "Paid keywords that competitors buy and TSN does not. Leave competitors out to use the saved " +
        "approved list. With all_must_buy false (default) a keyword qualifies if any listed competitor " +
        "buys it; true keeps only keywords every listed competitor buys, a much shorter and stronger " +
        "list. Most results will not fit: recommend only those matching a live campaign and landing page." +
        SPYFU_SPEND_DESC,
      inputSchema: {
        competitors: z.array(z.string().min(3)).max(5).optional()
          .describe("Up to 5 competitor domains. Leave out to use the approved competitor list."),
        all_must_buy: z.boolean().default(false)
          .describe("false (default): any listed competitor buys the keyword. true: every listed competitor buys it."),
        limit: spyfuLimit(25),
      },
    },
    async ({ competitors, all_must_buy, limit }) =>
      result(await wpGet("/spyfu/keyword-gap", {
        competitors: (competitors || []).join(","),
        all: all_must_buy ? "1" : "",
        limit,
      }))
  );

  server.registerTool(
    "get_approved_competitors",
    {
      title: "Approved competitor list",
      description:
        "Read the approved competitor list saved in the plugin, and TSN's own domain. The monthly " +
        "competitor pass reads the first five on it, and spyfu_keyword_gap uses it by default. Free: it " +
        "does not call SpyFu. An empty list means nothing has been approved yet. No parameters.",
      inputSchema: {},
    },
    async () => result(await wpGet("/competitors/list"))
  );

  // =========================================================================
  // WRITE TOOLS, dry-run by default
  // =========================================================================

  server.registerTool(
    "add_negative_keywords",
    {
      title: "Add negative keywords",
      description:
        "Add campaign-level negative keywords to a Google Ads campaign. This is the main tool for cutting " +
        "wasted spend found via get_search_terms, competitor brand names, job seekers, DIY researchers. " +
        "Terms already present on the campaign are detected and skipped, so overlap is safe. " +
        "ALWAYS run once with dry_run true, show the user the plan, and only then re-run with dry_run false. " +
        "Reversible: a wrong negative can be deleted in the Google Ads UI.",
      inputSchema: {
        campaign_id: z.string().min(1)
          .describe("Numeric Google Ads campaign ID. Get it from list_campaigns."),
        keywords: z.array(z.string().min(1)).min(1).max(100)
          .describe("Negative keyword terms, without brackets or quotes. Max 100 per call."),
        match_type: z.enum(["BROAD", "PHRASE", "EXACT"]).default("BROAD")
          .describe("BROAD (default) blocks any query containing the term, right for competitor brands and junk topics. PHRASE and EXACT are narrower."),
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
        "cpc_ceiling only applies to Maximize Clicks (TARGET_SPEND) campaigns, the call is refused with a " +
        "clear message on other bidding strategies. " + CAPS_DESC + " " +
        "A budget INCREASE is also checked against the account-wide ceiling and refused if the new total " +
        "would breach it; reductions are always allowed. " +
        "ALWAYS run once with dry_run true and get explicit confirmation before setting dry_run false, " +
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
        "IMPORTANT, the ad copy is CLONED from an already-approved ad elsewhere in the same campaign. That " +
        "is what makes this safe to automate: no new ad text means no new policy exposure, and the ad group " +
        "starts serving immediately. But cloned copy by definition does not speak to the new intent, so tell " +
        "the user that writing proper copy is a required follow-up, not an optional polish. " +
        "If the campaign has no approved ad to clone, the call is refused rather than leaving behind an ad " +
        "group that can never serve, build that one in the plugin's pusher instead, where the copy is reviewed. " +
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
        "The ad is ALWAYS created PAUSED, there is no option to create it enabled. Enabling is a separate " +
        "set_ad_status call, so writing copy and running copy stay two decisions. " +
        "Pass campaign_id to add it beside that campaign's live ad, or ad_group_id to target an ad group directly. " +
        "The final URL defaults to the live ad's URL, and the plugin always forces ?kw={keyword} onto it so the " +
        "landing page can echo the search term. Limits are enforced in the plugin: headlines 30 characters (3 to 15), " +
        "descriptions 90 characters (2 to 4), display paths 15 characters. An over-long line is REFUSED and named, " +
        "never truncated, fix it and resend. Show the user every headline and description before the live call. " +
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
        "warns if the ad is disapproved or its campaign is not running, read those before the live call. " +
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
    "update_conversion_goal",
    {
      title: "Set a campaign conversion goal biddable",
      description:
        "Turn one campaign conversion goal on or off for bidding (the checkbox in the campaign's Goals settings). " +
        "A goal is a category plus origin, e.g. SUBMIT_LEAD_FORM + WEBSITE. Only biddable goals count in the \"Conversions\" " +
        "column, so a campaign whose real lead goal is not biddable looks like it never converts. On this account's " +
        "Maximize Clicks bidding the change does not affect spend. Every PRIMARY conversion action in the category " +
        "starts or stops counting together; the dry run lists them under would_count. Check that list for an action " +
        "that duplicates another before going live. Read current goals with run_gaql: SELECT " +
        "campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable FROM " +
        "campaign_conversion_goal WHERE campaign.id = <id>. A live change returns change_id; undo_change with that id " +
        "puts it back. ALWAYS run once with dry_run true, show the user the plan, and only then re-run with dry_run false.",
      inputSchema: {
        campaign_id: z.string().min(1).describe("Numeric campaign ID."),
        category: z.string().regex(/^[A-Za-z_]+$/).describe("Goal category enum, e.g. SUBMIT_LEAD_FORM, BOOK_APPOINTMENT, CONVERTED_LEAD."),
        origin: z.string().regex(/^[A-Za-z_]+$/).default("WEBSITE").describe("Goal origin enum. Default WEBSITE."),
        biddable: z.boolean().describe("true to count this goal for the campaign, false to stop counting it."),
        dry_run: z.boolean().default(true).describe(DRY_RUN_DESC),
      },
    },
    async ({ campaign_id, category, origin, biddable, dry_run }) =>
      result(await wpPost("/mutate/conversion-goal", { campaign_id, category: category.toUpperCase(), origin: origin.toUpperCase(), biddable, dry_run }))
  );

  server.registerTool(
    "get_platform_performance",
    {
      title: "All ad platforms",
      description:
        "Get KPI data for Google Ads, Microsoft Ads and ChatGPT (OpenAI) Ads in one call, the same numbers the " +
        "Ads Manager dashboard shows. Each platform comes back with its own status: ok, not_configured, or " +
        "error with the reason. Report a platform that is not ok by its status and message; never treat a " +
        "missing platform as zero spend.",
      inputSchema: {
        days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(7)
          .describe("Window in days: 7, 30 or 90. Default 7."),
      },
    },
    async ({ days }) => result(await wpGet("/performance/platforms", { days }))
  );

  server.registerTool(
    "list_recent_changes",
    {
      title: "Recent changes",
      description:
        "List recent decisions on digest and optimizer proposals: what was applied, undone or rejected, by whom " +
        "and when. Each applied change says whether it can be undone (can_undo) and what the undo would do " +
        "(undo_label). Use this to find the id for undo_change. Changes applied before plugin v115.9 have no " +
        "recorded undo.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20)
          .describe("How many recent decisions to return (1-50). Default 20."),
      },
    },
    async ({ limit }) => result(await wpGet("/proposals/recent", { limit }))
  );

  server.registerTool(
    "undo_change",
    {
      title: "Undo one applied change",
      description:
        "Reverse one change that was applied from the digest review page or the Optimizer tab, using the before " +
        "state the plugin recorded at the moment it applied it (restore a budget or CPC ceiling, re-enable " +
        "paused keywords, pause added keywords, remove an added negative, put a campaign setting back, pause a " +
        "new ad group, set a conversion goal back to its earlier biddable state). The dry run looks the change up and reports what the undo would do, touching nothing. " +
        "The live call goes through the plugin's kill switch, and restoring a HIGHER budget or ceiling goes " +
        "through the same spend limits as any change, so it can be refused. " + CAPS_DESC + " " +
        "Get the id from list_recent_changes. " +
        "ALWAYS run once with dry_run true, show the user the plan, and only then re-run with dry_run false.",
      inputSchema: {
        id: z.number().int().min(1).describe("Proposal id from list_recent_changes."),
        dry_run: z.boolean().default(true).describe(DRY_RUN_DESC),
      },
    },
    async ({ id, dry_run }) => {
      if (!dry_run) return result(await wpPost(`/proposals/${id}/undo`, {}));
      const recent = await wpGet("/proposals/recent", { limit: 50 });
      if (recent.ok === false) return result(recent);
      const row = (recent.proposals || []).find(p => Number(p.id) === Number(id));
      if (!row) {
        return result({ ok: false, dry_run: true, id,
          error: "Not among the 50 most recent decisions. Check the id with list_recent_changes." });
      }
      return result({
        ok: row.can_undo, dry_run: true, id, change: row.label, type: row.type, status: row.status,
        would_do: row.can_undo ? row.undo_label : null,
        note: row.can_undo
          ? "Nothing has been changed. Re-run with dry_run false to undo."
          : (row.status !== "applied"
              ? `This change is ${row.status}, so there is nothing to undo.`
              : "No undo was recorded for this change (applied before plugin v115.9, or not reversible here). Reverse it in Google Ads."),
      });
    }
  );

  server.registerTool(
    "set_approved_competitors",
    {
      title: "Save the approved competitor list",
      description:
        "Replace the approved competitor list with the domains given. This is a WordPress setting, not a " +
        "Google Ads change, and it costs no SpyFu rows. Send the COMPLETE list every time: anything left " +
        "out is removed. Up to 10 domains; the monthly competitor pass reads the first five, so put the " +
        "most important first. An empty list clears it, and the monthly pass goes back to letting SpyFu " +
        "pick. Only save names the user has seen and agreed to. ALWAYS run once with dry_run true, show " +
        "the user what is added and removed, and only then re-run with dry_run false.",
      inputSchema: {
        domains: z.array(z.string()).max(10)
          .describe("The complete approved list, most important first. Root domains such as example.com."),
        dry_run: z.boolean().default(true).describe(DRY_RUN_DESC),
      },
    },
    async ({ domains, dry_run }) => result(await wpPost("/competitors/list", { domains, dry_run }))
  );

  server.registerTool(
    "list_open_findings",
    {
      title: "Open digest findings",
      description:
        "List what the daily digest has proposed and is still waiting on a decision, in full: the id, type, " +
        "campaign, label, why, evidence and the complete payload (for a landing_page finding that is the page URL, " +
        "the keywords it must repeat, what the page says now, and every drafted field; for rsa_copy, every headline " +
        "and description). apply_does says what applying it would do. Use type to narrow the list, e.g. landing_page. " +
        "To act on a landing_page finding: show the user the drafted wording, write it with the site's Site Bridge " +
        "connector (update_landing_page for a rewrite, create_landing_page then publish_content for a new page, each " +
        "dry run first), then call apply_finding on it so the plugin checks the live page and closes it.",
      inputSchema: {
        type: z.enum(["landing_page", "rsa_copy", "ad_group", "bid_ceiling", "budget", "keyword_add", "keyword_pause",
          "negative_keyword", "geo_exclude", "campaign_setting", "campaign_draft", "conversion_goal"]).optional()
          .describe("Only this kind of finding. Omit for all."),
        id: z.number().int().min(1).optional().describe("One finding by id (the # shown in the digest email)."),
      },
    },
    async ({ type, id }) => result(await wpGet("/proposals/open", { type: type || "", id: id || 0 }))
  );

  server.registerTool(
    "apply_finding",
    {
      title: "Apply one digest finding",
      description:
        "Apply one open digest finding by id, the same way ticking it on the review page does: through the plugin's " +
        "dispatcher, with its kill switch, spend caps and monthly ceiling, and with an undo recorded where the change " +
        "can be reversed (see list_recent_changes and undo_change). For a landing_page finding nothing is written to " +
        "the site: the plugin reads the live page and closes the finding only if it carries the approved wording; a " +
        "new page also gets a PAUSED copy of the ad group's ad pointing at it. Write the page with Site Bridge first. " +
        "Set skip_page_check only when the site's security blocks the plugin's check and you have just confirmed the " +
        "page yourself. " + CAPS_DESC + " " +
        "ALWAYS run once with dry_run true, show the user the plan, and only then re-run with dry_run false.",
      inputSchema: {
        id: z.number().int().min(1).describe("Finding id from list_open_findings."),
        skip_page_check: z.boolean().default(false)
          .describe("landing_page only: close it without the plugin reading the page. Only after you have verified the live page."),
        dry_run: z.boolean().default(true).describe(DRY_RUN_DESC),
      },
    },
    async ({ id, skip_page_check, dry_run }) => {
      if (!dry_run) return result(await wpPost(`/proposals/${id}/apply`, { skip_page_check }));
      const open = await wpGet("/proposals/open", { id });
      if (open.ok === false) return result(open);
      const row = (open.proposals || [])[0];
      if (!row) {
        return result({ ok: false, dry_run: true, id,
          error: "No open finding with that id. It may already be applied or skipped; check list_recent_changes." });
      }
      return result({
        ok: row.applicable, dry_run: true, id, type: row.type, change: row.label, why: row.why,
        would_do: row.apply_does,
        note: row.applicable
          ? "Nothing has been changed. Re-run with dry_run false to apply."
          : "This kind of finding is reviewed, not applied from here.",
      });
    }
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
      return res.status(404).end(); // 404, not 401, don't confirm the path exists
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
