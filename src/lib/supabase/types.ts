import type { ToolCall } from "@/lib/llm/types";

type Table<Row, Insert, Update = Partial<Insert>> = { Row: Row; Insert: Insert; Update: Update; Relationships: [] };

export type Database = {
  public: {
    Tables: {
      profiles: Table<{ id: string; email: string | null; created_at: string }, { id: string; email?: string | null }>;
      credits_balance: Table<{ user_id: string; balance: number; updated_at: string }, { user_id: string; balance?: number }>;
      credits_ledger: Table<
        { id: number; user_id: string; delta: number; reason: string; ref: string; created_at: string },
        { user_id: string; delta: number; reason: string; ref: string }
      >;
      chats: Table<
        { id: string; user_id: string; title: string; created_at: string; updated_at: string },
        { user_id: string; title?: string },
        { title?: string; updated_at?: string }
      >;
      messages: Table<
        {
          seq: number;
          id: string;
          chat_id: string;
          user_id: string;
          role: "user" | "assistant" | "tool";
          content: string | null;
          tool_calls: ToolCall[] | null;
          tool_call_id: string | null;
          tool_name: string | null;
          is_error: boolean;
          meta: Record<string, unknown> | null;
          created_at: string;
        },
        {
          chat_id: string;
          user_id: string;
          role: "user" | "assistant" | "tool";
          content?: string | null;
          tool_calls?: ToolCall[] | null;
          tool_call_id?: string | null;
          tool_name?: string | null;
          is_error?: boolean;
          meta?: Record<string, unknown> | null;
        },
        { content?: string | null; is_error?: boolean; meta?: Record<string, unknown> | null }
      >;
      connections: Table<
        {
          user_id: string;
          provider: "google" | "github";
          token_enc: string;
          refresh_enc: string | null;
          expires_at: string | null;
          label: string | null;
          scopes: string | null;
          mode: "read" | "write";
          created_at: string;
          updated_at: string;
        },
        {
          user_id: string;
          provider: "google" | "github";
          mode?: "read" | "write";
          token_enc: string;
          refresh_enc?: string | null;
          expires_at?: string | null;
          label?: string | null;
          scopes?: string | null;
          updated_at?: string;
        }
      >;
      files: Table<
        { id: string; user_id: string; name: string; mime: string; bytes: number; text_content: string; chars: number; created_at: string },
        { user_id: string; name: string; mime: string; bytes: number; text_content: string; chars: number }
      >;
      research_jobs: Table<
        {
          id: string;
          user_id: string;
          chat_id: string;
          question: string;
          phase: "plan" | "search" | "read" | "write" | "done" | "failed";
          queries: string[];
          sources: unknown;
          error: string | null;
          locked_until: string | null;
          created_at: string;
          updated_at: string;
        },
        { user_id: string; chat_id: string; question: string },
        {
          phase?: "plan" | "search" | "read" | "write" | "done" | "failed";
          queries?: string[];
          sources?: unknown;
          error?: string | null;
          locked_until?: string | null;
          updated_at?: string;
        }
      >;
      pending_actions: Table<
        {
          id: string;
          user_id: string;
          chat_id: string;
          tool_call_id: string;
          tool: string;
          args: Record<string, unknown>;
          summary: string;
          preview: string | null;
          status: "pending" | "executing" | "done" | "denied" | "expired" | "failed";
          result: string | null;
          created_at: string;
          expires_at: string;
          decided_at: string | null;
        },
        { user_id: string; chat_id: string; tool_call_id: string; tool: string; args: Record<string, unknown>; summary: string; preview?: string | null },
        { status?: "pending" | "executing" | "done" | "denied" | "expired" | "failed"; result?: string | null; decided_at?: string | null }
      >;
      audit_log: Table<
        { id: number; user_id: string; event: string; detail: Record<string, unknown>; created_at: string },
        { user_id: string; event: string; detail?: Record<string, unknown> }
      >;
      mcp_servers: Table<
        {
          id: string;
          user_id: string;
          name: string;
          slug: string;
          url: string;
          auth_type: "none" | "bearer" | "oauth";
          secret_enc: string | null;
          oauth_enc: string | null;
          policy: "ask_all" | "ask_unless_readonly";
          status: "active" | "needs_auth" | "needs_review" | "error";
          tools: unknown;
          enabled_tools: unknown;
          tools_hash: string | null;
          reviewed_hash: string | null;
          last_error: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          user_id: string;
          name: string;
          slug: string;
          url: string;
          auth_type: "none" | "bearer" | "oauth";
          secret_enc?: string | null;
          policy?: "ask_all" | "ask_unless_readonly";
          status?: "active" | "needs_auth" | "needs_review" | "error";
        },
        {
          name?: string;
          secret_enc?: string | null;
          oauth_enc?: string | null;
          policy?: "ask_all" | "ask_unless_readonly";
          status?: "active" | "needs_auth" | "needs_review" | "error";
          tools?: unknown;
          enabled_tools?: unknown;
          tools_hash?: string | null;
          reviewed_hash?: string | null;
          last_error?: string | null;
          updated_at?: string;
        }
      >;
      memories: Table<
        { id: string; user_id: string; content: string; created_at: string },
        { user_id: string; content: string }
      >;
    };
    Views: Record<string, never>;
    Functions: {
      grant_credits: { Args: { p_user: string; p_amount: number; p_reason: string; p_ref: string }; Returns: number };
      spend_credits: { Args: { p_user: string; p_amount: number; p_reason: string; p_ref: string }; Returns: number };
      refund_credits: { Args: { p_user: string; p_ref: string }; Returns: number };
      rate_limit_hit: { Args: { p_key: string; p_limit: number; p_window_seconds: number }; Returns: boolean };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
