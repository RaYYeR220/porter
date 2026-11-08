"use client";

import { useEffect, useState } from "react";
import { fetchAuthors } from "./api";
import { BudgetMeter } from "./BudgetMeter";
import { authorName } from "./format";
import type { Author } from "./types";

/** How often the page re-reads /api/authors while a run is live. The server pulls from Otari at most every 30 s. */
export const AUTHOR_POLL_MS = 8000;

/**
 * Reads the author's live meter from /api/authors while `active`, then once more when it settles.
 * Undefined while loading, null when the gateway has not reported this author yet.
 */
export function useAuthor(id: string | null, active: boolean): Author | null | undefined {
  const [found, setFound] = useState<{ id: string; author: Author | null } | null>(null);
  useEffect(() => {
    if (!id) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      const r = await fetchAuthors();
      if (stop) return;
      if (r.ok) setFound({ id, author: r.data.authors.find((a) => a.id === id) ?? null });
      if (active && !stop) timer = setTimeout(load, AUTHOR_POLL_MS);
    };
    void load();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, active]);
  if (!id || !found || found.id !== id) return undefined;
  return found.author;
}

export function AuthorBudget({ author, id }: { author: Author | null | undefined; id: string | null }) {
  return (
    <section className="ab" aria-label="Author budget">
      <div className="ab-head">
        <p className="ab-title">
          {id ? authorName(id) : "This visitor"}
          {author && <span className={`tier tier-${author.tier}`}>{author.tier}</span>}
          {author?.blocked && <span className="tag tag-hold">blocked</span>}
        </p>
        <p className="ab-note">Daily budget at the gateway, as Otari reports it</p>
      </div>
      {author === undefined ? (
        <div className="sk sk-meter" aria-busy="true" />
      ) : author === null ? (
        <p className="ab-wait">Otari has not reported spend for this author yet. It refreshes about every 30 seconds.</p>
      ) : (
        <BudgetMeter spendUsd={author.spendUsd} limitUsd={author.budgetLimitUsd} nextResetAt={author.nextResetAt} label={`Budget used by ${author.display}`} />
      )}
    </section>
  );
}
