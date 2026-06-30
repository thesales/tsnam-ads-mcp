# TSN Ads Manager — MCP Server

Turns your TSN Ads Manager Google Ads data into tools Claude can call in conversation.

```
Claude  ->  this server  ->  TSN Ads Manager REST API  ->  Google Ads
```

It adds no new Google credentials — it just calls the plugin's read-only REST routes
using the token shown on the plugin's admin page. **No build step.**

---

## What it gives Claude (6 read-only tools)

| Tool | What it does |
|------|--------------|
| `get_health` | Confirms the connection and whether Google Ads is connected |
| `list_campaigns` | All campaigns + status + daily budget |
| `get_account_performance` | Account totals for N days (spend, clicks, conv, CTR, CPC, ROAS) |
| `get_campaign_performance` | Same, broken out per campaign |
| `get_search_terms` | The search-terms report — the wasted-spend goldmine |
| `run_gaql` | Raw read-only GAQL query escape hatch |

---

## RECOMMENDED PATH: cPanel "Setup Node.js App" (no command line)

This tool installs dependencies, keeps the server running, and gives it a public
HTTPS URL — all from the dashboard. From WHM, open the cPanel for the account that
owns `tsncommunications.ai` (WHM -> List Accounts -> the cPanel icon).

### 1. Get your two secrets from the plugin
In WordPress, open **TSN Ads Manager**. The blue notice shows the **Base URL** and
**Bearer token**. Keep them handy.

### 2. Make a subdomain
cPanel -> **Domains** -> create `mcp.tsncommunications.ai` (or similar). Note the
**Document Root** it gives you (e.g. `/home/USER/mcp.tsncommunications.ai`).

### 3. Upload the files
cPanel -> **File Manager** -> go to your home folder -> **Upload** this project's
zip -> right-click -> **Extract**. You'll get a `tsnam-mcp` folder. (Don't upload
`node_modules` — the next step builds it for you.)

### 4. Create the Node.js app
cPanel -> **Setup Node.js App** -> **Create Application**:
- **Node.js version:** pick 18 or higher
- **Application mode:** Production
- **Application root:** the path to the `tsnam-mcp` folder
- **Application URL:** your `mcp.tsncommunications.ai` subdomain
- **Application startup file:** `src/server.js`

Click **Create**.

### 5. Add your settings as environment variables
Still on the Node.js app screen, in **Environment variables**, add:
- `TSNAM_API_BASE` = the Base URL from step 1
- `TSNAM_API_TOKEN` = the Bearer token from step 1
- `MCP_SECRET` = a long random string you make up (this protects the server)
- `MCP_AUTH_MODE` = `path`   (use `path` so claude.ai web can connect — see step 8)

Save.

### 6. Install dependencies
On the same screen, click **Run NPM Install**. Wait for it to finish.

### 7. Start it & check HTTPS
Click **Start** (or **Restart**). Then make sure the subdomain has SSL:
cPanel -> **SSL/TLS Status** -> run **AutoSSL** on `mcp.tsncommunications.ai`.
Visit `https://mcp.tsncommunications.ai/` in a browser — you should see
`{"ok":true,"service":"tsnam-ads-mcp",...}`.

### 8. Connect it to Claude.ai (web/mobile)
Because you set `MCP_AUTH_MODE=path`, your connection URL includes the secret:

```
https://mcp.tsncommunications.ai/mcp/<your MCP_SECRET>
```

In Claude.ai: **Settings -> Connectors -> Add custom connector**, paste that URL,
no authentication. Treat that URL like a password.

Then ask Claude: *"Using TSN Ads Manager, pull my search terms for the last 30 days
and find wasted spend."*

> Whenever you change an environment variable, click **Restart** on the Node.js app.

---

## ALTERNATIVE PATH: SSH + PM2 (advanced, command line)

If you'd rather run it by hand:

```bash
cd /home/USER/tsnam-mcp
npm install
cp .env.example .env && nano .env        # fill in the values
HOST=127.0.0.1 node src/server.js         # test; Ctrl+C to stop
npm install -g pm2
HOST=127.0.0.1 pm2 start src/server.js --name tsnam-mcp
pm2 save && pm2 startup
```

Then reverse-proxy a public HTTPS subdomain to `127.0.0.1:8787`. In this mode you
can keep `MCP_AUTH_MODE=bearer` and connect via Claude Desktop / the Claude API with
an `Authorization: Bearer <MCP_SECRET>` header.

---

## Test locally first (optional but smart)

```bash
npm install
cp .env.example .env      # fill in values; set MCP_AUTH_MODE=bearer
node src/server.js
npx @modelcontextprotocol/inspector
```

In the Inspector: Transport = **Streamable HTTP**, URL = `http://127.0.0.1:8787/mcp`,
add header `Authorization: Bearer <MCP_SECRET>`, Connect -> List Tools -> run
`get_health`. `"google_connected": true` means the whole chain works.

---

## Security notes
- Server and plugin are **read-only**; `run_gaql` rejects anything but `SELECT`.
- Keep `.env` and your connector URL/secret private (`.gitignore` excludes `.env`).
- If you rotate the plugin token, update `TSNAM_API_TOKEN` here and restart.

## Troubleshooting
- **Browser shows the `{"ok":true}` page but Claude won't connect** → check the
  subdomain has a valid SSL cert (AutoSSL); self-signed/expired certs are rejected.
- **Tools error with a connection message** → check `TSNAM_API_BASE`/`TSNAM_API_TOKEN`;
  open the plugin's `/health` URL in a browser to confirm the plugin side is live.
- **404 from `/mcp/...`** → the secret in the URL doesn't match `MCP_SECRET`, or you
  forgot to **Restart** after changing it.
