import Link from "next/link";
import { NAV_LINKS, REPO_URL } from "./links";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap foot">
        <p>Porter · a front desk built on Otari</p>
        <nav aria-label="Footer">
          <ul>
            {NAV_LINKS.filter((l) => !l.href.includes("#")).map(({ href, label }) => (
              <li key={href}>
                <Link href={href}>{label}</Link>
              </li>
            ))}
            <li>
              <a href={REPO_URL}>GitHub</a>
            </li>
            <li>
              <a href={`${REPO_URL}/blob/HEAD/LICENSE`}>MIT licence</a>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
