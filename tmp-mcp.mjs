import { createServer } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod4";
createServer(async (req, res) => {
  const s = new McpServer({ name: "standalone", version: "1.0.0" });
  s.registerTool("echo", { description: "echo", inputSchema: z.object({ text: z.string() }), annotations: { readOnlyHint: true } }, async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }));
  const t = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await s.connect(t);
  await t.handleRequest(req, res);
}).listen(4555, "127.0.0.1", () => console.log("mcp up"));
