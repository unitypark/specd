'use client';

import { useCallback, useEffect, useState } from 'react';
import { BUILDABLE_STATUSES, type SpecStatus } from '@specd/shared';
import { del, get, patch, post } from '@/lib/api';
import { COLUMN_STATUS, dropCheck } from '@/lib/board';
import { ConfirmDialog } from './ConfirmDialog';
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
  design: { text: string; citation?: string; unverified?: string; verdict?: string }[];
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

interface Comment {
  id: string;
  section: string;
  itemIndex: number | null;
  authorName: string;
  body: string;
  createdAt: string;
}

interface TicketDetail {
  ticket: { id: string; key: string; title: string; body: string };
  spec: SpecView | null;
  versions: { id: string; version: number; status: string }[];
  comments: Comment[];
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
  const [waitingForRunner, setWaitingForRunner] = useState(false);
  const [commentOpen, setCommentOpen] = useState<number | null>(null);
  const [commentDrafts, setCommentDrafts] = useState<Record<number, string>>({});
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [confirmDeleteTicket, setConfirmDeleteTicket] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const board = await get<{ columns: Column[]; cards: Card[] }>(`/projects/${slug}/board`);
    setColumns(board.columns);
    setCards(board.cards);
  }, [slug]);

  useEffect(() => {
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed'));
  }, [load]);

  // ─── drag between states ──────────────────────────────────────────────────
  const [dragging, setDragging] = useState<Card | null>(null);
  const [hoverCol, setHoverCol] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);

  async function moveCard(card: Card, toColumn: string) {
    const check = dropCheck(card, toColumn);
    if (!check.ok) {
      setError(check.reason ?? 'That move is not allowed.');
      return;
    }
    const to = COLUMN_STATUS[toColumn];
    if (!to || !card.spec || card.spec.status === to) return;

    setError(null);
    // Optimistic: the card lands where it was dropped, and snaps back if the
    // server disagrees. A board that waits for a round-trip feels broken —
    // but the card dims until the server confirms, so a slow transition is
    // visibly still in flight rather than silently settled.
    const previous = cards;
    setCards((cs) => cs.map((c) => (c.id === card.id ? { ...c, columnKey: toColumn } : c)));
    setMovingId(card.id);
    try {
      await post(`/projects/${slug}/board/specs/${card.spec.id}/transition`, { to });
      await load();
    } catch (err) {
      setCards(previous);
      setError(err instanceof Error ? err.message : 'Could not move that card.');
    } finally {
      setMovingId(null);
    }
  }

  const openCard = useCallback(
    async (ticketId: string) => {
      setOpen(ticketId);
      setTab('req');
      setDetail(null);
      setWaitingForRunner(false);
      setCommentOpen(null);
      setCommentDrafts({});
      setEditing(false);
      setConfirmDeleteTicket(false);
      const d = await get<TicketDetail>(`/projects/${slug}/board/tickets/${ticketId}`);
      setDetail(d);
    },
    [slug],
  );

  // Re-fetches the open ticket's detail without touching which tab is
  // showing — unlike openCard, which is for landing on a *different* ticket
  // and rightly resets to Requirements. act() uses this so that, say,
  // commenting on a Design item does not knock the drawer back to the
  // Requirements tab right after.
  const refreshOpenCard = useCallback(async () => {
    if (!open) return;
    const d = await get<TicketDetail>(`/projects/${slug}/board/tickets/${open}`);
    setDetail(d);
  }, [open, slug]);

  // A spec dispatched to a paired runner (§9) has no synchronous result — the
  // runner polls, executes, and reports back on its own schedule. Poll the
  // ticket ourselves until its spec shows up, rather than leaving the drawer
  // stuck on the "Generate spec" button with no feedback (and no guard
  // against a confused second click queuing a duplicate job).
  useEffect(() => {
    if (!waitingForRunner || !open) return;
    const id = setInterval(async () => {
      try {
        const d = await get<TicketDetail>(`/projects/${slug}/board/tickets/${open}`);
        setDetail(d);
        if (d.spec) {
          setWaitingForRunner(false);
          await load();
          onChange();
        }
      } catch {
        // Transient — the next tick tries again.
      }
    }, 4000);
    return () => clearInterval(id);
  }, [waitingForRunner, open, slug, load, onChange]);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await load();
      await refreshOpenCard();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  }

  const spec = detail?.spec ?? null;
  const commentable = Boolean(spec && !BUILDABLE_STATUSES.includes(spec.status as SpecStatus));
  // Mirrors the server's refusal (`ticket_has_delivered_work`): a ticket
  // whose spec reached the gate is audit trail, not clutter.
  const ticketGated = Boolean(spec && BUILDABLE_STATUSES.includes(spec.status as SpecStatus));

  async function deleteTicket() {
    if (!open) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await del(`/projects/${slug}/board/tickets/${open}`);
      setConfirmDeleteTicket(false);
      setOpen(null);
      await load();
      onChange();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete the ticket');
    } finally {
      setDeleteBusy(false);
    }
  }

  async function submitComment(itemIndex: number) {
    const body = (commentDrafts[itemIndex] ?? '').trim();
    if (!body || !spec) return;
    await act('comment', async () => {
      await post(`/projects/${slug}/board/specs/${spec.id}/comments`, {
        section: 'design',
        itemIndex,
        body,
      });
      setCommentDrafts((d) => ({ ...d, [itemIndex]: '' }));
      setCommentOpen(null);
    });
  }

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
            {busy === 'ticket' && <span className="spinner" />} Create ticket
          </button>
        </div>
      )}

      {columns.length === 0 && !error && (
        <div className={styles.board} aria-hidden>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i}>
              <span className="skeleton" style={{ height: '0.9rem', width: '55%', marginBottom: '0.7rem' }} />
              <span className="skeleton" style={{ height: '3.4rem', marginBottom: '0.5rem' }} />
              {i < 2 && <span className="skeleton" style={{ height: '3.4rem' }} />}
            </div>
          ))}
        </div>
      )}

      <div className={styles.board}>
        {columns.map((col) => {
          const colCards = cards.filter((c) => c.columnKey === col.key);
          return (
            <div
              key={col.key}
              className={`${styles.col} ${
                hoverCol === col.key
                  ? dragging && dropCheck(dragging, col.key).ok
                    ? styles.dropOk
                    : styles.dropNo
                  : ''
              }`}
              onDragOver={(e) => {
                if (!dragging) return;
                // preventDefault is what marks this a valid drop target; without
                // it the browser refuses the drop and shows a "no entry" cursor.
                e.preventDefault();
                e.dataTransfer.dropEffect = dropCheck(dragging, col.key).ok ? 'move' : 'none';
                setHoverCol(col.key);
              }}
              onDragLeave={() => setHoverCol((h) => (h === col.key ? null : h))}
              onDrop={(e) => {
                e.preventDefault();
                setHoverCol(null);
                if (dragging) void moveCard(dragging, col.key);
                setDragging(null);
              }}
            >
              <h5>
                {col.name}
                <span className={`${styles.count} ${colCards.length === 0 ? styles.zero : ''}`}>
                  {colCards.length}
                </span>
              </h5>
              {colCards.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  className={`${styles.card} ${dragging?.id === card.id ? styles.dragging : ''}`}
                  style={movingId === card.id ? { opacity: 0.55, cursor: 'progress' } : undefined}
                  draggable={Boolean(card.spec)}
                  onDragStart={(e) => {
                    setDragging(card);
                    e.dataTransfer.effectAllowed = 'move';
                    // Firefox will not begin a drag unless the event carries data.
                    e.dataTransfer.setData('text/plain', card.id);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setHoverCol(null);
                  }}
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
                          <span className="pill unverified">{card.spec.unverifiedCount} UNVERIFIED</span>
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
            {!detail && (
              <div style={{ padding: '1rem' }} aria-hidden>
                <span className="skeleton" style={{ height: '0.8rem', width: '18%', display: 'block', marginBottom: '0.6rem' }} />
                <span className="skeleton" style={{ height: '1.2rem', width: '70%', display: 'block', marginBottom: '0.8rem' }} />
                <span className="skeleton" style={{ height: '0.85rem', width: '95%', display: 'block', marginBottom: '0.45rem' }} />
                <span className="skeleton" style={{ height: '0.85rem', width: '88%', display: 'block', marginBottom: '0.45rem' }} />
                <span className="skeleton" style={{ height: '0.85rem', width: '60%', display: 'block' }} />
              </div>
            )}

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
                          <span className="pill unverified">{spec.unverifiedCount} UNVERIFIED</span>
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
                    <span className={styles.dgrow} />
                    {!editing && (
                      <>
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => {
                            setEditing(true);
                            setEditTitle(detail.ticket.title);
                            setEditBody(detail.ticket.body);
                          }}
                        >
                          ✎ Edit
                        </button>
                        <button
                          type="button"
                          className="btn sm danger"
                          disabled={ticketGated}
                          title={
                            ticketGated
                              ? 'This ticket has an approved or built spec — it is part of the audit trail and cannot be deleted.'
                              : undefined
                          }
                          onClick={() => {
                            setDeleteError(null);
                            setConfirmDeleteTicket(true);
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {editing && (
                  <div className={styles.dbody}>
                    <div className="field">
                      <label htmlFor="et">Title</label>
                      <input
                        id="et"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        maxLength={200}
                        autoFocus
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="eb">The business ask, in plain language</label>
                      <textarea
                        id="eb"
                        rows={7}
                        value={editBody}
                        onChange={(e) => setEditBody(e.target.value)}
                      />
                      {spec && (
                        <p className="hint">
                          The next spec draft reads this wording — v{spec.version} was drafted from
                          the previous one.
                        </p>
                      )}
                    </div>
                    <div className={styles.dactions}>
                      <button
                        type="button"
                        className="btn primary"
                        disabled={!editTitle.trim() || busy === 'edit-ticket'}
                        onClick={() =>
                          act('edit-ticket', async () => {
                            await patch(`/projects/${slug}/board/tickets/${detail.ticket.id}`, {
                              title: editTitle.trim(),
                              body: editBody,
                            });
                            setEditing(false);
                          })
                        }
                      >
                        {busy === 'edit-ticket' && <span className="spinner" />} Save
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy === 'edit-ticket'}
                        onClick={() => setEditing(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {!editing && !spec && (
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

                {!editing && spec && (
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
                          {spec.content.design.map((claim, i) => {
                            const itemComments = detail.comments.filter(
                              (c) => c.section === 'design' && c.itemIndex === i,
                            );
                            return (
                              <div key={i} className={styles.claimblock}>
                                <p className={styles.claim}>
                                  {claim.text}{' '}
                                  {/* A claim carrying both is an `unknown`: the
                                      citation is real but was not confirmed
                                      against what was retrieved, so a tick
                                      beside it would be the exact lie the
                                      verdict exists to prevent. */}
                                  {claim.citation && (
                                    <span className={styles.cite}>
                                      {claim.citation}{' '}
                                      {claim.verdict === 'stale' ? '⧗' : claim.unverified ? '?' : '✓'}
                                    </span>
                                  )}
                                  {claim.unverified && (
                                    <span className={styles.unv}>
                                      ⚠{' '}
                                      {claim.verdict === 'stale'
                                        ? 'OUT OF DATE'
                                        : claim.citation
                                          ? 'UNCONFIRMED'
                                          : 'UNVERIFIED'}{' '}
                                      — {claim.unverified}
                                    </span>
                                  )}
                                </p>

                                {claim.unverified && (
                                  <div className={styles.commentThread}>
                                    {itemComments.map((c) => (
                                      <div key={c.id} className={styles.commentRow}>
                                        <div className={styles.commentMeta}>
                                          <b>{c.authorName}</b>
                                          <span>{new Date(c.createdAt).toLocaleDateString()}</span>
                                        </div>
                                        <p>{c.body}</p>
                                      </div>
                                    ))}

                                    {commentable &&
                                      (commentOpen === i ? (
                                        <div className={styles.commentForm}>
                                          <textarea
                                            rows={2}
                                            value={commentDrafts[i] ?? ''}
                                            onChange={(e) =>
                                              setCommentDrafts((d) => ({ ...d, [i]: e.target.value }))
                                            }
                                            placeholder="Ask a clarifying question…"
                                            autoFocus
                                          />
                                          <div className={styles.commentFormActions}>
                                            <button
                                              type="button"
                                              className="btn sm"
                                              onClick={() => setCommentOpen(null)}
                                            >
                                              Cancel
                                            </button>
                                            <button
                                              type="button"
                                              className="btn sm primary"
                                              disabled={
                                                !(commentDrafts[i] ?? '').trim() || busy === 'comment'
                                              }
                                              onClick={() => submitComment(i)}
                                            >
                                              Comment
                                            </button>
                                          </div>
                                        </div>
                                      ) : (
                                        <button
                                          type="button"
                                          className={styles.commentAffordance}
                                          onClick={() => setCommentOpen(i)}
                                        >
                                          {itemComments.length > 0
                                            ? `${itemComments.length} comment${itemComments.length === 1 ? '' : 's'}`
                                            : 'Add comment'}
                                        </button>
                                      ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
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
                  {!spec && waitingForRunner && (
                    <button type="button" className="btn primary" disabled>
                      <span className="spinner" /> Queued for your runner — waiting for it to pick this up…
                    </button>
                  )}

                  {!spec && !waitingForRunner && (
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy === 'gen'}
                      onClick={() =>
                        act('gen', async () => {
                          const res = await post<{ spec: SpecView | null; queued?: boolean }>(
                            `/projects/${slug}/board/tickets/${detail.ticket.id}/generate-spec`,
                          );
                          if (res.queued) setWaitingForRunner(true);
                        })
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
                      {busy === 'review' && <span className="spinner" />} Submit for review →
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
                        {busy === 'revise' && <span className="spinner" />} Request agent revision
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
                        {busy === 'building' && <span className="spinner" />} Mark as building
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
                      {busy === 'delivered' && <span className="spinner" />} Mark delivered
                    </button>
                  )}
                </div>
              </>
            )}
          </aside>
        </>
      )}

      {confirmDeleteTicket && detail && (
        <ConfirmDialog
          title={`Delete ${detail.ticket.key}?`}
          body={
            <>
              Deletes <b>{detail.ticket.title}</b> and any draft specs under it. Run history
              survives with the ticket reference cleared.
            </>
          }
          confirmLabel="Delete ticket"
          busy={deleteBusy}
          error={deleteError}
          onConfirm={deleteTicket}
          onCancel={() => setConfirmDeleteTicket(false)}
        />
      )}
    </div>
  );
}
