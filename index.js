#!/usr/bin/env node
// CorteX402 MCP server — exposes pay-per-call x402 data products as Claude-callable tools.
//
// Tools (7 live):
//   - sanctions_screen   $0.50 USDC — 100+ global sanctions lists (OpenSanctions)
//   - aviation_weather   $0.10 USDC — METAR/TAF/SIGMET/24h forecast (NOAA + Open-Meteo)
//   - mortgage_rates     $0.02 USDC — 30yr/15yr fixed, prime, fed funds, CPI YoY (FRED)
//   - property_dossier   $2.00 USDC — 50+ field property intel (ATTOM)
//   - title_chain        $0.02 USDC — recorded deeds, mortgages, preforeclosure (ATTOM)
//   - wallet_balance     $0.02 USDC — EVM balance across 5 chains
//   - agent_session      $0.10 USDC — CallAuth402 session mint with on-chain attestation
//
// Settlement on Base mainnet via the x402 protocol. The user provides their own funded
// wallet via the CORTEX402_WALLET_PRIVATE_KEY env var, configured in their MCP client
// (Claude Desktop, Claude Code, Cursor, Continue, etc.).
//
// Setup
// -----
// In your MCP client config (e.g. ~/Library/Application Support/Claude/claude_desktop_config.json):
//
//   {
//     "mcpServers": {
//       "cortex402": {
//         "command": "npx",
//         "args": ["-y", "cortex402-mcp"],
//         "env": {
//           "CORTEX402_WALLET_PRIVATE_KEY": "0x..."
//         }
//       }
//     }
//   }
//
// Fund the wallet with at least $3 USDC on Base mainnet for ~20 test calls.
//
// Source: https://github.com/Ooak21/cortex402-mcp
// Catalog: https://innovativeblockchainsolutions.live/CorteX402/
// Marketplace: https://agentic.market/services/jtifhcvbgxqwlywugvjv-supabase-co

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const VERSION = "0.4.0";
const args = new Set(process.argv.slice(2));

if (args.has("--version") || args.has("-v")) {
  console.log(VERSION);
  process.exit(0);
}

if (args.has("--help") || args.has("-h")) {
  console.log(`CorteX402 MCP server v${VERSION}

Usage:
  cortex402-mcp [--help] [--version]

Environment:
  CORTEX402_WALLET_PRIVATE_KEY  Required when starting the MCP server.
  CORTEX402_MAX_PAYMENT_USDC    Optional max payment amount, defaults to 5.
  CORTEX402_BASE_URL            Optional API base URL override.
`);
  process.exit(0);
}

// Supabase hosts 5 wraps (dual-emit v1+v2, polished metadata)
const SB = "https://jtifhcvbgxqwlywugvjv.supabase.co/functions/v1";
// Vercel hosts 2 wraps (title_chain + agent_session)
const VCL = process.env.CORTEX402_BASE_URL || "https://cortex402.vercel.app";

const PRIVATE_KEY = process.env.CORTEX402_WALLET_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("");
  console.error("CorteX402 MCP: missing CORTEX402_WALLET_PRIVATE_KEY env var.");
  console.error("");
  console.error("Add it to your MCP client config. Example for Claude Desktop:");
  console.error('  "cortex402": {');
  console.error('    "command": "npx",');
  console.error('    "args": ["-y", "cortex402-mcp"],');
  console.error('    "env": { "CORTEX402_WALLET_PRIVATE_KEY": "0x..." }');
  console.error("  }");
  console.error("");
  console.error("The wallet must hold USDC on Base mainnet. Min ~$3 for 20 test calls.");
  console.error("See https://innovativeblockchainsolutions.live/CorteX402/ for full setup.");
  console.error("");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY);

const MAX_PAYMENT_USDC = parseFloat(process.env.CORTEX402_MAX_PAYMENT_USDC || "5");
const MAX_PAYMENT_ATOMIC = BigInt(Math.round(MAX_PAYMENT_USDC * 1_000_000));

const fetchWithPay = wrapFetchWithPayment(fetch, account, MAX_PAYMENT_ATOMIC);

const server = new McpServer({
  name: "cortex402",
  version: VERSION,
});

