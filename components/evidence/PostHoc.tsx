import { Fragment } from "react";
import { POST_HOC_NOTE, POST_HOC_TITLE, postHocTable, sentence } from "../../lib/site/post-hoc";
import type { PostHocData } from "../../lib/site/post-hoc";

/** Text with `code` spans, as the shared table cells write them. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}

/**
 * Runs made after the pre-registered eval, each changing one thing. Same tables as the README block,
 * built in lib/site/post-hoc.ts from the tagged results files.
 */
export function PostHocReport({ data }: { data: PostHocData[] }) {
  return (
    <section className="panel" aria-labelledby="ev-posthoc">
      <div className="panel-head">
        <h2 id="ev-posthoc" className="panel-title">
          {POST_HOC_TITLE}
        </h2>
      </div>
      <p className="panel-note">{POST_HOC_NOTE}</p>
      {data.map((d) => {
        const t = postHocTable(d);
        return (
          <div key={t.key} data-experiment={t.key}>
            <h3 className="ev-sub">{t.title}</h3>
            <table className="tbl">
              <thead>
                <tr>
                  {t.head.map((h) => (
                    <th key={h} scope="col">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {t.rows.map(([label, ...cells]) => (
                  <tr key={label}>
                    <th scope="row" data-label={t.head[0]}>
                      {label}
                    </th>
                    {cells.map((c, i) => (
                      <td key={t.head[i + 1]} data-label={t.head[i + 1]}>
                        <Inline text={c} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {t.notes.length > 0 && (
              <ul className="mt-list">
                {t.notes.map((n) => (
                  <li key={n}>
                    <Inline text={n} />
                  </li>
                ))}
              </ul>
            )}
            <p className="panel-note">
              What changed: <Inline text={sentence(t.changed)} /> (commit <code>{t.commit}</code>). Source:{" "}
              {t.sources.map((s, i) => (
                <Fragment key={s}>
                  {i > 0 && ", "}
                  <code>{s}</code>
                </Fragment>
              ))}
              .
            </p>
          </div>
        );
      })}
    </section>
  );
}
