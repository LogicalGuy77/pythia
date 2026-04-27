import type { Market, Topology, Wallet } from '../types'
import {
  fmtSettles,
  marketOutcomes,
  marketSettlesAt,
  marketTitle,
} from '../marketHelpers'

interface Props {
  wallet: Wallet | null
  walletError: string | null
  topology: Topology | null
  topologyError: string | null
  markets: Market[]
  marketsError: string | null
  marketsLoading: boolean
  selectedMarketId: string | null
  onSelectMarket: (m: Market) => void
  onRefreshMarkets: () => void
}

function shortKey(k: string | null | undefined, head = 8, tail = 6) {
  if (!k) return '—'
  return `${k.slice(0, head)}…${k.slice(-tail)}`
}

function formatAmount(s: string | number | undefined, decimals = 4) {
  const n = typeof s === 'number' ? s : parseFloat(String(s ?? '0'))
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0'
  if (n < 0.0001) return n.toExponential(2)
  return n.toFixed(decimals)
}

export function Sidebar({
  wallet,
  walletError,
  topology,
  topologyError,
  markets,
  marketsError,
  marketsLoading,
  selectedMarketId,
  onSelectMarket,
  onRefreshMarkets,
}: Props) {
  return (
    <aside className="sidebar">
      {/* Wallet */}
      <section className="card wallet-card">
        <div className="card-header">
          <div className="card-header-title">
            <span>Wallet</span>
          </div>
          {wallet && <span className="badge badge--brand">{wallet.network}</span>}
        </div>
        <div className="card-body">
          {walletError ? (
            <div className="empty">{walletError}</div>
          ) : !wallet ? (
            <>
              <div className="skeleton" style={{ height: 28 }} />
              <div className="balance-row">
                <div className="skeleton" style={{ height: 56 }} />
                <div className="skeleton" style={{ height: 56 }} />
              </div>
            </>
          ) : (
            <>
              <div className="wallet-address" title={wallet.address}>
                {wallet.address}
              </div>
              <div className="balance-row">
                <div className="balance-tile">
                  <div className="balance-label">ETH</div>
                  <div className="balance-value">
                    {formatAmount(wallet.eth.ether, 4)}
                  </div>
                </div>
                <div className="balance-tile">
                  <div className="balance-label">USDC</div>
                  <div className="balance-value">
                    {formatAmount(wallet.token.formatted, 2)}
                  </div>
                </div>
              </div>
              <div className="kv">
                <span className="k">Open positions</span>
                <span className="v">{wallet.positionsCount}</span>
              </div>
            </>
          )}
        </div>
      </section>

      {/* Network */}
      <section className="card">
        <div className="card-header">
          <div className="card-header-title">
            <span>Network</span>
          </div>
          <span className="badge">
            {topology ? `${topology.peerCount} peer${topology.peerCount === 1 ? '' : 's'}` : '—'}
          </span>
        </div>
        <div className="card-body">
          {topologyError ? (
            <div className="empty">{topologyError}</div>
          ) : !topology ? (
            <>
              <div className="skeleton" style={{ height: 32, marginBottom: 8 }} />
              <div className="skeleton" style={{ height: 32 }} />
            </>
          ) : (
            <>
              <div className="kv" style={{ paddingTop: 0 }}>
                <span className="k">Coordinator</span>
                <span className="v">{shortKey(topology.ourPublicKey)}</span>
              </div>
              <div className="divider" />
              {topology.peers.length === 0 ? (
                <div className="empty">
                  No peers connected yet.
                  <br />
                  Run <code>./start_node.sh 1</code>.
                </div>
              ) : (
                <div className="peer-list">
                  {topology.peers.map((p) => (
                    <div key={p.publicKey} className="peer-row">
                      <span className="dot dot--live" />
                      <span className="peer-id" title={p.publicKey}>
                        {shortKey(p.publicKey, 12, 8)}
                      </span>
                      <span className="peer-addr">{p.address}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* Markets */}
      <section className="card markets-card">
        <div className="card-header">
          <div className="card-header-title">
            <span>Markets</span>
            {marketsLoading && <span className="dot dot--brand" />}
          </div>
          <button
            className="btn btn--ghost"
            style={{ padding: '4px 10px', fontSize: 11 }}
            onClick={onRefreshMarkets}
            disabled={marketsLoading}
            type="button"
          >
            Refresh
          </button>
        </div>
        <div className="card-body">
          {marketsError ? (
            <div className="empty" style={{ margin: 18 }}>
              {marketsError}
            </div>
          ) : marketsLoading && markets.length === 0 ? (
            <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton" style={{ height: 64 }} />
              ))}
            </div>
          ) : markets.length === 0 ? (
            <div className="empty" style={{ margin: 18 }}>
              No open markets right now.
            </div>
          ) : (
            markets.map((m) => {
              const settles = fmtSettles(marketSettlesAt(m))
              const outcomes = marketOutcomes(m).join(' · ')
              return (
                <button
                  key={m.id}
                  type="button"
                  className="market-row"
                  data-selected={m.id === selectedMarketId}
                  onClick={() => onSelectMarket(m)}
                  aria-pressed={m.id === selectedMarketId}
                >
                  <div className="market-q">{marketTitle(m)}</div>
                  <div className="market-meta">
                    <span title={m.id}>{shortKey(m.id, 6, 4)}</span>
                    <span className="sep" />
                    <span>{outcomes}</span>
                    {settles && (
                      <>
                        <span className="sep" />
                        <span>{settles}</span>
                      </>
                    )}
                    {m.category && (
                      <>
                        <span className="sep" />
                        <span>{m.category}</span>
                      </>
                    )}
                  </div>
                </button>
              )
            })
          )}
        </div>
      </section>
    </aside>
  )
}