// ─── Tool 1: Sanctions Screen ────────────────────────────────────────────────
server.tool(
  "sanctions_screen",
  [
    "Screen a person or company against 100+ global sanctions lists including OFAC, UN, EU, and UK.",
    "Returns match score, list provenance, source entity IDs, and verification URLs. Powered by OpenSanctions.",
    "Costs $0.50 USDC per call (settled on Base mainnet from your wallet).",
    "Use this when the user asks about: compliance checks, KYC, screening counterparties, OFAC/sanctions, due diligence.",
    "No LLM in the response path — deterministic passthrough with source attribution.",
  ].join(" "),
  {
    name: z.string().describe("Full name of the person or company being screened"),
    dob: z.string().optional().describe("Date of birth in YYYY-MM-DD format (optional, improves match accuracy)"),
    country: z.string().optional().describe("ISO-3166 alpha-2 country code (optional)"),
    type: z.enum(["person", "company"]).optional().default("person").describe("Entity type"),
  },
  async ({ name, dob, country, type }) => {
    try {
      const r = await fetchWithPay(`${SB}/cortex402-sanctions-screen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, dob, country, type }),
      });
      const data = await r.json();
      const receipt = getReceipt(r);
      return { content: [{ type: "text", text: formatSanctions(data, receipt) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `CorteX402 sanctions_screen error: ${e.message}` }], isError: true };
    }
  }
);

// ─── Tool 2: Aviation Weather ────────────────────────────────────────────────
server.tool(
  "aviation_weather",
  [
    "Real-time aviation weather for any ICAO airport. Returns decoded METAR, TAF, SIGMET alerts, and a normalized 24-hour forecast.",
    "Batch up to 10 airports per call. Sources: NOAA Aviation Weather Center and Open-Meteo.",
    "Costs $0.10 USDC per call. Settled on Base mainnet from your wallet.",
    "Use this when the user asks about: airport weather, flight planning, METAR/TAF, drone pre-flight, aviation conditions.",
    "ICAO codes: KLAS (Las Vegas), KDFW (Dallas), KJFK (New York), EGLL (Heathrow), RJTT (Tokyo).",
  ].join(" "),
  {
    icao: z.union([
      z.string().describe("Single ICAO airport code (e.g. 'KLAS')"),
      z.array(z.string()).max(10).describe("Up to 10 ICAO codes for batch query"),
    ]).describe("ICAO airport code(s)"),
  },
  async ({ icao }) => {
    try {
      const r = await fetchWithPay(`${SB}/cortex402-aviation-weather`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ icao }),
      });
      const data = await r.json();
      const receipt = getReceipt(r);
      return { content: [{ type: "text", text: formatAviation(data, receipt) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `CorteX402 aviation_weather error: ${e.message}` }], isError: true };
    }
  }
);

// ─── Tool 3: Mortgage Rates ──────────────────────────────────────────────────
server.tool(
  "mortgage_rates",
  [
    "Live US mortgage and macro rates from the Federal Reserve.",
    "Returns 30-year and 15-year fixed mortgage rates, prime rate, fed funds rate, and CPI year-over-year. Sourced from FRED (Freddie Mac PMMS series).",
    "Costs $0.02 USDC per call. Settled on Base mainnet from your wallet.",
    "Use this when the user asks about: current mortgage rates, refinance rates, prime rate, fed funds, inflation, interest rates.",
    "No parameters required — always returns the current snapshot.",
  ].join(" "),
  {},
  async () => {
    try {
      const r = await fetchWithPay(`${SB}/cortex402-mortgage-rates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await r.json();
      const receipt = getReceipt(r);
      return { content: [{ type: "text", text: formatRates(data, receipt) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `CorteX402 mortgage_rates error: ${e.message}` }], isError: true };
    }
  }
);

// ─── Tool 4: Property Dossier ────────────────────────────────────────────────
server.tool(
  "property_dossier",
  [
    "Comprehensive US property intelligence from a single address.",
    "Returns 50+ fields covering property details, automated valuation (AVM), neighborhood demographics, and nearby school ratings. Powered by ATTOM.",
    "Costs $2.00 USDC per call. Settled on Base mainnet from your wallet.",
    "Use this when the user asks about: property research, real estate analysis, mortgage qualification, neighborhood data, school zoning, property due diligence.",
  ].join(" "),
  {
    address: z.string().describe("Full US street address (e.g. '1234 Main St, Austin, TX 78701')"),
    include: z.array(z.enum(["property", "demographics", "risk", "schools"])).optional().describe("Sections to include (defaults to all)"),
  },
  async ({ address, include }) => {
    try {
      const r = await fetchWithPay(`${SB}/cortex402-property-dossier`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, ...(include ? { include } : {}) }),
      });
      if (r.status === 503) {
        return { content: [{ type: "text", text: "CorteX402 property_dossier: upstream unavailable. No payment taken." }] };
      }
      const data = await r.json();
      const receipt = getReceipt(r);
      return { content: [{ type: "text", text: formatProperty(data, receipt) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `CorteX402 property_dossier error: ${e.message}` }], isError: true };
    }
  }
);

