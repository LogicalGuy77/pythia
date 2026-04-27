import type { ResearchEvent } from '../types'

interface Props {
  research: ResearchEvent
}

function fmtGeneratedAt(value: string) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function ResearchContext({ research }: Props) {
  return (
    <section className="card research-card">
      <div className="card-header">
        <div className="card-header-title">
          <span>Research Context</span>
        </div>
        <span className={research.ok ? 'badge badge--brand' : 'badge badge--warning'}>
          Exa
        </span>
      </div>
      <div className="card-body">
        <div className="research-query">
          <span className="k">Query</span>
          <span className="v">{research.query}</span>
        </div>
        <div className="research-time">
          fetched {fmtGeneratedAt(research.generatedAt)}
        </div>

        {!research.ok ? (
          <div className="empty">{research.error ?? 'No Exa results available.'}</div>
        ) : research.results.length === 0 ? (
          <div className="empty">Exa returned no sources for this question.</div>
        ) : (
          <div className="research-list">
            {research.results.map((result, idx) => (
              <article key={`${result.url ?? result.title}-${idx}`} className="research-source">
                <div className="research-source-head">
                  <span className="research-index">{idx + 1}</span>
                  {result.url ? (
                    <a href={result.url} target="_blank" rel="noreferrer">
                      {result.title}
                    </a>
                  ) : (
                    <span>{result.title}</span>
                  )}
                </div>
                {(result.publishedDate || result.author) && (
                  <div className="research-meta">
                    {result.publishedDate && <span>{result.publishedDate}</span>}
                    {result.author && <span>{result.author}</span>}
                  </div>
                )}
                {result.summary && <p>{result.summary}</p>}
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
