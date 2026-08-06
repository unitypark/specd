import Link from 'next/link';
import type { Metadata } from 'next';
import { LandingNav } from '@/components/LandingNav';
import styles from '../landing.module.css';

export const metadata: Metadata = { title: 'specd — pricing' };

/** Pricing lives on its own page rather than in the landing flow (rev 15). */
const TIERS = [
  {
    name: 'Free',
    amount: '€0',
    features: ['1 project · 2 repos', 'BYO API key or your runner', 'Built-in board', 'Community templates'],
    cta: { label: 'Start free', href: '/setup', primary: false },
  },
  {
    name: 'Team',
    amount: '€49',
    note: ' /project/mo + metered runs',
    hot: 'MOST TEAMS',
    features: ['Unlimited repos · free seats', 'Hosted agent runners', 'Jira two-way sync', 'Delivery & knowledge dashboards'],
    cta: { label: 'Start trial', href: '/setup', primary: true },
  },
  {
    name: 'Enterprise',
    amount: 'Custom',
    features: ['Self-host / private cloud', 'SSO · audit export', 'Bedrock & Azure adapters', 'Org template packs'],
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
                    <li key={f}>{f}</li>
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
