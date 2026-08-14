import { LandingNav } from '@/components/LandingNav';
import { DocsSidebar } from '@/components/DocsSidebar';
import styles from './docs.module.css';

/*
 * The docs shell: the marketing nav on top, a persistent left rail, and the
 * page in the middle. The rail lives in the layout rather than in each page so
 * a docs-to-docs navigation does not re-render (or re-scroll) it — which is
 * the whole reason a sidebar is worth having.
 */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className={styles.shell}>
      <LandingNav />
      <div className={styles.grid}>
        <DocsSidebar />
        {children}
      </div>
    </main>
  );
}
