import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.BRIDGE_PORT ?? "3001", 10);
const MIN_VERIFIED_PEERS = parseInt(process.env.MIN_VERIFIED_PEERS ?? "2", 10);

// Lazy singleton — constructed on first request so missing env vars surface
// as a 503 rather than a crash at startup.
let _client: DelphiClient | null = null;
function getClient(): DelphiClient {
  if (!_client) {
    const rawPrivateKey = process.env.WALLET_PRIVATE_KEY?.trim();
    const privateKey = rawPrivateKey
      ? (rawPrivateKey.startsWith("0x") ? rawPrivateKey : `0x${rawPrivateKey}`)
      : undefined;

    _client = new DelphiClient({
      signerType: process.env.DELPHI_SIGNER_TYPE === "private_key" ? "private_key" : undefined,
      privateKey: privateKey as `0x${string}` | undefined,
    });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TradeRequest {
  market_id: string;
  outcome_index: number;      // 0 = YES, 1 = NO
  amount_usdc: number;
  verified_receipts: object[];
}

interface QuoteRequest {
  market_id: string;
  outcome_index: number;
  amount_usdc: number;
}

// ---------------------------------------------------------------------------
// Middleware — check required env vars before any authenticated route
// ---------------------------------------------------------------------------

function requireEnv(_req: Request, res: Response, next: NextFunction): void {
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
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", minVerifiedPeers: MIN_VERIFIED_PEERS });
});

// GET /markets — list open prediction markets
app.get("/markets", requireEnv, async (_req: Request, res: Response) => {
  try {
    const { markets } = await getClient().listMarkets({ status: "open" });
    res.json({ markets });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// GET /markets/:id — fetch a single market by id or implementation address
app.get("/markets/:id", requireEnv, async (req: Request, res: Response) => {
  try {
    const result = await getClient().listMarkets({ status: "open" });
    const markets = result?.markets || [];
    const market = markets.find(
      (m: { id: string; implementation: string }) =>
        m.id === req.params.id || m.implementation === req.params.id
    );
    if (!market) {
      res.status(404).json({ error: `Market '${req.params.id}' not found` });
      return;
    }
    res.json({ market });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// GET /wallet — read-only wallet/balance check
app.get("/wallet", requireEnv, async (_req: Request, res: Response) => {
  try {
    const client = getClient();
    const signer = await client.getSigner();
    const ethBalance = await client.getEthBalance();
    const tokenBalance = await client.getErc20BalanceWithDecimals();
    const positions = await client.listPositions({ wallet: signer.address });

    res.json({
      address: signer.address,
      network: process.env.DELPHI_NETWORK ?? "testnet",
      eth: {
        wei: ethBalance.toString(),
        ether: (Number(ethBalance) / 1e18).toFixed(8),
      },
      token: {
        raw: tokenBalance.balance.toString(),
        decimals: tokenBalance.decimals,
        formatted: (Number(tokenBalance.balance) / 10 ** tokenBalance.decimals).toString(),
      },
      positionsCount: positions.positions?.length ?? 0,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// POST /quote — read-only quote for a prospective buy
// Body: { market_id, outcome_index, amount_usdc }
app.post("/quote", requireEnv, async (req: Request, res: Response) => {
  const body = req.body as Partial<QuoteRequest>;

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

  try {
    const client = getClient();
    const result = await client.listMarkets({ status: "open" });
    const markets = result?.markets || [];
    const market = markets.find(
      (m: { id: string; implementation: string }) =>
        m.id === body.market_id || m.implementation === body.market_id
    );
    if (!market) {
      res.status(404).json({ error: `Market '${body.market_id}' not found or not open` });
      return;
    }

    const marketAddress = market.id as `0x${string}`;
    const sharesOut = BigInt(Math.round(body.amount_usdc * 1e18));
    const maxTokensIn = BigInt(Math.round(body.amount_usdc * 1.2 * 1e6));
    const quote = await client.quoteBuy({
      marketAddress,
      outcomeIdx: body.outcome_index,
      sharesOut,
    });

    res.json({
      marketId: market.id,
      marketAddress,
      outcomeIdx: body.outcome_index,
      sharesOut: sharesOut.toString(),
      quotedTokensIn: quote.tokensIn.toString(),
      maxTokensIn: maxTokensIn.toString(),
      quotedUsdc: Number(quote.tokensIn) / 1e6,
      maxUsdc: Number(maxTokensIn) / 1e6,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// POST /trade — execute a prediction market buy
// Body: { market_id, outcome_index, amount_usdc, verified_receipts[] }
app.post("/trade", requireEnv, async (req: Request, res: Response) => {
  const body = req.body as Partial<TradeRequest>;

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
      error:
        `Insufficient verified peers: got ${body.verified_receipts.length}, ` +
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
    const market = markets.find(
      (m: { id: string; implementation: string }) =>
        m.id === body.market_id || m.implementation === body.market_id
    );
    if (!market) {
      res.status(404).json({ error: `Market '${body.market_id}' not found or not open` });
      return;
    }
    const marketAddress = market.id as `0x${string}`;

    // 2. Convert amount to on-chain units
    //    sharesOut uses 18 decimals; maxTokensIn uses USDC 6 decimals + 20% slippage buffer
    const sharesOut   = BigInt(Math.round(body.amount_usdc * 1e18));
    const maxTokensIn = BigInt(Math.round(body.amount_usdc * 1.2 * 1e6));

    // 3. Refuse before spending gas if the wallet cannot cover the max spend.
    const tokenBalance = await client.getErc20BalanceWithDecimals();
    if (tokenBalance.balance < maxTokensIn) {
      res.status(422).json({
        error:
          `Insufficient Delphi token balance: have ${tokenBalance.balance.toString()} ` +
          `raw units, need at least ${maxTokensIn.toString()} raw units.`,
        tokenDecimals: tokenBalance.decimals,
      });
      return;
    }

    // 4. Ensure only the needed token spend is approved. This avoids repeated
    // approvals and does not grant unlimited allowance.
    console.log(`[trade] Ensuring token approval for market ${marketAddress}...`);
    await client.ensureTokenApproval({
      marketAddress,
      minimumAmount: maxTokensIn,
      approveAmount: maxTokensIn,
    });

    const outcomeLabel = body.outcome_index === 0 ? "YES" : "NO";
    console.log(
      `[trade] Buying ${outcomeLabel} shares — ` +
      `sharesOut=${sharesOut}  maxTokensIn=${maxTokensIn}  ` +
      `market=${marketAddress}`
    );

    // 5. Buy shares
    const { transactionHash } = await client.buyShares({
      marketAddress,
      outcomeIdx:  body.outcome_index,
      sharesOut,
      maxTokensIn,
    });

    console.log(`[trade] Done. txHash=${transactionHash}`);

    res.json({
      success:          true,
      transactionHash,
      marketAddress,
      outcomeIdx:       body.outcome_index,
      outcomeLabel,
      sharesOut:        sharesOut.toString(),
      verifiedPeers:    body.verified_receipts.length,
    });

  } catch (err: unknown) {
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
