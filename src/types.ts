export type ThreadState = "active" | "cooling" | "archived" | "superseded";

export type AssignmentStatus =
  | "pending"
  | "in_progress"
  | "assigned"
  | "failed";

export interface MessageRecord {
  id: string;
  created_at: string;
  author: string;
  content: string;
  thread_id: string | null;
  assignment_status: AssignmentStatus;
  assignment_note: string | null;
}

export interface ThreadRecord {
  id: string;
  title: string;
  state: ThreadState;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  archived_at: string | null;
  superseded_at: string | null;
  revives_thread_id: string | null;
  continued_in_thread_id: string | null;
  merged_into_thread_id: string | null;
}

export interface ThreadCandidate {
  id: string;
  title: string;
  state: "active" | "cooling";
  last_message_at: string | null;
  recent_excerpt: string;
}

export interface AssignmentDecision {
  action: "assign" | "create";
  threadId: string | null;
  title: string | null;
  confidence: number;
  reason: string;
}

export interface MergeDecision {
  shouldMerge: boolean;
  sourceThreadId: string;
  targetThreadId: string;
  confidence: number;
  reason: string;
}

