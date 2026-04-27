// Shared types between the dashboard UI and the Pythia api_server.

export interface Health {
  ok: boolean
  services: {
    axl?: { ok: boolean; port: number; error?: string }
    delphi?: { ok: boolean; url: string; error?: string; data?: unknown }
    ree?: { ok: boolean; path: string }
  }
}

export interface Peer {
  publicKey: string
  address: string
}

export interface Topology {
  ourPublicKey: string | null
  peerCount: number
  peers: Peer[]
}

export interface Wallet {
  address: string
  network: string
  eth: { wei: string; ether: string }
  token: { raw: string; decimals: number; formatted: string }
  positionsCount: number
}

export interface MarketMetadata {
  question?: string
  outcomes?: string[]
  initial_liquidity?: string | number
  model?: { model_identifier?: string; prompt_context?: string }
  version?: string
}

export interface Market {
  id: string
  implementation?: string
  status?: string
  category?: string
  settlesAt?: string
  resolvesAt?: string
  createdAt?: string
  metadata?: MarketMetadata
  // SDK responses include other fields too — keep open
  [key: string]: unknown
}

export interface MarketsResponse {
  markets: Market[]
}

// ---- SSE event payloads ----

export interface StatusEvent {
  phase:
    | 'discover'
    | 'inference'
    | 'verify'
    | 'aggregate'
    | 'trade'
  message: string
  peerId?: string
}

export interface PeerStartedEvent {
  peerId: string
  shortId: string
  address?: string
}

export interface PeerOutputEvent {
  peerId: string
  shortId: string
  output?: string
  receiptHash?: string | null
  receipt?: unknown
  error?: string
}

export interface PeerVerifiedEvent {
  peerId: string
  shortId: string
  verified: boolean
  message: string
}

export interface ConsensusEvent {
  verifiedCount: number
  totalCount: number
  perPeer: Array<{
    peerId: string
    shortId: string
    probability: number | null
  }>
  consensusProbability: number | null
}

export interface TradeDecisionEvent {
  decision: 'trade' | 'abstain' | 'abort' | 'skipped'
  outcomeIndex?: number
  outcomeLabel?: string
  consensus?: number | null
  amountUsdc?: number
  marketId?: string
  verifiedPeers?: number
  rationale?: string
  reason?: string
}

export interface TradeResultEvent {
  ok: boolean
  transactionHash?: string
  marketAddress?: string
  outcomeLabel?: string
  outcomeIndex?: number
  sharesOut?: string
  verifiedPeers?: number
  error?: string
}

export interface DoneEvent {
  ok: boolean
}

export interface ErrorEvent {
  message: string
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface PersistedRunSummary {
  consensus?: ConsensusEvent
  trade_decision?: TradeDecisionEvent
  trade_result?: TradeResultEvent
  error?: ErrorEvent
  done?: DoneEvent
}

export interface RunSummary {
  id: string
  createdAt: number
  updatedAt: number
  status: RunStatus
  prompt: string
  marketId: string | null
  amountUsdc: number
  minVerifiedPeers: number
  verify: boolean
  summary: PersistedRunSummary
}

export interface PersistedRunEvent {
  id: number
  ts: number
  event: RunEvent['event']
  data: RunEvent['data']
}

export interface PersistedRun extends RunSummary {
  events: PersistedRunEvent[]
}

export interface RunsResponse {
  runs: RunSummary[]
}

export type RunEvent =
  | { event: 'status';         data: StatusEvent }
  | { event: 'topology';       data: Topology }
  | { event: 'peer_started';   data: PeerStartedEvent }
  | { event: 'peer_output';    data: PeerOutputEvent }
  | { event: 'peer_verified';  data: PeerVerifiedEvent }
  | { event: 'consensus';      data: ConsensusEvent }
  | { event: 'trade_decision'; data: TradeDecisionEvent }
  | { event: 'trade_result';   data: TradeResultEvent }
  | { event: 'done';           data: DoneEvent }
  | { event: 'error';          data: ErrorEvent }
