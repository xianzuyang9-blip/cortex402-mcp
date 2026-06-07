# cortex402-mcp

[![CorteX402 MCP server](https://glama.ai/mcp/servers/Ooak21/cortex402-mcp/badges/score.svg)](https://glama.ai/mcp/servers/Ooak21/cortex402-mcp)

MCP server for **CorteX402** — exposes pay-per-call x402 data products as Claude-callable tools. Settles in USDC on Base mainnet.

## Tools

| Tool | Cost | Description |
|---|---|---|
| `sanctions_screen` | $0.50 USDC | OFAC/UN/EU/UK + 100+ sanctions lists. Name + DOB + country in, normalized match score with provenance out. Source: OpenSanctions. |
| `aviation_weather` | $0.10 USDC | METAR + TAF + 24h forecast for ICAO airports (batch up to 10). Sources: NOAA AviationWeather + Open-Meteo. |
| `property_dossier` | $2.00 USDC | US address → 50-field property + demographics + risk dossier. **Currently in development** (returns clean status, no payment taken). |

## Install — Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cortex402": {
      "command": "npx",
      "args": ["-y", "cortex402-mcp"],
      "env": {
        "CORTEX402_WALLET_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

Restart Claude Desktop. The three CorteX402 tools become available to Claude.

## Install — Claude Code

```bash
claude mcp add cortex402 -- npx -y cortex402-mcp
```

Then set the env var in your shell or in the config file produced.

## Wallet setup

You need a wallet with USDC on **Base mainnet** (NOT Base Sepolia, NOT Ethereum mainnet). The wallet's private key goes in the `CORTEX402_WALLET_PRIVATE_KEY` env var.

**Easiest funding path:**
1. Coinbase Wallet (self-custody app, not the exchange) → Buy crypto → USDC on Base network → debit card
2. ~$5 USDC gives ~50 sanctions checks or ~50 aviation queries
3. Export the private key from Coinbase Wallet (Settings → Show recovery phrase → derive key)

Or use any existing Base mainnet wallet that you control the private key for.

## What happens per call

1. Claude decides one of the CorteX402 tools is relevant to your question
2. The MCP server constructs the request and calls the corresponding `cortex402.vercel.app` endpoint
3. The endpoint returns HTTP 402 with payment requirements
4. The MCP server signs an EIP-3009 USDC transfer authorization with your wallet
5. Coinbase's CDP-authenticated facilitator settles the transfer on Base mainnet
6. The endpoint returns the data + an on-chain transaction hash receipt
7. Claude formats and returns the data to you

Total time per call: ~3–4 seconds end-to-end. No accounts, no API keys, no monthly minimums.

## Security

- Your private key is stored in your MCP client config and read via env var by this MCP server. The server never logs or transmits it.
- All payments happen wallet-to-wallet on Base mainnet. No platform takes a cut.
- Each successful call returns a Base mainnet transaction hash, permanently auditable.

## Endpoints + receiving wallets (canonical)

- Sanctions: `0x8A74c239DeDc0bB9Ee68eAEeC168Cca985f82F58`
- Aviation: `0x41a90Fc1D1D7FE22aCc8aB1DdB978ed65205C56F`
- Property: `0x420999608f6f05a007a89EAa77BcE8D81bd3Ae4B`

All on Base mainnet. View any of them on https://basescan.org/.

## Links

- **Catalog page:** https://innovativeblockchainsolutions.live/CorteX402/
- **Machine-readable manifest:** https://cortex402.vercel.app/.well-known/skill.md
- **Source:** https://github.com/Ooak21/cortex402-mcp
- **x402 protocol spec:** https://x402.org

## License

MIT. Built by Innovative Blockchain Solutions.
