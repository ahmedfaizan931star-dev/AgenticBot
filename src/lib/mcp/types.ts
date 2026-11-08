export type ToolSnapshot = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  destructive: boolean;
};

export type McpPolicy = "ask_all" | "ask_unless_readonly";
export type McpStatus = "active" | "needs_auth" | "needs_review" | "error";
export type McpAuthType = "none" | "bearer" | "oauth";

/** Server record without any secrets. */
export type McpServerInfo = {
  id: string;
  userId: string;
  name: string;
  slug: string;
  url: string;
  authType: McpAuthType;
  policy: McpPolicy;
  status: McpStatus;
  tools: ToolSnapshot[];
  enabledTools: string[];
  toolsHash: string | null;
  reviewedHash: string | null;
  lastError: string | null;
};
