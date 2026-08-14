'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, post } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  NO_FILTERS,
  UNASSIGNED,
  assigneeOptions,
  filtersActive,
  insertionIndex,
  lane,
  matchesFilters,
  neighbourColumn,
  placeInColumn,
  planDrop,
  type BoardCard,
  type BoardFilters,
} from '@/lib/board';
import { BoardCardView } from './BoardCard';
import { SpecDrawer } from './SpecDrawer';
import styles from './board.module.css';

interface Column {
  key: string;
  name: string;
}

/**
 * How often an idle board re-reads itself. A board is a shared surface — the
 * runner finishes a build, a colleague approves a spec — and one that only
 * updates when *you* touch it is a screenshot. Suspended while anything is in
 * flight, so a refresh can never overwrite a drag or a half-typed ticket.
 */
const REFRESH_MS = 20_000;

const FILTER_LOCKED_REORDER =
  'Clear the filters to reorder — ranking a lane you can only partly see would move cards that are hidden.';

export function BoardView({ slug, onChange }: { slug: string; onChange: () => void }) {
  const [columns, setColumns] = useState<Column[]>([]);
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const [filters, setFilters] = useState<BoardFilters>(NO_FILTERS);
  const [collapsed, setCollapsed] = useState<string[]>([]);

  const [composing, setComposing] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const [creating, setCreating] = useState(false);

  const [dragging, setDragging] = useState<BoardCard | null>(null);
  const [dropAt, setDropAt] = useState<{ column: string; index: number } | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);

  const session = useSession();
  const searchBox = useRef<HTMLInputElement>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement | null>());
  /** Set before a keyboard move, so focus follows the card into its new lane. */
  const refocus = useRef<string | null>(null);

  const load = useCallback(async () => {
    const board = await get<{ columns: Column[]; cards: BoardCard[] }>(`/projects/${slug}/board`);
    setColumns(board.columns);
    setCards(board.cards);
  }, [slug]);

  useEffect(() => {
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed'));
  }, [load]);

  /**
   * Handed to the drawer, so it can tell the board something changed. Stable
   * on purpose: the drawer polls on an interval keyed to this callback, and a
   * fresh closure every render would reset that interval before it ever fired.
   */
  const reloadAll = useCallback(async () => {
    await load();
    onChange();
  }, [load, onChange]);

  // ─── background refresh ───────────────────────────────────────────────────
  const idle = useRef(true);
  useEffect(() => {
    idle.current = !dragging && !movingId && !open && !composing;
  }, [dragging, movingId, open, composing]);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden || !idle.current) return;
      // A failed background refresh leaves the board exactly as it was. The
      // error banner belongs to actions the user took, not to a poll they
      // never asked for.
      load().catch(() => undefined);
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    cardRefs.current.get(id)?.focus();
  }, [cards]);

  // ─── the board's one shortcut ─────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || open) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable]')) return;
      e.preventDefault();
      searchBox.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // ─── derived ──────────────────────────────────────────────────────────────
  const columnKeys = useMemo(() => columns.map((c) => c.key), [columns]);
  const columnName = useCallback(
    (key: string) => columns.find((c) => c.key === key)?.name ?? key,
    [columns],
  );
  const visible = useMemo(() => cards.filter((c) => matchesFilters(c, filters)), [cards, filters]);
  const people = useMemo(() => assigneeOptions(cards), [cards]);
  const assigneeNames = useMemo(
    () => people.filter((p) => p.value !== UNASSIGNED).map((p) => p.value),
    [people],
  );
  const filtered = filtersActive(filters);
  /**
   * Ranking is off while a filter hides cards. The lane the server is asked to
   * rank is the whole lane, so sending the handful you can currently see would
   * quietly sweep everything filtered out to the bottom — a board that
   * reorders work you cannot see is worse than one that will not reorder.
   */
  const rankable = !filtered;

  // ─── moving a card ────────────────────────────────────────────────────────
  const applyMove = useCallback(
    async (card: BoardCard, toColumn: string, index: number) => {
      const plan = planDrop(card, toColumn);
      if (plan.kind === 'refuse') {
        setError(plan.reason);
        return;
      }
      if (plan.kind === 'rank' && !rankable) {
        setError(FILTER_LOCKED_REORDER);
        return;
      }

      setError(null);
      // Optimistic: the card lands where it was dropped, and snaps back if the
      // server disagrees. A board that waits for a round-trip feels broken —
      // but the card dims until the server confirms, so a slow transition is
      // visibly still in flight rather than silently settled.
      const previous = cards;
      const next = placeInColumn(cards, card.id, toColumn, index);
      const order = lane(next, toColumn);
      setCards(next);
      setMovingId(card.id);

      try {
        if (plan.kind === 'move') {
          await post(`/projects/${slug}/board/specs/${plan.specId}/transition`, { to: plan.to });
        }
        if (rankable) {
          await post(`/projects/${slug}/board/reorder`, {
            columnKey: toColumn,
            ticketIds: order.map((c) => c.id),
          });
        }
        await load();
        if (plan.kind === 'move') onChange();

        const rank = order.findIndex((c) => c.id === card.id) + 1;
        setNotice(
          plan.kind === 'move'
            ? `${card.key} moved to ${columnName(toColumn)}${rankable ? `, position ${rank} of ${order.length}` : ''}.`
            : `${card.key} is now ${rank} of ${order.length} in ${columnName(toColumn)}.`,
        );
      } catch (err) {
        setCards(previous);
        setError(err instanceof Error ? err.message : 'Could not move that card.');
      } finally {
        setMovingId(null);
      }
    },
    [cards, columnName, load, onChange, rankable, slug],
  );

  const moveLane = useCallback(
    (card: BoardCard, direction: -1 | 1) => {
      const next = neighbourColumn(columnKeys, card, direction);
      if (!next) {
        setNotice(`${card.key} is already in the ${direction < 0 ? 'first' : 'last'} lane.`);
        return;
      }
      if (next.reason) {
        setError(next.reason);
        return;
      }
      refocus.current = card.id;
      void applyMove(card, next.key, lane(cards, next.key).length);
    },
    [applyMove, cards, columnKeys],
  );

  const moveRank = useCallback(
    (card: BoardCard, direction: -1 | 1) => {
      const ids = lane(cards, card.columnKey).map((c) => c.id);
      const to = ids.indexOf(card.id) + direction;
      if (to < 0 || to >= ids.length) {
        setNotice(
          `${card.key} is already ${direction < 0 ? 'first' : 'last'} in ${columnName(card.columnKey)}.`,
        );
        return;
      }
      refocus.current = card.id;
      void applyMove(card, card.columnKey, to);
    },
    [applyMove, cards, columnName],
  );

  // ─── drag ─────────────────────────────────────────────────────────────────
  function laneDropIndex(laneEl: HTMLElement, clientY: number, draggingId: string): number {
    const midpoints = [...laneEl.querySelectorAll<HTMLElement>('[data-card]')]
      .filter((el) => el.dataset.card !== draggingId)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });
    return insertionIndex(midpoints, clientY);
  }

  return (
    <div className={styles.wrap}>
      {error && (
        <div className="err" role="alert">
          {error}
          <button type="button" className={styles.dismiss} onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      <p aria-live="polite" className={styles.sr}>
        {notice}
      </p>

      {/* ─── toolbar ─────────────────────────────────────────────────────── */}
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <span aria-hidden>⌕</span>
          <input
            ref={searchBox}
            type="search"
            value={filters.query}
            placeholder="Search key, title or assignee"
            aria-label="Search the board"
            onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setFilters((f) => ({ ...f, query: '' }));
            }}
          />
          <kbd className={styles.kbdhint} aria-hidden>
            /
          </kbd>
        </div>

        <AssigneeFilter
          options={people}
          selected={filters.assignees}
          me={session.user?.name ?? null}
          onChange={(assignees) => setFilters((f) => ({ ...f, assignees }))}
        />

        <div className={styles.seg} role="group" aria-label="Filter by what needs attention">
          {(
            [
              ['any', 'All'],
              ['flagged', 'Flagged'],
              ['needs-work', 'Needs work'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={filters.attention === value ? styles.segon : styles.segoff}
              aria-pressed={filters.attention === value}
              title={
                value === 'flagged'
                  ? 'Specs carrying claims nobody has checked'
                  : value === 'needs-work'
                    ? 'Blocked, or a reviewer asked for changes'
                    : 'Everything on the board'
              }
              onClick={() => setFilters((f) => ({ ...f, attention: value }))}
            >
              {label}
            </button>
          ))}
        </div>

        <span className={styles.grow} />

        {filtered && (
          <span className={styles.showing}>
            {visible.length} of {cards.length}
            <button type="button" className={styles.clear} onClick={() => setFilters(NO_FILTERS)}>
              Clear
            </button>
          </span>
        )}

        <button
          type="button"
          className="btn primary sm"
          aria-expanded={composing}
          onClick={() => setComposing((c) => !c)}
        >
          + New ticket
        </button>
      </div>

      {composing && (
        <div className={`card ${styles.compose}`}>
          <div className={styles.composerow}>
            <div className="field" style={{ flex: 2, marginBottom: 0 }}>
              <label htmlFor="tt">Title</label>
              <input id="tt" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} autoFocus />
            </div>
            <div className="field" style={{ flex: 1, marginBottom: 0 }}>
              <label htmlFor="ta">Assignee</label>
              <input
                id="ta"
                list="specd-board-assignees"
                value={newAssignee}
                onChange={(e) => setNewAssignee(e.target.value)}
                placeholder="Nobody"
              />
              <datalist id="specd-board-assignees">
                {assigneeNames.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
          </div>
          <div className="field">
            <label htmlFor="tb">The business ask, in plain language</label>
            <textarea
              id="tb"
              rows={3}
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              placeholder="Sales ops wants to pull contact lists into Excel for the quarterly campaign. The filters set in the app should apply."
            />
          </div>
          <div className={styles.dactions}>
            <button
              type="button"
              className="btn primary"
              disabled={!newTitle.trim() || creating}
              onClick={async () => {
                setCreating(true);
                setError(null);
                try {
                  await post(`/projects/${slug}/board/tickets`, {
                    title: newTitle.trim(),
                    body: newBody,
                    assignee: newAssignee.trim(),
                  });
                  setNewTitle('');
                  setNewBody('');
                  setNewAssignee('');
                  setComposing(false);
                  await load();
                  onChange();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Could not create that ticket.');
                } finally {
                  setCreating(false);
                }
              }}
            >
              {creating && <span className="spinner" />} Create ticket
            </button>
            <button type="button" className="btn" onClick={() => setComposing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ─── the board ───────────────────────────────────────────────────── */}
      {/* `dragging` rides on the board rather than on each lane: every lane
          has to open a drop target while a card is in the air, including the
          ones the pointer has not visited yet. */}
      <div className={`${styles.board} ${dragging ? styles.dragging : ''}`}>
        {/* Placeholder lanes live in the same row as the real ones rather than
            in a board of their own — two `flex: 1` boards side by side would
            each take half the height, and the empty one would show as a gap
            under the skeleton. */}
        {columns.length === 0 &&
          Array.from({ length: 6 }, (_, i) => (
            <div key={i} className={styles.col} style={{ padding: '0.65rem 0.55rem' }} aria-hidden>
              <span className="skeleton" style={{ height: '0.9rem', width: '55%', marginBottom: '1.1rem' }} />
              <span className="skeleton" style={{ height: '5rem', marginBottom: '0.5rem' }} />
              {i < 3 && <span className="skeleton" style={{ height: '5rem' }} />}
            </div>
          ))}

        {columns.map((col, colIndex) => {
          const isCollapsed = collapsed.includes(col.key);
          const all = lane(cards, col.key);
          const shown = lane(visible, col.key);
          const isGate = col.key === 'approved';

          if (isCollapsed) {
            return (
              <section key={col.key} className={styles.collapsed}>
                <button
                  type="button"
                  className={styles.expand}
                  title={`Expand ${col.name}`}
                  onClick={() => setCollapsed((c) => c.filter((k) => k !== col.key))}
                >
                  <span className={styles.count}>{shown.length}</span>
                  <span className={styles.vertical}>{col.name}</span>
                </button>
              </section>
            );
          }

          const plan = dragging ? planDrop(dragging, col.key) : null;
          const welcome = plan ? plan.kind !== 'refuse' : false;
          // No placeholder while a filter is on: the drop will not rank
          // anything, so drawing a slot would promise a position the board is
          // about to ignore.
          const showPlaceholder = Boolean(
            dragging && dropAt?.column === col.key && welcome && rankable,
          );

          return (
            <section
              key={col.key}
              className={`${styles.col} ${isGate ? styles.gate : ''} ${
                dragging && dropAt?.column === col.key ? (welcome ? styles.dropOk : styles.dropNo) : ''
              }`}
              aria-label={`${col.name}, ${shown.length} card${shown.length === 1 ? '' : 's'}`}
            >
              <header className={styles.colhead}>
                <span className={styles.stn}>{String(colIndex + 1).padStart(2, '0')}</span>
                <h5>{col.name}</h5>
                {isGate && (
                  <span
                    className={styles.human}
                    title="Only a signed-in person can move a spec into this lane."
                  >
                    HUMAN
                  </span>
                )}
                <span className={styles.grow} />
                <span className={`${styles.count} ${shown.length === 0 ? styles.zero : ''}`}>
                  {filtered && shown.length !== all.length
                    ? `${shown.length}/${all.length}`
                    : shown.length}
                </span>
                {col.key === 'backlog' && (
                  <button
                    type="button"
                    className={styles.headbtn}
                    title="New ticket"
                    aria-label="New ticket"
                    onClick={() => setComposing(true)}
                  >
                    +
                  </button>
                )}
                <button
                  type="button"
                  className={styles.headbtn}
                  title={`Collapse ${col.name}`}
                  aria-label={`Collapse ${col.name}`}
                  onClick={() => setCollapsed((c) => [...c, col.key])}
                >
                  {/* Guillemet, not ⟨: the mathematical angle bracket has no
                      glyph in JetBrains Mono and fell back to something that
                      read as a stray opening parenthesis. */}
                  «
                </button>
              </header>

              <div
                className={styles.laneBody}
                onDragOver={(e) => {
                  if (!dragging || !welcome) return;
                  // preventDefault is what marks this a valid drop target;
                  // without it the browser refuses the drop and shows a "no
                  // entry" cursor.
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const index = rankable
                    ? laneDropIndex(e.currentTarget, e.clientY, dragging.id)
                    : shown.length;
                  setDropAt((at) =>
                    at?.column === col.key && at.index === index ? at : { column: col.key, index },
                  );
                }}
                onDragEnter={() => {
                  // A refused lane still has to say so, and dragover never
                  // fires on one because it never calls preventDefault.
                  if (!dragging || welcome) return;
                  setDropAt((at) => (at?.column === col.key ? at : { column: col.key, index: 0 }));
                }}
                onDragLeave={(e) => {
                  // Moving between two cards inside this lane fires dragleave
                  // on the lane; only a pointer that actually left it counts.
                  if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                  setDropAt((at) => (at?.column === col.key ? null : at));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const card = dragging;
                  const index = dropAt?.column === col.key ? dropAt.index : shown.length;
                  setDropAt(null);
                  setDragging(null);
                  if (card) void applyMove(card, col.key, index);
                }}
              >
                {(() => {
                  const nodes: React.ReactNode[] = [];
                  const gap = <div key="placeholder" className={styles.placeholder} aria-hidden />;
                  let seen = 0;

                  for (const c of shown) {
                    const isDragged = dragging?.id === c.id;
                    if (!isDragged) {
                      if (showPlaceholder && dropAt?.index === seen) nodes.push(gap);
                      seen += 1;
                    }
                    nodes.push(
                      <div key={c.id} data-card={c.id}>
                        <BoardCardView
                          ref={(el) => {
                            cardRefs.current.set(c.id, el);
                          }}
                          card={c}
                          dragging={isDragged}
                          moving={movingId === c.id}
                          onOpen={() => setOpen(c.id)}
                          onMoveLane={(d) => moveLane(c, d)}
                          onMoveRank={(d) => moveRank(c, d)}
                          onDragStart={(e) => {
                            setDragging(c);
                            e.dataTransfer.effectAllowed = 'move';
                            // Firefox will not begin a drag unless the event
                            // carries data.
                            e.dataTransfer.setData('text/plain', c.key);
                          }}
                          onDragEnd={() => {
                            setDragging(null);
                            setDropAt(null);
                          }}
                        />
                      </div>,
                    );
                  }
                  if (showPlaceholder && (dropAt?.index ?? 0) >= seen) nodes.push(gap);
                  return nodes;
                })()}

                {/* An empty lane is its header and nothing else. It used to
                    carry a line of copy explaining what belongs in it, which
                    is a sentence you read once and then look past on every
                    board you ever open — the lane's own name already says it.
                    A lane emptied by the *filter* still speaks up: that one is
                    not a description of the lane, it is the fact that there
                    are cards here you cannot currently see. */}
                {shown.length === 0 && !showPlaceholder && filtered && all.length > 0 && (
                  <p className={styles.colempty}>{all.length} hidden by the filter</p>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <p className={styles.legend}>
        Drag a card, or focus one: <kbd>←</kbd> <kbd>→</kbd> change lane, <kbd>↑</kbd> <kbd>↓</kbd>{' '}
        reorder, <kbd>/</kbd> searches.
        {!rankable && ' Reordering is off while a filter is on.'} Generating a spec is always a
        deliberate click — never automatic.
        {movingId && <span className={styles.saving}> · saving…</span>}
      </p>

      {open && (
        <SpecDrawer
          slug={slug}
          ticketId={open}
          assignees={assigneeNames}
          onClose={() => setOpen(null)}
          onChanged={reloadAll}
        />
      )}
    </div>
  );
}

/**
 * Who to show. A menu rather than a row of chips because a real board grows
 * more people than a toolbar has room for, and "me" is pinned to the top
 * because filtering to yourself is the single most common thing anyone does
 * to a board.
 */
function AssigneeFilter({
  options,
  selected,
  me,
  onChange,
}: {
  options: { value: string; label: string; count: number }[];
  selected: string[];
  me: string | null;
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const ordered = me
    ? [...options].sort((a, b) => Number(b.value === me) - Number(a.value === me))
    : options;

  const label =
    selected.length === 0
      ? 'Anyone'
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? '1 person')
        : `${selected.length} people`;

  return (
    <div className={styles.menu} ref={root}>
      <button
        type="button"
        className={selected.length > 0 ? styles.segon : styles.segoff}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
      >
        {label} ▾
      </button>
      {open && (
        <div className={styles.menupanel} role="group" aria-label="Filter by assignee">
          {ordered.length === 0 && <p className={styles.menuempty}>Nobody is assigned yet.</p>}
          {ordered.map((option) => (
            <label key={option.value} className={styles.menurow}>
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, option.value]
                      : selected.filter((v) => v !== option.value),
                  )
                }
              />
              <span>
                {option.label}
                {option.value === me && <span className={styles.you}> you</span>}
              </span>
              <span className={styles.menucount}>{option.count}</span>
            </label>
          ))}
          {selected.length > 0 && (
            <button type="button" className={styles.menuclear} onClick={() => onChange([])}>
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
