'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BUILDABLE_STATUSES, type SpecStatus } from '@specd/shared';
import { del, get, patch, post } from '@/lib/api';
import { ConfirmDialog } from './ConfirmDialog';
import styles from './board.module.css';

/**
 * The spec behind one card: requirements, the cited design, the tasks, and
 * every action the lifecycle allows from where it currently stands.
 *
 * It owns its own fetch. The board only tells it which ticket to show and asks
 * to be told when something changed — which is why opening a card no longer
 * needs the board to carry a second copy of the ticket's state.
 */

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
  ticket: {
    id: string;
    key: string;
    title: string;
    body: string;
    assignee: string | null;
    source: string;
    externalUrl: string | null;
  };
  spec: SpecView | null;
  versions: { id: string; version: number; status: string }[];
  comments: Comment[];
}

export function SpecDrawer({
  slug,
  ticketId,
  assignees,
  onClose,
  onChanged,
}: {
  slug: string;
  ticketId: string;
  assignees: string[];
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [tab, setTab] = useState<'req' | 'des' | 'tas'>('req');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waitingForRunner, setWaitingForRunner] = useState(false);
  const [commentOpen, setCommentOpen] = useState<number | null>(null);
  const [commentDrafts, setCommentDrafts] = useState<Record<number, string>>({});
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editAssignee, setEditAssignee] = useState('');
  const [confirmDeleteTicket, setConfirmDeleteTicket] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const panel = useRef<HTMLElement>(null);
  // Where focus was before the drawer took over, so closing puts it back on
  // the card the user opened rather than at the top of the document.
  const restoreFocus = useRef<Element | null>(null);

  const fetchDetail = useCallback(
    () => get<TicketDetail>(`/projects/${slug}/board/tickets/${ticketId}`),
    [slug, ticketId],
  );

  useEffect(() => {
    restoreFocus.current = document.activeElement;
    return () => {
      if (restoreFocus.current instanceof HTMLElement) restoreFocus.current.focus();
    };
  }, []);

  useEffect(() => {
    setDetail(null);
    setTab('req');
    setWaitingForRunner(false);
    setCommentOpen(null);
    setCommentDrafts({});
    setEditing(false);
    setConfirmDeleteTicket(false);
    fetchDetail()
      .then(setDetail)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, [fetchDetail]);

  useEffect(() => {
    if (detail) panel.current?.focus();
  }, [detail]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmDeleteTicket) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirmDeleteTicket]);

  // A spec dispatched to a paired runner (§9) has no synchronous result — the
  // runner polls, executes, and reports back on its own schedule. Poll the
  // ticket ourselves until its spec shows up, rather than leaving the drawer
  // stuck on the "Generate spec" button with no feedback (and no guard
  // against a confused second click queuing a duplicate job).
  useEffect(() => {
    if (!waitingForRunner) return;
    const id = setInterval(async () => {
      try {
        const d = await fetchDetail();
        setDetail(d);
        if (d.spec) {
          setWaitingForRunner(false);
          await onChanged();
        }
      } catch {
        // Transient — the next tick tries again.
      }
    }, 4000);
    return () => clearInterval(id);
  }, [waitingForRunner, fetchDetail, onChanged]);

  /**
   * Run an action, then refresh both the drawer and the board behind it.
   * Deliberately re-fetches without resetting the tab: commenting on a Design
   * item must not knock the drawer back to Requirements right after.
   */
  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      setDetail(await fetchDetail());
      await onChanged();
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
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await del(`/projects/${slug}/board/tickets/${ticketId}`);
      setConfirmDeleteTicket(false);
      onClose();
      await onChanged();
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
    <>
      <button type="button" className={styles.scrim} onClick={onClose} aria-label="Close" />
      <aside
        ref={panel}
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-label={detail ? `${detail.ticket.key} — ${detail.ticket.title}` : 'Loading ticket'}
        tabIndex={-1}
      >
        {!detail && (
          <div style={{ padding: '1rem' }} aria-hidden>
            <span className="skeleton" style={{ height: '0.8rem', width: '18%', display: 'block', marginBottom: '0.6rem' }} />
            <span className="skeleton" style={{ height: '1.2rem', width: '70%', display: 'block', marginBottom: '0.8rem' }} />
            <span className="skeleton" style={{ height: '0.85rem', width: '95%', display: 'block', marginBottom: '0.45rem' }} />
            <span className="skeleton" style={{ height: '0.85rem', width: '88%', display: 'block', marginBottom: '0.45rem' }} />
            <span className="skeleton" style={{ height: '0.85rem', width: '60%', display: 'block' }} />
          </div>
        )}

        {error && !detail && (
          <div className="err" style={{ margin: '1rem' }}>
            {error}
          </div>
        )}

        {detail && (
          <>
            <div className={styles.dhead}>
              <div className={styles.did}>
                <span>{detail.ticket.key}</span>
                {detail.ticket.source === 'jira' && detail.ticket.externalUrl && (
                  <a
                    className={styles.dsource}
                    href={detail.ticket.externalUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    open in Jira ↗
                  </a>
                )}
                <span className={styles.dgrow} />
                <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
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
                <span className="pill">
                  {detail.ticket.assignee ? `@ ${detail.ticket.assignee}` : 'unassigned'}
                </span>
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
                        setEditAssignee(detail.ticket.assignee ?? '');
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

            {error && (
              <div className="err" style={{ margin: '0.8rem 1.2rem' }}>
                {error}
              </div>
            )}

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
                  <label htmlFor="ea">Assignee</label>
                  <input
                    id="ea"
                    list="specd-drawer-assignees"
                    value={editAssignee}
                    onChange={(e) => setEditAssignee(e.target.value)}
                    placeholder="Nobody"
                  />
                  <datalist id="specd-drawer-assignees">
                    {assignees.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
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
                          assignee: editAssignee.trim(),
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
    </>
  );
}