// ─── Tool 5: Title Chain ─────────────────────────────────────────────────────
server.tool(
  "title_chain",
  [
    "US property title chain history. Returns recorded deeds, mortgages, and preforeclosure events with distress signals.",
    "Includes summary (n_sales, n_mortgages, n_preforeclosure, has_distress_signal) plus chronological event detail. Powered by ATTOM.",
    "Costs $0.02 USDC per call. Settled on Base mainnet from your wallet.",
    "Use this when the user asks about: title verification, ownership history, mortgage history, lien status, distress flags, property due diligence.",
  ].join(" "),
  {
    address: z.string().describe("Full US street address (e.g. '1234 Main St, Austin, TX 78701')"),
  },
  async ({ address }) => {
    try {
      const r = await fetchWithPay(`${VCL}/api/property/title-chain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      if (r.status === 503) {
        return { content: [{ type: "text", text: "CorteX402 title_chain: upstream unavailable. No payment taken." }] };
      }
      const data = await r.json();
      const receipt = getReceipt(r);
      return { content: [{ type: "text", text: formatTitleChain(data, receipt) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `CorteX402 title_chain error: ${e.message}` }], isError: true };
    }
  }
);

// ─── Tool 6: Wallet Balance ──────────────────────────────────────────────────
server.tool(
  "wallet_balance",
  [
    "Check any wallet balance across 5 EVM chains. Returns native or ERC-20 balance with optional threshold check, block height, and on-chain receipt.",
    "Supports Base, Ethereum, Arbitrum, Optimism, and Polygon. Common tokens (USDC, USDT, WETH, WBTC, DAI) resolve by symbol; others by contract address.",
    "Costs $0.02 USDC per call. Settled on Base mainnet from your wallet.",
    "Use this when the user asks about: wallet balance, token balance, checking if a wallet has enough funds, multi-chain balance lookup.",
  ].join(" "),
  {
    address: z.string().describe("EVM wallet address to check"),
    network: z.enum(["base", "ethereum", "arbitrum", "optimism", "polygon"]).describe("Which chain to query"),
    token: z.string().optional().describe("Token symbol (USDC, USDT, WETH, etc.) or contract address. Omit for native ETH balance."),
    threshold: z.string().optional().describe("Optional minimum balance to check — returns sufficient/deficient flag"),
  },
  async ({ address, network, token, threshold }) => {
    try {
      const body = { address, network };
      if (token) body.token = token;
      if (threshold) body.threshold = threshold;
      const r = await fetchWithPay(`${SB}/cortex402-wallet-balance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      const receipt = getReceipt(r);
      return { content: [{ type: "text", text: formatWalletBalance(data, receipt) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `CorteX402 wallet_balance error: ${e.message}` }], isError: true };
    }
  }
);

// ─── Tool 7: Agent Session (CallAuth402) ─────────────────────────────────────
server.tool(
  "agent_session",
  [
    "Mint a CallAuth402 agent session — bridges wallet identity to voice or HTTPS channels with EIP-712 verification and on-chain attestation on Base mainnet.",
    "Returns a single-use 6-digit session code, expiration timestamp, and the on-chain attestation transaction hash.",
    "Costs $0.10 USDC per call. Settled on Base mainnet from your wallet.",
    "Use this when an agent needs to authenticate itself to another agent or service via a voice call or HTTPS handshake.",
  ].join(" "),
  {
    wallet: z.string().describe("EVM wallet address requesting the session"),
    channel: z.enum(["voice", "https"]).describe("Target channel for session redemption"),
    ttl_seconds: z.number().int().optional().default(900).describe("Session validity in seconds (default 900 = 15 min)"),
  },
  async ({ wallet, channel, ttl_seconds }) => {
    try {
      const r = await fetchWithPay(`${VCL}/api/auth/agent-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet, channel, ttl_seconds }),
      });
      const data = await r.json();
      const receipt = getReceipt(r);
      return { content: [{ type: "text", text: formatAgentSession(data, receipt) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `CorteX402 agent_session error: ${e.message}` }], isError: true };
    }
  }
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getReceipt(r) {
  const h = r.headers.get("x-payment-response");
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf-8")); } catch { return null; }
}

function txLine(receipt) {
  if (!receipt?.transaction) return "";
  return `\n\n— Paid on Base mainnet · tx: https://basescan.org/tx/${receipt.transaction}`;
}

function formatSanctions(data, receipt) {
  if (data.error) return `Error: ${data.error}`;
  const lines = [`**Sanctions screen** (${data.request_id})`, ""];
  lines.push(data.match ? `⚠️ MATCH — top score: ${data.score}` : `✓ No match (top score: ${data.score})`);
  if (data.matches?.length) {
    lines.push("", "Top matches:");
    for (const m of data.matches) {
      lines.push(`- **${m.name}** (${m.list || "?"}) — score ${m.score}`);
      if (m.url) lines.push(`  Verify: ${m.url}`);
    }
  }
  lines.push("", `Screened: ${data.screened_at} · TTL: ${data.ttl_seconds}s`);
  return lines.join("\n") + txLine(receipt);
}

function formatAviation(data, receipt) {
  if (data.error) return `Error: ${data.error}`;
  const lines = [`**Aviation weather** (${data.request_id})`, ""];
  for (const ap of data.airports || []) {
    if (ap.error) { lines.push(`### ${ap.icao} — ${ap.error}`, ""); continue; }
    lines.push(`### ${ap.icao} — ${ap.name || "?"}`);
    if (ap.metar) {
      lines.push(`METAR: ${ap.metar.flight_category || "?"} · ${ap.metar.temp_c}°C · wind ${ap.metar.wind_kt}kt`);
      lines.push(`Raw: \`${ap.metar.raw}\``);
    }
    if (ap.taf) lines.push(`TAF: ${ap.taf.raw}`);
    if (ap.forecast_24h?.length) lines.push(`24h: ${ap.forecast_24h.length} hourly readings`);
    lines.push("");
  }
  return lines.join("\n") + txLine(receipt);
}

function formatRates(data, receipt) {
  if (data.error) return `Error: ${data.error}`;
  const r = data.rates || {};
  const lines = [`**US mortgage & macro rates** (${data.request_id})`, ""];
  if (r.mortgage_30yr_pct) lines.push(`- **30yr fixed**: ${r.mortgage_30yr_pct.value}% (${r.mortgage_30yr_pct.as_of})`);
  if (r.mortgage_15yr_pct) lines.push(`- **15yr fixed**: ${r.mortgage_15yr_pct.value}% (${r.mortgage_15yr_pct.as_of})`);
  if (r.prime_pct)         lines.push(`- **Prime**: ${r.prime_pct.value}% (${r.prime_pct.as_of})`);
  if (r.fed_funds_pct)     lines.push(`- **Fed funds**: ${r.fed_funds_pct.value}% (${r.fed_funds_pct.as_of})`);
  if (r.cpi_yoy_pct)       lines.push(`- **CPI YoY**: ${r.cpi_yoy_pct.value}% (${r.cpi_yoy_pct.as_of})`);
  lines.push("", `Source: ${data.source}`);
  return lines.join("\n") + txLine(receipt);
}

function formatProperty(data, receipt) {
  if (data.error) return `Error: ${data.error}`;
  return JSON.stringify(data, null, 2) + txLine(receipt);
}

function formatTitleChain(data, receipt) {
  if (data.error) return `Error: ${data.error}`;
  const lines = [`**Title chain** (${data.request_id}) — ${data.match_status}`, ""];
  if (data.match_status !== "matched") { lines.push("No record found."); return lines.join("\n") + txLine(receipt); }
  const s = data.summary || {};
  lines.push(`${s.n_sales || 0} sales · ${s.n_mortgages || 0} mortgages · ${s.n_preforeclosure || 0} preforeclosure`);
  if (s.has_distress_signal) lines.push("⚠️ Distress flag on record");
  if (data.sales_history?.length) {
    lines.push("", "**Sales:**");
    for (const e of data.sales_history) lines.push(`- ${e.date || "?"} — ${e.amount ? "$" + Number(e.amount).toLocaleString() : "n/a"}`);
  }
  if (data.mortgage_history?.length) {
    lines.push("", "**Mortgages:**");
    for (const e of data.mortgage_history) lines.push(`- ${e.date || "?"} — ${e.loan_amount ? "$" + Number(e.loan_amount).toLocaleString() : "n/a"}${e.lender ? " · " + e.lender : ""}`);
  }
  return lines.join("\n") + txLine(receipt);
}

function formatWalletBalance(data, receipt) {
  if (data.error) return `Error: ${data.error}`;
  const lines = [`**Wallet balance** (${data.request_id})`, ""];
  lines.push(`Network: ${data.network} (chain ${data.chain_id})`);
  lines.push(`Address: ${data.address}`);
  if (data.token) lines.push(`Token: ${data.token.symbol} (${data.token.kind})`);
  lines.push(`Balance: ${data.balance?.formatted || data.balance?.raw || "?"}`);
  if (data.sufficient !== null && data.sufficient !== undefined) {
    lines.push(`Threshold check: ${data.sufficient ? "✓ sufficient" : "✗ deficient"}${data.deficit ? " (deficit: " + data.deficit + ")" : ""}`);
  }
  lines.push(`Block: ${data.block}`);
  return lines.join("\n") + txLine(receipt);
}

function formatAgentSession(data, receipt) {
  if (data.error) return `Error: ${data.error}`;
  const lines = [`**CallAuth402 session minted**`, ""];
  lines.push(`Session code: ${data.session_code}`);
  lines.push(`Expires: ${data.expires_at}`);
  if (data.attestation_tx) lines.push(`Attestation: https://basescan.org/tx/${data.attestation_tx}`);
  return lines.join("\n") + txLine(receipt);
}

// ─── Connect ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("CorteX402 MCP server v0.4.0 connected (stdio) — 7 tools ready.");
