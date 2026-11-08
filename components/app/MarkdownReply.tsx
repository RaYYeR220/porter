import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const LINK_REL = "nofollow noopener noreferrer";

const plain = (children: unknown): string =>
  typeof children === "string" ? children : Array.isArray(children) ? children.map(plain).join("") : "";

/**
 * Model output is untrusted. Raw HTML is dropped, unsafe URL schemes are emptied by react-markdown's
 * default transform, images are never fetched (they become links), and every link shows where it goes.
 */
const components: Components = {
  a({ href, children }) {
    const url = href ?? "";
    const label = plain(children).trim();
    return (
      <>
        <a href={url || undefined} rel={LINK_REL} target="_blank">
          {children}
        </a>
        {url && label !== url && <span className="md-url"> ({url})</span>}
      </>
    );
  },
  img({ src, alt }) {
    const url = typeof src === "string" ? src : "";
    return url ? (
      <a href={url} rel={LINK_REL} target="_blank" className="md-img">
        image{alt ? `: ${alt}` : ""} ({url})
      </a>
    ) : null;
  },
  h1: ({ children }) => <h3 className="md-h">{children}</h3>,
  h2: ({ children }) => <h4 className="md-h">{children}</h4>,
  h3: ({ children }) => <h5 className="md-h">{children}</h5>,
  h4: ({ children }) => <h6 className="md-h">{children}</h6>,
  h5: ({ children }) => <h6 className="md-h">{children}</h6>,
  h6: ({ children }) => <h6 className="md-h">{children}</h6>,
};

export function MarkdownReply({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {text}
      </Markdown>
    </div>
  );
}
