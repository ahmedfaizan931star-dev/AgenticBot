import { callTool, connectMcp, listToolSnapshots } from "@/lib/mcp/client";
export const runtime = "nodejs";
export async function POST(req: Request) {
  const { url } = (await req.json()) as { url: string };
  try {
    const c = await connectMcp(url, { kind: "none" });
    const tools = await listToolSnapshots(c.client);
    const echo = await callTool(c, "echo", { text: "from built server" });
    await c.close();
    return Response.json({ ok: true, tools: tools.map((t) => t.name), echo });
  } catch (e) {
    return Response.json({ ok: false, error: String((e as Error).message) });
  }
}
