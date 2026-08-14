import Link from 'next/link';
import type { Metadata } from 'next';
import { LandingNav } from '@/components/LandingNav';
import styles from '../landing.module.css';

export const metadata: Metadata = { title: 'specd — apps' };

export default function Apps() {
  return (
    <main className={styles.page}>
      <LandingNav />
      <section className={styles.subhead}>
        <div className={styles.subin}>
          <Link href="/" className={styles.back}>
            ← BACK TO SITE
          </Link>
          <span className="tag">APPS</span>
          <h1 className={styles.subh1}>One pipeline, three surfaces</h1>
          <p className={styles.lede}>
            The web app is where the gate lives; the CLI feeds your agents. Mobile would put the
            stamp in your pocket — it is designed below, and not built.
          </p>

          <div className={styles.surfaces}>
            <div className={styles.surface} id="web">
              <h3>Web</h3>
              <p className={styles.lede} style={{ marginBottom: '.8rem' }}>
                The review surface. Everything gated happens here — by design (D13).
              </p>
              <ul className={styles.bullets} style={{ marginBottom: '1.2rem' }}>
                <li>spec review + recorded approvals</li>
                <li>board, knowledge health, delivery metrics</li>
                <li>the setup wizard</li>
              </ul>
              <Link href="/setup" className={styles.cta}>
                Start your setup
              </Link>
            </div>

            <div className={styles.surface} id="cli">
              <h3>CLI</h3>
              <p className={styles.lede} style={{ marginBottom: '.8rem' }}>
                Thin by design — fetches, registers, reports. Never authors or approves.
              </p>
              <div className={styles.term} style={{ marginBottom: '1.2rem' }}>
                <pre className={styles.termbody}>
                  <span className={styles.prompt}>$</span> brew install specd/tap/specd
                </pre>
              </div>
              <Link href="/docs" className={styles.ghost}>
                Read the docs
              </Link>
            </div>

            <div className={styles.surface} id="mobile">
              <h3>
                Mobile <span className={styles.preview}>NOT BUILT</span>
              </h3>
              <p className={styles.lede} style={{ marginBottom: '.8rem' }}>
                The gate in your pocket. Nothing here exists yet: it is out of scope for v0.1, and this sketch is here to measure whether anyone wants it.
              </p>
              <ul className={styles.bullets}>
                <li>push when a spec awaits your stamp</li>
                <li>mobile-legible spec &amp; diff cards</li>
                <li>approve with recorded identity</li>
                <li>build &amp; PR status, synced with web</li>
              </ul>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
