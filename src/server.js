// =============================================================================
// TSN Ads Manager — MCP Server
// =============================================================================
// Exposes your live Google Ads data (via the TSN Ads Manager WordPress plugin's
// read-only REST API) as MCP tools that Claude can call in conversation.
//
//   Claude  ->  this server  ->  TSN Ads Manager REST  ->  Google Ads
//
// Transport: Streamable HTTP (the current standard; SSE is deprecated).
// No build step — plain ESM JavaScript. `npm install` then `node src/server.js`.
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

async function wpGet(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  let resp;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + API_TOKEN,
        "Accept": "application/json",
      },
    });
  } catch (e) {
    return { ok: false, error: `Could not reach TSN Ads Manager at ${url.origin}: ${e.message}` };
  }

  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); }
  catch { return { ok: false, error: `Non-JSON response (HTTP ${resp.status}): ${text.slice(0, 300)}` }; }

  if (!resp.ok || data.ok === false) {
    return { ok: false, error: data.error || `HTTP ${resp.status} from TSN Ads Manager`, status: resp.status };
  }
  return data;
}

// Wrap any tool result as MCP text content (pretty JSON the model can read).
function result(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ---- Build the MCP server with its tools -----------------------------------

function buildServer() {
  const server = new McpServer({
    name: "tsn-ads-manager",
    version: "1.0.0",
  });

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

app.listen(PORT, "127.0.0.1", () => {
  // Bind to localhost; terminate TLS and expose publicly via your reverse proxy.
  console.error(`[tsnam-mcp] listening on http://127.0.0.1:${PORT}  (auth mode: ${AUTH_MODE})`);
  console.error(`[tsnam-mcp] upstream: ${API_BASE || "(unset)"}`);
});
