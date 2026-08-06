'use client';

import { useCallback, useEffect, useState } from 'react';
import { get, post } from '@/lib/api';
import styles from './board.module.css';

interface Card {
  id: string;
  key: string;
  title: string;
  columnKey: string;
  spec: {
    id: string;
    version: number;
    status: string;
    citationCount: number;
    unverifiedCount: number;
    approvedBy: string | null;
  } | null;
}

interface Column {
  key: string;
  name: string;
}

interface SpecContent {
  requirements: { story: string; criteria: { keyword: string; trigger: string; response: string }[] }[];
  design: { text: string; citation?: string; unverified?: string }[];
  tasks: { id: string; title: string; size: string; repo?: string; asBuilt?: boolean }[];
  outOfScope?: string[];
  openQuestions?: string[];
}

interface SpecView {
  id: string;
  ticketId: string;
  ticketKey: string;
  title: string;
  version: number;
  status: string;
  content: SpecContent;
  citationCount: number;
  unverifiedCount: number;
  approvedBy: string | null;
  approvedAt: string | null;
}

interface TicketDetail {
  ticket: { id: string; key: string; title: string; body: string };
  spec: SpecView | null;
  versions: { id: string; version: number; status: string }[];
  comments: { id: string; section: string; authorName: string; body: string }[];
}

