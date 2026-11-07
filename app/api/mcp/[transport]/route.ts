import { createMcpHandler } from "mcp-handler";
import { bearerMatches, runtimeDeps } from "../../../../lib/mcp/runtime";
import { buildTools } from "../../../../lib/mcp/tools";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

let handler: ((req: Request) => Promise<Response>) | undefined;

function mcp() {
  return (handler ??= createMcpHandler(
    (server) => {
      for (const tool of buildTools(runtimeDeps())) {
        server.registerTool(
          tool.name,
          { title: tool.annotations.title, description: tool.description, inputSchema: tool.schema, annotations: tool.annotations },
          async (args) => tool.run(args),
        );
      }
    },
    { serverInfo: { name: "porter-repo", version: "0.1.0" } },
    { basePath: "/api/mcp", maxDuration: 60 },
  ));
}

async function guarded(req: Request): Promise<Response> {
  if (!bearerMatches(req.headers.get("authorization"), process.env.MCP_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  return mcp()(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
