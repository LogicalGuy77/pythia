import type { TradeDecisionEvent, TradeResultEvent } from '../types'

interface Props {
  decision: TradeDecisionEvent | null
  result: TradeResultEvent | null
  network?: string
}

function explorerLink(network: string | undefined, txHash: string): string {
  // Gensyn testnet is currently indexed by Alchemy's Blockscout instance.
  if ((network ?? '').toLowerCase().includes('test')) {
    return `https://gensyn-testnet.explorer.alchemy.com/tx/${txHash}`
  }
  if ((network ?? '').toLowerCase().includes('main')) {
    return `https://explorer.gensyn.ai/tx/${txHash}`
  }
  return `https://www.google.com/search?q=${txHash}`
}

export function Trade({ decision, result, network }: Props) {
  if (!decision) return null

  const isTrade = decision.decision === 'trade'
  const headerBadgeKlass =
    decision.decision === 'trade'
      ? 'badge badge--brand'
      : decision.decision === 'abstain'
        ? 'badge badge--warning'
        : decision.decision === 'abort'
          ? 'badge badge--danger'
          : 'badge'

  return (
    <section className="card trade-card">
      <div className="card-header">
        <div className="card-header-title">
          <span>On-chain Trade</span>
        </div>
        <span className={headerBadgeKlass}>{decision.decision.toUpperCase()}</span>
      </div>
      <div className="card-body">
        {isTrade ? (
          <>
            <div className="trade-result">
              <div className="kv" style={{ paddingTop: 0 }}>
                <span className="k">Outcome</span>
                <span className="v">
                  {decision.outcomeLabel} (index {decision.outcomeIndex})
                </span>
              </div>
              <div className="kv">
                <span className="k">Amount</span>
                <span className="v">{decision.amountUsdc} USDC</span>
              </div>
              <div className="kv">
                <span className="k">Verified peers</span>
                <span className="v">{decision.verifiedPeers}</span>
              </div>
              {decision.consensus !== null && decision.consensus !== undefined && (
                <div className="kv">
                  <span className="k">Consensus</span>
                  <span className="v">
                    {(decision.consensus * 100).toFixed(1)}%
                  </span>
                </div>
              )}
              {decision.rationale && (
                <div className="kv">
                  <span className="k">Rationale</span>
                  <span className="v" style={{ textAlign: 'right' }}>
                    {decision.rationale}
                  </span>
                </div>
              )}
            </div>

            {result === null ? (
              <div className="empty">
                <span className="dot dot--brand" /> &nbsp;Submitting transaction…
              </div>
            ) : result.ok && result.transactionHash ? (
              <div className="trade-result">
                <div className="kv" style={{ paddingTop: 0 }}>
                  <span className="k">Tx hash</span>
                  <a
                    className="tx-link"
                    href={explorerLink(network, result.transactionHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {result.transactionHash}
                  </a>
                </div>
                {result.marketAddress && (
                  <div className="kv">
                    <span className="k">Market</span>
                    <span className="v" title={result.marketAddress}>
                      {result.marketAddress}
                    </span>
                  </div>
                )}
                {result.sharesOut && (
                  <div className="kv">
                    <span className="k">Shares out (raw)</span>
                    <span className="v">{result.sharesOut}</span>
                  </div>
                )}
              </div>
            ) : (
              <div
                className="empty"
                style={{
                  borderColor: 'var(--danger-border)',
                  background: 'var(--danger-soft)',
                  color: 'var(--danger)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  textAlign: 'left',
                }}
              >
                {result.error ?? 'Trade failed'}
              </div>
            )}
          </>
        ) : (
          <div className="empty" style={{ textAlign: 'left' }}>
            <strong style={{ color: 'var(--text-primary)' }}>
              {decision.decision === 'abstain'
                ? 'Abstaining from trade.'
                : decision.decision === 'abort'
                  ? 'Trade aborted.'
                  : 'Pure-inference run — no market selected.'}
            </strong>
            {decision.reason && (
              <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                {decision.reason}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
