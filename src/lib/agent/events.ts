/** Events streamed from /api/chat to the browser as newline-delimited JSON. */
export type BrowserCall = { id: string; name: string; args: Record<string, unknown> };

export type PlanStep = { text: string; status: "todo" | "doing" | "done" };
export type ActionCard = { id: string; tool: string; summary: string; preview: string | null };

export type StreamEvent =
  | { type: "chat"; chatId: string }
  | { type: "text"; delta: string }
  | { type: "tool_status"; id: string; name: string; state: "running" | "done" | "error"; summary?: string }
  | { type: "browser_tool_calls"; calls: BrowserCall[] }
  | { type: "credits"; balance: number }
  | { type: "research_progress"; jobId: string; phase: "plan" | "search" | "read" | "write" | "done" | "failed"; detail?: string }
  | { type: "error"; code: string; message: string }
  | { type: "awaiting_tools" }
  | { type: "approval_required"; action: ActionCard }
  | { type: "awaiting_approval" }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "suggestions"; id: string; html: string }
  | { type: "done" };