export function BoardView({ slug, onChange }: { slug: string; onChange: () => void }) {
  const [columns, setColumns] = useState<Column[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [tab, setTab] = useState<'req' | 'des' | 'tas'>('req');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');

  const load = useCallback(async () => {
    const board = await get<{ columns: Column[]; cards: Card[] }>(`/projects/${slug}/board`);
    setColumns(board.columns);
    setCards(board.cards);
  }, [slug]);

  useEffect(() => {
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed'));
  }, [load]);

  const openCard = useCallback(
    async (ticketId: string) => {
      setOpen(ticketId);
      setTab('req');
      setDetail(null);
      const d = await get<TicketDetail>(`/projects/${slug}/board/tickets/${ticketId}`);
      setDetail(d);
    },
    [slug],
  );

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await load();
      if (open) await openCard(open);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  }

  const spec = detail?.spec ?? null;

  return (
    <div className={styles.wrap}>
      {error && <div className="err">{error}</div>}

      <div className={styles.toolbar}>
        <button type="button" className="btn sm" onClick={() => setComposing(!composing)}>
          + New ticket
        </button>
        <span className={styles.hint}>
          Generating a spec is a deliberate click on a ticket — never automatic.
        </span>
      </div>

      {composing && (
        <div className={`card ${styles.compose}`}>
          <div className="field">
            <label htmlFor="tt">Title</label>
            <input id="tt" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label htmlFor="tb">The business ask, in plain language</label>
            <textarea
              id="tb"
              rows={4}
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              placeholder="Sales ops wants to pull contact lists into Excel for the quarterly campaign. The filters set in the app should apply."
            />
          </div>
          <button
            type="button"
            className="btn primary"
            disabled={!newTitle.trim() || busy === 'ticket'}
            onClick={() =>
              act('ticket', async () => {
                await post(`/projects/${slug}/board/tickets`, { title: newTitle, body: newBody });
                setNewTitle('');
                setNewBody('');
                setComposing(false);
              })
            }
          >
            Create ticket
          </button>
        </div>
      )}

      <div className={styles.board}>
        {columns.map((col) => {
          const colCards = cards.filter((c) => c.columnKey === col.key);
          return (
            <div key={col.key} className={styles.col}>
              <h5>
                {col.name} <span className={styles.count}>{colCards.length}</span>
              </h5>
              {colCards.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  className={styles.card}
                  onClick={() => openCard(card.id)}
                >
                  <div className={styles.cid}>{card.key}</div>
                  <div className={styles.ctitle}>{card.title}</div>
                  <div className={styles.cfoot}>
                    {card.spec ? (
                      <>
                        <span className={`pill ${card.spec.status === 'approved' ? 'on' : ''}`}>
                          spec v{card.spec.version}
                        </span>
                        {card.spec.unverifiedCount > 0 && (
                          <span className="pill warn">{card.spec.unverifiedCount} UNVERIFIED</span>
                        )}
                        {card.spec.approvedBy && (
                          <span className="pill on">✓ {card.spec.approvedBy}</span>
                        )}
                      </>
                    ) : (
                      <span className="pill">ticket</span>
                    )}
                  </div>
                </button>
              ))}
              {colCards.length === 0 && <div className={styles.colempty}>—</div>}
            </div>
          );
        })}
      </div>

      {/* ─── spec drawer ─────────────────────────────────────────────────── */}
      {open && (
        <>
          <button type="button" className={styles.scrim} onClick={() => setOpen(null)} aria-label="Close" />
          <aside className={styles.drawer}>
            {!detail && <div className="empty">Loading…</div>}

            {detail && (
              <>
                <div className={styles.dhead}>
                  <div className={styles.did}>
                    <span>{detail.ticket.key}</span>
                    <button type="button" className={styles.close} onClick={() => setOpen(null)}>
                      ✕
                    </button>
                  </div>
                  <div className={styles.dtitle}>{detail.ticket.title}</div>
                  <div className={styles.dmeta}>
                    {spec ? (
                      <>
                        <span className={`pill ${spec.status === 'approved' ? 'on' : ''}`}>
                          {spec.status.replace('_', ' ')} · v{spec.version}
                        </span>
                        <span className="pill">{spec.citationCount} citations</span>
                        {spec.unverifiedCount > 0 && (
                          <span className="pill warn">{spec.unverifiedCount} UNVERIFIED</span>
                        )}
                        {spec.approvedBy && (
                          <span className="pill on">
                            stamped by {spec.approvedBy}
                            {spec.approvedAt
                              ? ` · ${new Date(spec.approvedAt).toLocaleDateString()}`
                              : ''}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="pill">no spec yet</span>
                    )}
                  </div>
                </div>

                {!spec && (
                  <div className={styles.dbody}>
                    <h6>Business ask (verbatim)</h6>
                    <p className={styles.verbatim}>
                      {detail.ticket.body || <em>No description provided.</em>}
                    </p>
                    <p className={styles.nospec}>
                      No spec yet. Generating one runs SpecAgent against this project’s knowledge
                      base — it drafts EARS requirements, a cited design, and sized tasks.
                    </p>
                  </div>
                )}

                {spec && (
                  <>
                    <div className={styles.dtabs}>
                      {(
                        [
                          ['req', 'Requirements'],
                          ['des', 'Design'],
                          ['tas', 'Tasks'],
                        ] as const
                      ).map(([k, label]) => (
                        <button
                          key={k}
                          type="button"
                          className={tab === k ? styles.dton : styles.dtab}
                          onClick={() => setTab(k)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    <div className={styles.dbody}>
                      {tab === 'req' &&
                        spec.content.requirements.map((req, i) => (
                          <div key={i} className={styles.reqblock}>
                            <h6>Story</h6>
                            <p>{req.story}</p>
                            {req.criteria.map((c, j) => (
                              <div key={j} className={styles.ears}>
                                <b>{c.keyword}</b> {c.trigger} <b>THE SYSTEM SHALL</b> {c.response}
                              </div>
                            ))}
                          </div>
                        ))}

                      {tab === 'des' && (
                        <>
                          {spec.content.design.map((claim, i) => (
                            <p key={i} className={styles.claim}>
                              {claim.text}{' '}
                              {claim.citation && <span className={styles.cite}>{claim.citation} ✓</span>}
                              {claim.unverified && (
                                <span className={styles.unv}>⚠ UNVERIFIED — {claim.unverified}</span>
                              )}
                            </p>
                          ))}
                          {spec.content.outOfScope && spec.content.outOfScope.length > 0 && (
                            <>
                              <h6>Out of scope</h6>
                              <ul className={styles.list}>
                                {spec.content.outOfScope.map((o, i) => (
                                  <li key={i}>{o}</li>
                                ))}
                              </ul>
                            </>
                          )}
                          {spec.content.openQuestions && spec.content.openQuestions.length > 0 && (
                            <>
                              <h6>Open questions</h6>
                              <ul className={styles.list}>
                                {spec.content.openQuestions.map((q, i) => (
                                  <li key={i}>{q}</li>
                                ))}
                              </ul>
                            </>
                          )}
                        </>
                      )}

                      {tab === 'tas' &&
                        spec.content.tasks.map((task) => (
                          <div key={task.id} className={styles.task}>
                            <span className={styles.cb}>[ ]</span>
                            <span>
                              <b>{task.id}</b> {task.title}
                            </span>
                            <span className={styles.sz}>
                              {task.size}
                              {task.repo ? ` · ${task.repo}` : ''}
                              {task.asBuilt ? ' · always last' : ''}
                            </span>
                          </div>
                        ))}
                    </div>
                  </>
                )}

                <div className={styles.dfoot}>
                  {!spec && (
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy === 'gen'}
                      onClick={() =>
                        act('gen', () =>
                          post(
                            `/projects/${slug}/board/tickets/${detail.ticket.id}/generate-spec`,
                          ),
                        )
                      }
                    >
                      {busy === 'gen' ? (
                        <>
                          <span className="spinner" /> SpecAgent drafting…
                        </>
                      ) : (
                        '✨ Generate spec'
                      )}
                    </button>
                  )}

                  {spec?.status === 'draft' && (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy === 'review'}
                      onClick={() =>
                        act('review', () =>
                          post(`/projects/${slug}/board/specs/${spec.id}/transition`, {
                            to: 'in_review',
                          }),
                        )
                      }
                    >
                      Submit for review →
                    </button>
                  )}

                  {(spec?.status === 'in_review' || spec?.status === 'changes_requested') && (
                    <>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy === 'revise'}
                        onClick={() =>
                          act('revise', () => post(`/projects/${slug}/board/specs/${spec.id}/revise`))
                        }
                      >
                        Request agent revision
                      </button>
                      {spec.status === 'in_review' && (
                        /* The gate. This button is the only path to `approved`,
                           and the server records who pressed it. */
                        <button
                          type="button"
                          className="btn primary"
                          disabled={busy === 'approve'}
                          onClick={() =>
                            act('approve', () =>
                              post(`/projects/${slug}/board/specs/${spec.id}/transition`, {
                                to: 'approved',
                              }),
                            )
                          }
                        >
                          {busy === 'approve' ? <span className="spinner" /> : `✓ Approve spec v${spec.version}`}
                        </button>
                      )}
                    </>
                  )}

                  {spec?.status === 'approved' && (
                    <>
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          navigator.clipboard.writeText(`specd spec pull ${spec.ticketKey}`)
                        }
                      >
                        ⧉ specd spec pull {spec.ticketKey}
                      </button>
                      {/* Station 05, handoff mode (a): the hosted runner
                          implements the tasks and leaves a branch to review. */}
                      <button
                        type="button"
                        className="btn primary"
                        disabled={busy === 'build'}
                        onClick={() =>
                          act('build', () => post(`/projects/${slug}/board/specs/${spec.id}/build`))
                        }
                      >
                        {busy === 'build' ? (
                          <>
                            <span className="spinner" /> Building…
                          </>
                        ) : (
                          '▶ Build it'
                        )}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy === 'building'}
                        onClick={() =>
                          act('building', () =>
                            post(`/projects/${slug}/board/specs/${spec.id}/transition`, {
                              to: 'building',
                            }),
                          )
                        }
                      >
                        Mark as building
                      </button>
                    </>
                  )}

                  {spec?.status === 'building' && (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy === 'delivered'}
                      onClick={() =>
                        act('delivered', () =>
                          post(`/projects/${slug}/board/specs/${spec.id}/transition`, {
                            to: 'delivered',
                          }),
                        )
                      }
                    >
                      Mark delivered
                    </button>
                  )}
                </div>
              </>
            )}
          </aside>
        </>
      )}
    </div>
  );
}
