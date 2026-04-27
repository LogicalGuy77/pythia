import "dotenv/config";
import express from "express";
import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
const app = express();
app.use(express.json());
const PORT = parseInt(process.env.BRIDGE_PORT ?? "3001", 10);
const MIN_VERIFIED_PEERS = parseInt(process.env.MIN_VERIFIED_PEERS ?? "2", 10);
// Lazy singleton — constructed on first request so missing env vars surface
// as a 503 rather than a crash at startup.
let _client = null;
function getClient() {
    if (!_client) {
        _client = new DelphiClient();
    }
    return _client;
}
// ---------------------------------------------------------------------------
// Middleware — check required env vars before any authenticated route
// ---------------------------------------------------------------------------
function requireEnv(_req, res, next) {
    const missing = ["DELPHI_API_ACCESS_KEY", "WALLET_PRIVATE_KEY", "DELPHI_NETWORK"]
        .filter((k) => !process.env[k]);
    if (missing.length > 0) {
        res.status(503).json({
            error: `Missing required environment variables: ${missing.join(", ")}`,
        });
        return;
    }
    next();
}
// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
// GET /health
app.get("/health", (_req, res) => {
    res.json({ status: "ok", minVerifiedPeers: MIN_VERIFIED_PEERS });
});
// GET /markets — list open prediction markets
app.get("/markets", requireEnv, async (_req, res) => {
    try {
        const { markets } = await getClient().listMarkets({ status: "open" });
        res.json({ markets });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
    }
});
// GET /markets/:id — fetch a single market by id or implementation address
app.get("/markets/:id", requireEnv, async (req, res) => {
    try {
        const result = await getClient().listMarkets({ status: "open" });
        const markets = result?.markets || [];
        const market = markets.find((m) => m.id === req.params.id || m.implementation === req.params.id);
        if (!market) {
            res.status(404).json({ error: `Market '${req.params.id}' not found` });
            return;
        }
        res.json({ market });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
    }
});
// POST /trade — execute a prediction market buy
// Body: { market_id, outcome_index, amount_usdc, verified_receipts[] }
app.post("/trade", requireEnv, async (req, res) => {
    const body = req.body;
    // Validate request fields
    if (!body.market_id || typeof body.market_id !== "string") {
        res.status(400).json({ error: "market_id is required and must be a string" });
        return;
    }
    if (body.outcome_index === undefined || ![0, 1].includes(body.outcome_index)) {
        res.status(400).json({ error: "outcome_index must be 0 (YES) or 1 (NO)" });
        return;
    }
    if (!body.amount_usdc || body.amount_usdc <= 0) {
        res.status(400).json({ error: "amount_usdc must be a positive number" });
        return;
    }
    if (!Array.isArray(body.verified_receipts)) {
        res.status(400).json({ error: "verified_receipts must be an array" });
        return;
    }
    // Enforce minimum peer verification — never trade on unverified inference
    if (body.verified_receipts.length < MIN_VERIFIED_PEERS) {
        res.status(422).json({
            error: `Insufficient verified peers: got ${body.verified_receipts.length}, ` +
                `need at least ${MIN_VERIFIED_PEERS}. ` +
                "Trade refused — REE receipts required before on-chain settlement.",
        });
        return;
    }
    const client = getClient();
    try {
        // 1. Resolve market address from the market list
        const result = await client.listMarkets({ status: "open" });
        const markets = result?.markets || [];
        const market = markets.find((m) => m.id === body.market_id || m.implementation === body.market_id);
        if (!market) {
            res.status(404).json({ error: `Market '${body.market_id}' not found or not open` });
            return;
        }
        const marketAddress = market.implementation;
        // 2. Approve token spend (idempotent — safe to call on every trade)
        console.log(`[trade] Approving token spend for market ${marketAddress}...`);
        await client.approveToken({ marketAddress });
        // 3. Convert amount to on-chain units
        //    sharesOut uses 18 decimals; maxTokensIn uses USDC 6 decimals + 20% slippage buffer
        const sharesOut = BigInt(Math.round(body.amount_usdc * 1e18));
        const maxTokensIn = BigInt(Math.round(body.amount_usdc * 1.2 * 1e6));
        const outcomeLabel = body.outcome_index === 0 ? "YES" : "NO";
        console.log(`[trade] Buying ${outcomeLabel} shares — ` +
            `sharesOut=${sharesOut}  maxTokensIn=${maxTokensIn}  ` +
            `market=${marketAddress}`);
        // 4. Buy shares
        const { transactionHash } = await client.buyShares({
            marketAddress,
            outcomeIdx: body.outcome_index,
            sharesOut,
            maxTokensIn,
        });
        console.log(`[trade] Done. txHash=${transactionHash}`);
        res.json({
            success: true,
            transactionHash,
            marketAddress,
            outcomeIdx: body.outcome_index,
            outcomeLabel,
            sharesOut: sharesOut.toString(),
            verifiedPeers: body.verified_receipts.length,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[trade] Error:", err);
        res.status(500).json({ error: msg });
    }
});
// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, "127.0.0.1", () => {
    console.log(`Pythia delphi_bridge listening on http://127.0.0.1:${PORT}`);
    console.log(`MIN_VERIFIED_PEERS = ${MIN_VERIFIED_PEERS}`);
    console.log(`DELPHI_NETWORK     = ${process.env.DELPHI_NETWORK ?? "(unset)"}`);
});
