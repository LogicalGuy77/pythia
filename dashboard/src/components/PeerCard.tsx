import { useState } from 'react'
import type { PeerRunState } from '../runState'

interface Props {
  peer: PeerRunState
}

function statusBadge(status: PeerRunState['status']) {
  switch (status) {
    case 'pending':   return { label: 'queued',     klass: 'badge' }
    case 'running':   return { label: 'inferring',  klass: 'badge badge--brand' }
    case 'received':  return { label: 'received',   klass: 'badge badge--accent' }
    case 'verifying': return { label: 'verifying',  klass: 'badge badge--brand' }
    case 'verified':  return { label: 'verified',   klass: 'badge badge--success' }
    case 'failed':    return { label: 'unverified', klass: 'badge badge--danger' }
    case 'error':     return { label: 'unreachable', klass: 'badge badge--danger' }
  }
}

export function PeerCard({ peer }: Props) {
  const [open, setOpen] = useState(false)
  const sb = statusBadge(peer.status)

  return (
    <article className="card peer-card">
      <div className="card-header">
        <div className="card-header-title">
          <span className="dot dot--brand" />
          <span>Peer</span>
        </div>
        <span className={sb.klass}>{sb.label}</span>
      </div>
      <div className="card-body">
        <div className="peer-title">
          <span className="peer-handle" title={peer.peerId}>
            {peer.shortId}
          </span>
          {peer.address && (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--text-tertiary)',
              }}
            >
              {peer.address}
            </span>
          )}
        </div>

        {peer.error ? (
          <div
            className="empty"
            style={{
              borderColor: 'var(--danger-border)',
              background: 'var(--danger-soft)',
              color: 'var(--danger)',
              textAlign: 'left',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
            }}
          >
            {peer.error}
          </div>
        ) : peer.output ? (
          <div className="peer-output">{peer.output}</div>
        ) : (
          <div className="skeleton" style={{ height: 80 }} />
        )}

        <div className="peer-meta-grid">
          <div className="peer-meta-tile">
            <div className="k">Receipt hash</div>
            <div className="v" title={peer.receiptHash ?? ''}>
              {peer.receiptHash ?? '—'}
            </div>
          </div>
          <div className="peer-meta-tile">
            <div className="k">Verification</div>
            <div className="v" title={peer.verifyMessage ?? ''}>
              {peer.verified === undefined
                ? '—'
                : peer.verified
                  ? '✓ ' + (peer.verifyMessage ?? 'OK')
                  : '✗ ' + (peer.verifyMessage ?? 'failed')}
            </div>
          </div>
        </div>

        {peer.receipt !== undefined && peer.receipt !== null && (
          <div className="expander">
            <button
              type="button"
              className="expander-head"
              onClick={() => setOpen((v) => !v)}
            >
              <span>{open ? '▾' : '▸'} REE receipt JSON</span>
              <span style={{ color: 'var(--text-tertiary)' }}>
                {open ? 'collapse' : 'expand'}
              </span>
            </button>
            {open && (
              <div className="expander-body">
                <pre>{JSON.stringify(peer.receipt, null, 2)}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  )
}
