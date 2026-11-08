"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_LINKS } from "./links";

export function NavLinks() {
  const path = usePathname();
  return (
    <ul className="nav-links">
      {NAV_LINKS.map(({ href, label }) => {
        const current = !href.includes("#") && (path === href || path.startsWith(`${href}/`));
        return (
          <li key={href}>
            <Link href={href} aria-current={current ? "page" : undefined}>
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
