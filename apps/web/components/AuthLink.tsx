'use client';

import Link from 'next/link';
import { useSession } from '@/lib/session';

/**
 * The one control on a public page that depends on who is looking: an offer to
 * sign in, or — for someone who already did — the way back into the app.
 *
 * While the session is still unknown the link is laid out but not shown. The
 * alternative is asking someone to sign in for a frame before discovering they
 * already are, which is the flicker version of the bug this replaces.
 */
export function AuthLink({
  className,
  signInLabel,
  dashboardLabel,
}: {
  className?: string;
  signInLabel: string;
  dashboardLabel: string;
}) {
  const { status } = useSession();

  if (status === 'authed') {
    return (
      <Link href="/projects" className={className}>
        {dashboardLabel}
      </Link>
    );
  }

  return (
    <Link
      href="/login"
      className={className}
      style={status === 'loading' ? { visibility: 'hidden' } : undefined}
      aria-hidden={status === 'loading'}
      tabIndex={status === 'loading' ? -1 : undefined}
    >
      {signInLabel}
    </Link>
  );
}
