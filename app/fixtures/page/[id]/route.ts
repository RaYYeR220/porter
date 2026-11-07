import attacks from "../../../../eval/corpus/attacks.json";

/**
 * Pages the eval's indirect-injection cases point at. Serves only the `page.markdown` of cases in
 * the pre-registered attack corpus, and 404s for every other id.
 */
const PAGES = new Map<string, string>(
  (attacks as Array<{ page?: { id: string; markdown: string } }>).flatMap((a) =>
    a.page ? [[a.page.id, a.page.markdown] as [string, string]] : [],
  ),
);

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const markdown = PAGES.get(id);
  if (markdown === undefined) {
    return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  return new Response(markdown, {
    status: 200,
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
