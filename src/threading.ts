import { Pool } from "pg";

import { AIDecider } from "./ai";
import { config } from "./config";
import { RealtimeHub } from "./realtime";
import type { AssignmentDecision, MessageRecord, ThreadCandidate } from "./types";

interface ArchivedCandidate {
  id: string;
  title: string;
  recent_excerpt: string;
}

interface MergeCandidate {
  id: string;
  title: string;
  state: "active" | "cooling";
  last_message_at: string | null;
  recent_excerpt: string;
}

interface PendingMessage {
  id: string;
  created_at: string;
  author: string;
  content: string;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "we",
  "with",
  "you"
]);

function tokenize(input: string): Set<string> {
  return new Set(
    input
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (a.size + b.size - intersection);
}

function scoreSimilarity(textA: string, textB: string): number {
  return jaccard(tokenize(textA), tokenize(textB));
}

function buildTitle(message: string): string {
  const words = message.trim().split(/\s+/).slice(0, 8);
  const joined = words.join(" ").replace(/[^\w\s-]/g, "").trim();
  if (!joined) {
    return "Untitled discussion";
  }
  const withFirstUpper = joined.charAt(0).toUpperCase() + joined.slice(1);
  return withFirstUpper.length > 96
    ? `${withFirstUpper.slice(0, 93).trim()}...`
    : withFirstUpper;
}

function normalizeAssignmentDecision(
  decision: AssignmentDecision,
  candidates: ThreadCandidate[],
  fallbackTitle: string
): AssignmentDecision {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));

  if (
    decision.action === "assign" &&
    decision.threadId &&
    candidateIds.has(decision.threadId) &&
    decision.confidence >= 0.45
  ) {
    return decision;
  }

  return {
    action: "create",
    threadId: null,
    title: decision.title ?? fallbackTitle,
    confidence: decision.confidence ?? 0.5,
    reason: decision.reason || "No clear active thread match."
  };
}

export class ThreadingEngine {
  private readonly ai = new AIDecider();
  private assignmentLoopBusy = false;
  private lifecycleLoopBusy = false;
  private mergeLoopBusy = false;

  constructor(
    private readonly pool: Pool,
    private readonly realtimeHub: RealtimeHub
  ) {}

  start(): void {
    setInterval(() => void this.assignmentTick(), config.ASSIGNMENT_POLL_MS);
    setInterval(() => void this.lifecycleTick(), 10_000);
    setInterval(() => void this.mergeTick(), config.MERGE_POLL_MS);
    void this.assignmentTick();
    void this.lifecycleTick();
    void this.mergeTick();
  }

  private async assignmentTick(): Promise<void> {
    if (this.assignmentLoopBusy) return;
    this.assignmentLoopBusy = true;
    try {
      while (await this.processSinglePendingMessage()) {
        // Drain the queue to keep assignment latency low.
      }
    } finally {
      this.assignmentLoopBusy = false;
    }
  }

  private async lifecycleTick(): Promise<void> {
    if (this.lifecycleLoopBusy) return;
    this.lifecycleLoopBusy = true;
    try {
      const cooled = await this.pool.query<{ id: string }>(
        `
        UPDATE threads
        SET state = 'cooling',
            updated_at = NOW()
        WHERE state = 'active'
          AND last_message_at IS NOT NULL
          AND last_message_at < NOW() - make_interval(mins => $1::INT)
        RETURNING id
        `,
        [config.ACTIVE_TO_COOLING_MINUTES]
      );

      const archived = await this.pool.query<{ id: string }>(
        `
        UPDATE threads
        SET state = 'archived',
            archived_at = COALESCE(archived_at, NOW()),
            updated_at = NOW()
        WHERE state = 'cooling'
          AND last_message_at IS NOT NULL
          AND last_message_at < NOW() - make_interval(hours => $1::INT)
        RETURNING id
        `,
        [config.COOLING_TO_ARCHIVED_HOURS]
      );

      for (const row of cooled.rows) {
        this.realtimeHub.broadcast("thread.updated", { id: row.id });
      }
      for (const row of archived.rows) {
        this.realtimeHub.broadcast("thread.updated", { id: row.id });
      }
    } catch (error) {
      console.error("lifecycleTick failed", error);
    } finally {
      this.lifecycleLoopBusy = false;
    }
  }

