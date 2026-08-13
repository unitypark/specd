import Link from 'next/link';
import type { Metadata } from 'next';
import { LandingNav } from '@/components/LandingNav';
import styles from '../landing.module.css';

export const metadata: Metadata = { title: 'specd — pricing' };

/**
 * Pricing lives on its own page rather than in the landing flow (rev 15).
 *
 * Anything not built yet says so. The README is careful about this — pre-1.0,
 * nothing deploys as a service, `deploy.md` reports no host — and a pricing
 * page that quietly sells the same product as finished undoes that, because
 * this is the page a stranger reads first. `planned` is the same discipline
 * the product applies to its own signals: unmeasured is not fresh, and
 * not-built is not shipped.
 */
type Feature = { label: string; planned?: true };

const TIERS: {
  name: string;
  amount: string;
  note?: string;
  hot?: string;
  features: Feature[];
  cta: { label: string; href: string; primary: boolean };
}[] = [
  {
    name: 'Free',
    amount: '€0',
    features: [
      { label: '1 project · 2 repos' },
      { label: 'BYO API key or your runner' },
      { label: 'Built-in board' },
      { label: 'Community templates' },
    ],
    cta: { label: 'Start free', href: '/setup', primary: false },
  },
  {
    name: 'Team',
    amount: '€49',
    note: ' /project/mo + metered runs',
    hot: 'MOST TEAMS',
    features: [
      { label: 'Unlimited repos · free seats' },
      // No cloud exists yet: runners are self-hosted and paired per machine.
      { label: 'Hosted agent runners', planned: true },
      // Outbound mirroring works; moving an issue in Jira does not move the
      // spec, and the adapter has never met a live Atlassian site (docs/jira.md).
      { label: 'Jira two-way sync', planned: true },
      { label: 'Delivery & knowledge dashboards' },
    ],
    cta: { label: 'Start trial', href: '/setup', primary: true },
  },
  {
    name: 'Enterprise',
    amount: 'Custom',
    features: [
      // Self-hosting is what specd already is — local-first, your Postgres.
      { label: 'Self-host / private cloud' },
      { label: 'SSO · audit export', planned: true },
      // The model allowlist is Anthropic-only (packages/shared/src/models.ts).
      { label: 'Bedrock & Azure adapters', planned: true },
      { label: 'Org template packs', planned: true },
    ],
    cta: { label: 'Talk to us', href: 'mailto:hello@specd.dev', primary: false },
  },
];

export default function Pricing() {
  return (
    <main className={styles.page}>
      <LandingNav />
      <section className={styles.subhead}>
        <div className={styles.subin}>
          <Link href="/" className={styles.back}>
            ← BACK TO SITE
          </Link>
          <span className="tag">PRICING</span>
          <h1 className={styles.subh1}>
            Metered on agent runs — <em>seats are free</em>
          </h1>
          <p className={styles.lede}>
            Reviewers are how the human gate stays real, so reading and approving never costs a
            seat.
          </p>

          <div className={styles.prices}>
            {TIERS.map((t) => (
              <div key={t.name} className={`${styles.price} ${t.hot ? styles.hot : ''}`}>
                {t.hot && <span className={styles.htag}>{t.hot}</span>}
                <h4>{t.name}</h4>
                <div className={styles.amt}>
                  {t.amount}
                  {t.note && <small>{t.note}</small>}
                </div>
                <ul>
                  {t.features.map((f) => (
                    <li key={f.label} className={f.planned ? styles.planned : undefined}>
                      {f.label}
                      {f.planned && <span className={styles.soon}>planned</span>}
                    </li>
                  ))}
                </ul>
                <Link
                  href={t.cta.href}
                  className={t.cta.primary ? styles.cta : styles.ghost}
                  style={{ textAlign: 'center' }}
                >
                  {t.cta.label}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
