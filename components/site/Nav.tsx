import Link from "next/link";
import { REPO_URL } from "./links";
import { NavLinks } from "./NavLinks";

export function Nav() {
  return (
    <header className="site-nav">
      <nav className="wrap nav enter" aria-label="Main">
        <Link className="mark" href="/">
          Porter
        </Link>
        <NavLinks />
        <a className="gh" href={REPO_URL}>
          GitHub
        </a>
      </nav>
    </header>
  );
}