  private async mergeTick(): Promise<void> {
    if (this.mergeLoopBusy) return;
    this.mergeLoopBusy = true;
    try {
      const candidates = await this.fetchMergeCandidates();
      if (candidates.length < 2) {
        return;
      }

      const pair = this.findMergePair(candidates);
      if (!pair) {
        return;
      }

      let shouldMerge = pair.score >= 0.78;
      let sourceThreadId = pair.source.id;
      let targetThreadId = pair.target.id;

      if (this.ai.enabled) {
        try {
          const decision = await this.ai.decideMerge(pair.source, pair.target);
          shouldMerge = decision.shouldMerge && decision.confidence >= 0.6;
          sourceThreadId = decision.sourceThreadId;
          targetThreadId = decision.targetThreadId;
        } catch (error) {
          console.error("AI merge decision failed, using heuristic", error);
        }
      }

      const validIds = new Set([pair.source.id, pair.target.id]);
      if (!validIds.has(sourceThreadId) || !validIds.has(targetThreadId)) {
        sourceThreadId = pair.source.id;
        targetThreadId = pair.target.id;
      }
      if (sourceThreadId === targetThreadId) {
        shouldMerge = false;
      }
      if (!shouldMerge) {
        return;
      }

      const sourceLast = pair.source.last_message_at ?? "";
      const targetLast = pair.target.last_message_at ?? "";
      if (sourceLast > targetLast) {
        const originalTarget = targetThreadId;
        targetThreadId = sourceThreadId;
        sourceThreadId = originalTarget;
      }

      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");

        const updatedSource = await client.query<{ id: string }>(
          `
          UPDATE threads
          SET state = 'superseded',
              merged_into_thread_id = $2,
              superseded_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
            AND state IN ('active', 'cooling')
          RETURNING id
          `,
          [sourceThreadId, targetThreadId]
        );

        if (updatedSource.rowCount === 0) {
          await client.query("ROLLBACK");
          return;
        }

        await client.query(
          `
          UPDATE messages
          SET thread_id = $2
          WHERE thread_id = $1
          `,
          [sourceThreadId, targetThreadId]
        );

        await client.query(
          `
          UPDATE threads
          SET state = 'active',
              last_message_at = (
                SELECT MAX(created_at) FROM messages WHERE thread_id = $1
              ),
              updated_at = NOW()
          WHERE id = $1
          `,
          [targetThreadId]
        );

        await client.query("COMMIT");

        this.realtimeHub.broadcast("thread.merged", {
          sourceThreadId,
          targetThreadId
        });
        this.realtimeHub.broadcast("thread.updated", { id: sourceThreadId });
        this.realtimeHub.broadcast("thread.updated", { id: targetThreadId });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("mergeTick failed", error);
    } finally {
      this.mergeLoopBusy = false;
    }
  }

  private async processSinglePendingMessage(): Promise<boolean> {
    const pending = await this.claimPendingMessage();
    if (!pending) {
      return false;
    }

    const defaultTitle = buildTitle(pending.content);
    const messageForAI = {
      author: pending.author,
      content: pending.content,
      created_at: pending.created_at
    };
    try {
      const candidates = await this.fetchActiveThreadCandidates();
      let decision: AssignmentDecision;

      if (candidates.length === 0) {
        decision = {
          action: "create",
          threadId: null,
          title: defaultTitle,
          confidence: 1,
          reason: "First thread in the system."
        };
      } else if (this.ai.enabled) {
        try {
          const aiDecision = await this.ai.decideAssignment(messageForAI, candidates);
          decision = normalizeAssignmentDecision(aiDecision, candidates, defaultTitle);
        } catch (error) {
          console.error("AI assignment failed, using heuristic", error);
          decision = this.fallbackAssignment(pending, candidates, defaultTitle);
        }
      } else {
        decision = this.fallbackAssignment(pending, candidates, defaultTitle);
      }

      const revivalSourceId =
        decision.action === "create" ? await this.findRevivalSource(pending) : null;
      const assignment = await this.applyAssignment(
        pending,
        decision,
        revivalSourceId
      );
      this.realtimeHub.broadcast("message.updated", {
        id: pending.id,
        thread_id: assignment.threadId,
        assignment_status: "assigned",
        assignment_note: decision.reason
      });

      if (assignment.createdThreadId) {
        this.realtimeHub.broadcast("thread.created", {
          id: assignment.createdThreadId
        });
      }
      this.realtimeHub.broadcast("thread.updated", { id: assignment.threadId });

      if (assignment.revivalLink) {
        this.realtimeHub.broadcast("thread.updated", { id: assignment.revivalLink.oldId });
        this.realtimeHub.broadcast("thread.updated", { id: assignment.revivalLink.newId });
      }

      return true;
    } catch (error) {
      console.error("processSinglePendingMessage failed", error);
      await this.pool.query(
        `
        UPDATE messages
        SET assignment_status = 'failed',
            assignment_note = $2
        WHERE id = $1
        `,
        [pending.id, "Assignment failed. Check server logs."]
      );
      this.realtimeHub.broadcast("message.updated", {
        id: pending.id,
        assignment_status: "failed",
        assignment_note: "Assignment failed. Check server logs."
      });
      return true;
    }
  }

