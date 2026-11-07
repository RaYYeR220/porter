import type { SnapshotIssue, SnapshotRelease } from "./ingest";

export const CLOSED_WINDOW_DAYS = 180;

export type GraphqlFn = (query: string, vars: Record<string, unknown>) => Promise<unknown>;

const QUERY = `query($owner:String!,$name:String!,$openAfter:String,$closedAfter:String,$wantOpen:Boolean!,$wantClosed:Boolean!,$wantReleases:Boolean!){
  repository(owner:$owner,name:$name){
    open: issues(first:100,states:OPEN,after:$openAfter,orderBy:{field:CREATED_AT,direction:DESC}) @include(if:$wantOpen){
      nodes{number title body state createdAt updatedAt closedAt author{login} labels(first:20){nodes{name}}}
      pageInfo{hasNextPage endCursor}
    }
    closed: issues(first:100,states:CLOSED,after:$closedAfter,orderBy:{field:UPDATED_AT,direction:DESC}) @include(if:$wantClosed){
      nodes{number title body state createdAt updatedAt closedAt author{login} labels(first:20){nodes{name}}}
      pageInfo{hasNextPage endCursor}
    }
    releases(first:30,orderBy:{field:CREATED_AT,direction:DESC}) @include(if:$wantReleases){
      nodes{tagName name description publishedAt}
    }
  }
}`;

type GqlIssue = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  createdAt: string | null;
  updatedAt: string;
  closedAt: string | null;
  author: { login: string } | null;
  labels: { nodes: Array<{ name: string }> };
};
type Page = { nodes: GqlIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
type Gql = {
  repository: {
    open?: Page;
    closed?: Page;
    releases?: { nodes: Array<{ tagName: string; name: string | null; description: string | null; publishedAt: string | null }> };
  };
};

const toIssue = (n: GqlIssue): SnapshotIssue => ({
  number: n.number,
  title: n.title,
  body: n.body,
  state: n.state.toLowerCase() === "open" ? "open" : "closed",
  author: n.author?.login ?? null,
  labels: n.labels.nodes.map((l) => l.name),
  createdAt: n.createdAt,
  closedAt: n.closedAt,
});

/**
 * Collects open issues, recently closed issues (last 180 days) and releases using as few GraphQL
 * calls as possible: the first call carries all three, later calls only the sections that still
 * have pages. `maxCalls` is a hard cap so the GitHub budget cannot be exceeded.
 */
export async function collectSnapshot(
  graphql: GraphqlFn,
  owner: string,
  name: string,
  opts: { maxCalls?: number; now?: number } = {},
): Promise<{ issues: SnapshotIssue[]; releases: SnapshotRelease[]; calls: number }> {
  const maxCalls = opts.maxCalls ?? 4;
  const cutoff = (opts.now ?? Date.now()) - CLOSED_WINDOW_DAYS * 864e5;
  const issues = new Map<number, SnapshotIssue>();
  let releases: SnapshotRelease[] = [];
  let openAfter: string | null = null;
  let closedAfter: string | null = null;
  let wantOpen = true;
  let wantClosed = true;
  let wantReleases = true;
  let calls = 0;

  while ((wantOpen || wantClosed) && calls < maxCalls) {
    const res = (await graphql(QUERY, { owner, name, openAfter, closedAfter, wantOpen, wantClosed, wantReleases })) as Gql;
    calls++;
    const repo = res.repository;
    if (wantReleases && repo.releases) {
      releases = repo.releases.nodes.map((r) => ({ tag: r.tagName, name: r.name, body: r.description, publishedAt: r.publishedAt }));
      wantReleases = false;
    }
    if (wantOpen && repo.open) {
      for (const n of repo.open.nodes) issues.set(n.number, toIssue(n));
      wantOpen = repo.open.pageInfo.hasNextPage;
      openAfter = repo.open.pageInfo.endCursor;
    }
    if (wantClosed && repo.closed) {
      let reachedOld = false;
      for (const n of repo.closed.nodes) {
        // closedAt <= updatedAt, so once updatedAt is past the window nothing later can qualify
        if (new Date(n.updatedAt).getTime() < cutoff) reachedOld = true;
        if (n.closedAt && new Date(n.closedAt).getTime() >= cutoff) issues.set(n.number, toIssue(n));
      }
      wantClosed = repo.closed.pageInfo.hasNextPage && !reachedOld;
      closedAfter = repo.closed.pageInfo.endCursor;
    }
  }
  return { issues: [...issues.values()], releases, calls };
}
