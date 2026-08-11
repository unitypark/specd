'use client';

import { forwardRef } from 'react';
import { age, initials, isFlagged, needsWork, subStatus, type BoardCard as Card } from '@/lib/board';
import styles from './board.module.css';

/**
 * One ticket on the board.
 *
 * Everything on it is something a person standing at a board asks out loud:
 * who has it, how long has it sat there, is it stuck, and does it carry a
 * claim nobody has checked. The old card showed a key, a title and a version —
 * true, and useless for the questions the board exists to answer.
 *
 * The card is an <article>, not a <button>: a Jira link has to live on it, and
 * interactive content inside a button is invalid and unreachable by keyboard.
 * The title is the control instead, stretched over the whole card by a CSS
 * pseudo-element, so clicking anywhere still opens the spec while the link
 * stays a real link above it.
 */

export interface BoardCardProps {
  card: Card;
  dragging: boolean;
  /** The server has not yet confirmed the move this card is showing. */
  moving: boolean;
  onOpen: () => void;
  onMoveLane: (direction: -1 | 1) => void;
  onMoveRank: (direction: -1 | 1) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

/** A deterministic tone per person, within a palette that has no hues to spend. */
function avatarTone(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 997;
  return styles[`t${hash % 4}`] ?? '';
}

export const BoardCardView = forwardRef<HTMLButtonElement, BoardCardProps>(function BoardCardView(
  { card, dragging, moving, onOpen, onMoveLane, onMoveRank, onDragStart, onDragEnd },
  ref,
) {
  const flagged = isFlagged(card);
  const stuck = needsWork(card);
  const sub = subStatus(card);
  const seniority = age(card);
  const draggable = Boolean(card.spec) || card.columnKey === 'backlog';

  return (
    <article
      className={[
        styles.card,
        dragging ? styles.dragging : '',
        moving ? styles.moving : '',
        flagged ? styles.railFlagged : '',
        stuck ? styles.railStuck : '',
      ]
        .filter(Boolean)
        .join(' ')}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      aria-busy={moving || undefined}
    >
      <div className={styles.chead}>
        <span className={styles.ckey}>{card.key}</span>
        {card.source === 'jira' &&
          (card.externalUrl ? (
            <a
              className={styles.csource}
              href={card.externalUrl}
              target="_blank"
              rel="noreferrer"
              title={`Open ${card.key} in Jira`}
            >
              jira ↗
            </a>
          ) : (
            <span className={styles.csource}>jira</span>
          ))}
        <span className={styles.cgrow} />
        {card.assignee ? (
          <span
            className={`${styles.avatar} ${avatarTone(card.assignee)}`}
            title={`Assigned to ${card.assignee}`}
          >
            <span aria-hidden>{initials(card.assignee)}</span>
            <span className={styles.sr}>Assigned to {card.assignee}</span>
          </span>
        ) : (
          <span className={`${styles.avatar} ${styles.unassigned}`} title="Unassigned">
            <span aria-hidden>·</span>
            <span className={styles.sr}>Unassigned</span>
          </span>
        )}
      </div>

      <h4 className={styles.ctitle}>
        <button
          ref={ref}
          type="button"
          className={styles.copen}
          aria-label={`${card.key} — ${card.title}`}
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
          onClick={onOpen}
          onKeyDown={(e) => {
            if (e.altKey || e.ctrlKey || e.metaKey) return;
            const moves = {
              ArrowLeft: () => onMoveLane(-1),
              ArrowRight: () => onMoveLane(1),
              ArrowUp: () => onMoveRank(-1),
              ArrowDown: () => onMoveRank(1),
            } as const;
            const move = moves[e.key as keyof typeof moves];
            if (!move) return;
            // Arrows would otherwise scroll the lane out from under the card
            // the user is trying to move.
            e.preventDefault();
            move();
          }}
        >
          {card.title}
        </button>
      </h4>

      <div className={styles.cfoot}>
        {card.spec ? (
          <>
            <span className={styles.cmeta}>v{card.spec.version}</span>
            {card.spec.citationCount > 0 && (
              <span className={styles.cmeta}>{card.spec.citationCount} cited</span>
            )}
            {flagged && <span className="pill unverified">{card.spec.unverifiedCount} UNVERIFIED</span>}
            {sub && <span className="pill warn">{sub}</span>}
            {card.spec.approvedBy && (
              <span className={styles.cmeta}>✓ {card.spec.approvedBy}</span>
            )}
          </>
        ) : (
          <span className={styles.cmeta}>no spec yet</span>
        )}

        <span className={styles.cgrow} />
        {seniority && (
          <span
            className={`${styles.cage} ${seniority.stale ? styles.stale : ''}`}
            title={`Last moved ${seniority.days === 0 ? 'today' : `${seniority.days} days ago`}`}
          >
            {seniority.label}
          </span>
        )}
      </div>
    </article>
  );
});