  private async claimPendingMessage(): Promise<PendingMessage | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const picked = await client.query<PendingMessage>(
        `
        SELECT id, created_at, author, content
        FROM messages
        WHERE assignment_status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
        `
      );

      if (picked.rowCount === 0) {
        await client.query("COMMIT");
        return null;
      }

      const pending = picked.rows[0];
      await client.query(
        `
        UPDATE messages
        SET assignment_status = 'in_progress'
        WHERE id = $1
        `,
        [pending.id]
      );
      await client.query("COMMIT");
      return pending;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async fetchActiveThreadCandidates(): Promise<ThreadCandidate[]> {
    const rows = await this.pool.query<ThreadCandidate>(
      `
      SELECT
        t.id,
        t.title,
        t.state,
        t.last_message_at,
        COALESCE(
          STRING_AGG(m.content, E'\n' ORDER BY m.created_at DESC),
          ''
        ) AS recent_excerpt
      FROM threads t
      LEFT JOIN LATERAL (
        SELECT content, created_at
        FROM messages
        WHERE thread_id = t.id
        ORDER BY created_at DESC
        LIMIT 6
      ) m ON TRUE
      WHERE t.state IN ('active', 'cooling')
      GROUP BY t.id
      ORDER BY COALESCE(t.last_message_at, t.updated_at) DESC
      LIMIT $1
      `,
      [config.MAX_ACTIVE_THREAD_CANDIDATES]
    );

    return rows.rows;
  }

  private fallbackAssignment(
    pending: PendingMessage,
    candidates: ThreadCandidate[],
    defaultTitle: string
  ): AssignmentDecision {
    const messageText = `${pending.content}`;
    let best: { id: string; score: number } | null = null;
    for (const candidate of candidates) {
      const score = scoreSimilarity(
        messageText,
        `${candidate.title} ${candidate.recent_excerpt}`
      );
      if (!best || score > best.score) {
        best = { id: candidate.id, score };
      }
    }

    if (best && best.score >= 0.26) {
      return {
        action: "assign",
        threadId: best.id,
        title: null,
        confidence: Math.min(1, best.score + 0.25),
        reason: "Heuristic token overlap matched an existing thread."
      };
    }

    return {
      action: "create",
      threadId: null,
      title: defaultTitle,
      confidence: 0.62,
      reason: "No strong overlap with existing active threads."
    };
  }

  private async findRevivalSource(
    pending: PendingMessage
  ): Promise<string | null> {
    const archived = await this.pool.query<ArchivedCandidate>(
      `
      SELECT
        t.id,
        t.title,
        COALESCE(
          STRING_AGG(m.content, E'\n' ORDER BY m.created_at DESC),
          ''
        ) AS recent_excerpt
      FROM threads t
      LEFT JOIN LATERAL (
        SELECT content, created_at
        FROM messages
        WHERE thread_id = t.id
        ORDER BY created_at DESC
        LIMIT 8
      ) m ON TRUE
      WHERE t.state = 'archived'
      GROUP BY t.id
      ORDER BY COALESCE(t.last_message_at, t.updated_at) DESC
      LIMIT $1
      `,
      [config.MAX_ARCHIVED_THREAD_CANDIDATES]
    );

    if (archived.rowCount === 0) {
      return null;
    }

    if (this.ai.enabled) {
      try {
        const aiDecision = await this.ai.decideRevivalLink(
          {
            author: pending.author,
            content: pending.content,
            created_at: pending.created_at
          },
          archived.rows
        );
        if (
          aiDecision.archivedThreadId &&
          aiDecision.confidence >= 0.62 &&
          archived.rows.some(
            (row: ArchivedCandidate) => row.id === aiDecision.archivedThreadId
          )
        ) {
          return aiDecision.archivedThreadId;
        }
      } catch (error) {
        console.error("AI revival link decision failed, using heuristic", error);
      }
    }

    let best: { id: string; score: number } | null = null;
    for (const candidate of archived.rows) {
      const score = scoreSimilarity(
        pending.content,
        `${candidate.title} ${candidate.recent_excerpt}`
      );
      if (!best || score > best.score) {
        best = { id: candidate.id, score };
      }
    }
    if (best && best.score >= 0.31) {
      return best.id;
    }

    return null;
  }

