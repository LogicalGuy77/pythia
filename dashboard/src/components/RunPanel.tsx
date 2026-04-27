import { useEffect, useRef } from 'react'
import type { Market } from '../types'
import type { TimelineEntry } from '../runState'
import { marketTitle } from '../marketHelpers'

interface Props {
  selectedMarket: Market | null
  onClearMarket: () => void
  prompt: string
  onPromptChange: (s: string) => void
  amount: number
  onAmountChange: (n: number) => void
  minVerified: number
  onMinVerifiedChange: (n: number) => void
  verify: boolean
  onVerifyChange: (b: boolean) => void
  running: boolean
  onRun: () => void
  onCancel: () => void
  timeline: TimelineEntry[]
  fatalError: string | null
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleTimeString([], { hour12: false })
}

export function RunPanel({
  selectedMarket,
  onClearMarket,
  prompt,
  onPromptChange,
  amount,
  onAmountChange,
  minVerified,
  onMinVerifiedChange,
  verify,
  onVerifyChange,
  running,
  onRun,
  onCancel,
  timeline,
  fatalError,
}: Props) {
  const tlRef = useRef<HTMLDivElement | null>(null)

  // Auto-scroll the timeline to the newest entry as events stream in.
  useEffect(() => {
    const el = tlRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [timeline.length])

  return (
    <section className="card run-card">
      <div className="card-header">
        <div className="card-header-title">
          <span>Inference Run</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {running && (
            <span className="badge badge--brand">
              <span className="dot dot--brand" /> live
            </span>
          )}
          {!running && timeline.length > 0 && (
            <span className="badge badge--success">complete</span>
          )}
        </div>
      </div>

      <div className="card-body">
        {selectedMarket ? (
          <div className="market-chip">
            <div className="market-chip-info">
              <div className="market-chip-q">{marketTitle(selectedMarket)}</div>
              <div className="market-chip-id">{selectedMarket.id}</div>
            </div>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ padding: '6px 10px', fontSize: 11 }}
              onClick={onClearMarket}
              disabled={running}
            >
              Clear
            </button>
          </div>
        ) : (
          <div className="empty">
            Select a market on the left to settle the consensus on-chain — or run
            inference without trading.
          </div>
        )}

        <div>
          <label
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 10.5,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--text-tertiary)',
              fontWeight: 600,
              display: 'block',
              marginBottom: 6,
            }}
          >
            Prompt
          </label>
          <textarea
            className="textarea"
            placeholder="Will ETH be above $3000 at the end of 2025? Give a numeric probability percentage."
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            disabled={running}
            rows={3}
          />
        </div>

        <div className="run-form-grid">
          <label>
            Trade amount (USDC)
            <input
              className="input"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => onAmountChange(parseFloat(e.target.value) || 0)}
              disabled={running}
            />
          </label>
          <label>
            Min verified peers
            <input
              className="input"
              type="number"
              min="1"
              step="1"
              value={minVerified}
              onChange={(e) => onMinVerifiedChange(parseInt(e.target.value, 10) || 1)}
              disabled={running}
            />
          </label>
          <label>
            Receipt verification
            <select
              className="input"
              value={verify ? 'on' : 'off'}
              onChange={(e) => onVerifyChange(e.target.value === 'on')}
              disabled={running}
            >
              <option value="on">REE re-run</option>
              <option value="off">Skip (faster)</option>
            </select>
          </label>
        </div>

        <div className="run-actions">
          <span className="run-hint">
            {selectedMarket
              ? `Will trade up to ${amount} USDC on this market if ≥${minVerified} peers verify.`
              : 'No market selected — inference only, no trade.'}
          </span>
          {running ? (
            <button
              type="button"
              className="btn"
              onClick={onCancel}
              style={{ borderColor: 'var(--danger-border)', color: 'var(--danger)' }}
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={onRun}
              disabled={!prompt.trim()}
            >
              <span>▶</span> Run inference
            </button>
          )}
        </div>

        {fatalError && (
          <div
            className="empty"
            style={{
              borderColor: 'var(--danger-border)',
              background: 'var(--danger-soft)',
              color: 'var(--danger)',
              textAlign: 'left',
            }}
          >
            {fatalError}
          </div>
        )}

        {timeline.length > 0 && (
          <>
            <div className="divider" />
            <h3
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 12,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--text-secondary)',
                marginBottom: 4,
              }}
            >
              Live Timeline
            </h3>
            <div
              ref={tlRef}
              className="timeline"
              style={{ maxHeight: 260, overflowY: 'auto', paddingRight: 4 }}
            >
              {timeline.map((entry, idx) => (
                <div key={idx} className="tl-row" data-kind={entry.kind}>
                  <div className="tl-time">{fmtTime(entry.ts)}</div>
                  <div className="tl-marker" />
                  <div className="tl-content">
                    <div className="tl-title">{entry.title}</div>
                    {entry.detail && (
                      <div className="tl-detail">{entry.detail}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