  private async applyAssignment(
    pending: PendingMessage,
    decision: AssignmentDecision,
    revivalSourceId: string | null
  ): Promise<{
    threadId: string;
    createdThreadId: string | null;
    revivalLink: { oldId: string; newId: string } | null;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let threadId: string | null = decision.threadId;
      let createdThreadId: string | null = null;
      let revivalLink: { oldId: string; newId: string } | null = null;

      if (decision.action === "create" || !threadId) {
        const created = await client.query<{ id: string }>(
          `
          INSERT INTO threads (
            title,
            state,
            last_message_at,
            updated_at
          )
          VALUES ($1, 'active', $2, NOW())
          RETURNING id
          `,
          [decision.title ?? buildTitle(pending.content), pending.created_at]
        );
        threadId = created.rows[0].id;
        createdThreadId = threadId;

        if (revivalSourceId) {
          const superseded = await client.query<{ id: string }>(
            `
            UPDATE threads
            SET state = 'superseded',
                superseded_at = NOW(),
                continued_in_thread_id = $2,
                updated_at = NOW()
            WHERE id = $1
              AND state = 'archived'
            RETURNING id
            `,
            [revivalSourceId, threadId]
          );

          if ((superseded.rowCount ?? 0) > 0) {
            await client.query(
              `
              UPDATE threads
              SET revives_thread_id = $2,
                  updated_at = NOW()
              WHERE id = $1
              `,
              [threadId, revivalSourceId]
            );
            revivalLink = { oldId: revivalSourceId, newId: threadId };
          }
        }
      }

      if (!threadId) {
        throw new Error("Assignment did not produce a thread id");
      }

      await client.query(
        `
        UPDATE messages
        SET thread_id = $2,
            assignment_status = 'assigned',
            assignment_note = $3
        WHERE id = $1
        `,
        [pending.id, threadId, decision.reason]
      );

      await client.query(
        `
        UPDATE threads
        SET state = CASE WHEN state = 'cooling' THEN 'active' ELSE state END,
            updated_at = NOW(),
            last_message_at = GREATEST(
              COALESCE(last_message_at, $2::timestamptz),
              $2::timestamptz
            )
        WHERE id = $1
        `,
        [threadId, pending.created_at]
      );

      await client.query("COMMIT");

      return {
        threadId,
        createdThreadId,
        revivalLink
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async fetchMergeCandidates(): Promise<MergeCandidate[]> {
    const rows = await this.pool.query<MergeCandidate>(
      `
      SELECT
        t.id,
        t.title,
        t.state,
        t.last_message_at,
        COALESCE(
          STRING_AGG(m.content, E'\n' ORDER BY m.created_at DESC),
          ''
        ) AS recent_excerpt
      FROM threads t
      LEFT JOIN LATERAL (
        SELECT content, created_at
        FROM messages
        WHERE thread_id = t.id
        ORDER BY created_at DESC
        LIMIT 5
      ) m ON TRUE
      WHERE t.state IN ('active', 'cooling')
      GROUP BY t.id
      ORDER BY COALESCE(t.last_message_at, t.updated_at) DESC
      LIMIT 16
      `
    );
    return rows.rows;
  }

  private findMergePair(candidates: MergeCandidate[]): {
    source: MergeCandidate;
    target: MergeCandidate;
    score: number;
  } | null {
    let best: { source: MergeCandidate; target: MergeCandidate; score: number } | null =
      null;
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const first = candidates[i];
        const second = candidates[j];
        const score = scoreSimilarity(
          `${first.title} ${first.recent_excerpt}`,
          `${second.title} ${second.recent_excerpt}`
        );
        if (!best || score > best.score) {
          best = { source: first, target: second, score };
        }
      }
    }
    if (!best || best.score < 0.58) {
      return null;
    }
    return best;
  }
}
