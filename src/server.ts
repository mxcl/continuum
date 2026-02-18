import http from "node:http";
import path from "node:path";

import express from "express";
import { z } from "zod";

import { config } from "./config";
import { pool, runSchemaMigration } from "./db";
import { RealtimeHub } from "./realtime";
import { ThreadingEngine } from "./threading";
import type { MessageRecord, ThreadRecord, ThreadState } from "./types";

const createMessageSchema = z.object({
  author: z.string().trim().min(1).max(40),
  content: z.string().trim().min(1).max(2000)
});

const app = express();
app.use(express.json());
app.use(express.static(path.resolve(process.cwd(), "public")));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    openaiConfigured: config.hasOpenAI
  });
});

app.get("/api/messages", async (req, res) => {
  const limitParam = Number(req.query.limit ?? 200);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(limitParam, 1), 500)
    : 200;

  const rows = await pool.query<
    MessageRecord & { thread_title: string | null; thread_state: ThreadState | null }
  >(
    `
    SELECT
      m.id,
      m.created_at,
      m.author,
      m.content,
      m.thread_id,
      m.assignment_status,
      m.assignment_note,
      t.title AS thread_title,
      t.state AS thread_state
    FROM (
      SELECT *
      FROM messages
      ORDER BY created_at DESC
      LIMIT $1
    ) m
    LEFT JOIN threads t ON t.id = m.thread_id
    ORDER BY m.created_at ASC
    `,
    [limit]
  );

  res.json({
    messages: rows.rows
  });
});

app.post("/api/messages", async (req, res) => {
  const parsed = createMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid payload",
      details: parsed.error.issues
    });
    return;
  }

  const rows = await pool.query<MessageRecord>(
    `
    INSERT INTO messages (
      author,
      content,
      assignment_status
    )
    VALUES ($1, $2, 'pending')
    RETURNING
      id,
      created_at,
      author,
      content,
      thread_id,
      assignment_status,
      assignment_note
    `,
    [parsed.data.author, parsed.data.content]
  );

  const message = rows.rows[0];
  realtimeHub.broadcast("message.created", message);
  res.status(201).json({ message });
});

app.get("/api/threads", async (req, res) => {
  const rawStates = typeof req.query.states === "string" ? req.query.states : "";
  const requestedStates = rawStates
    .split(",")
    .map((state) => state.trim())
    .filter((state): state is ThreadState =>
      ["active", "cooling", "archived", "superseded"].includes(state)
    );
  const states: ThreadState[] =
    requestedStates.length > 0
      ? requestedStates
      : ["active", "cooling", "archived", "superseded"];

  const rows = await pool.query<
    ThreadRecord & { message_count: number; preview: string | null }
  >(
    `
    SELECT
      t.*,
      (
        SELECT COUNT(*)::INT
        FROM messages m
        WHERE m.thread_id = t.id
      ) AS message_count,
      (
        SELECT m2.content
        FROM messages m2
        WHERE m2.thread_id = t.id
        ORDER BY m2.created_at DESC
        LIMIT 1
      ) AS preview
    FROM threads t
    WHERE t.state = ANY($1::thread_state[])
    ORDER BY COALESCE(t.last_message_at, t.created_at) DESC
    `,
    [states]
  );

  res.json({ threads: rows.rows });
});

app.get("/api/threads/:id", async (req, res) => {
  const { id } = req.params;

  const threadRows = await pool.query<ThreadRecord>(
    `
    SELECT *
    FROM threads
    WHERE id = $1
    LIMIT 1
    `,
    [id]
  );

  const thread = threadRows.rows[0];
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  const messageRows = await pool.query<MessageRecord>(
    `
    SELECT
      id,
      created_at,
      author,
      content,
      thread_id,
      assignment_status,
      assignment_note
    FROM messages
    WHERE thread_id = $1
    ORDER BY created_at ASC
    `,
    [id]
  );

  const linkedRows = await pool.query<
    Pick<ThreadRecord, "id" | "title" | "state"> & { relation: string }
  >(
    `
    SELECT id, title, state, 'revives' AS relation
    FROM threads
    WHERE id = $1
    UNION ALL
    SELECT id, title, state, 'continued_in' AS relation
    FROM threads
    WHERE id = $2
    UNION ALL
    SELECT id, title, state, 'merged_into' AS relation
    FROM threads
    WHERE id = $3
    UNION ALL
    SELECT id, title, state, 'merged_from' AS relation
    FROM threads
    WHERE merged_into_thread_id = $4
    `,
    [
      thread.revives_thread_id,
      thread.continued_in_thread_id,
      thread.merged_into_thread_id,
      thread.id
    ]
  );

  res.json({
    thread,
    messages: messageRows.rows,
    linked_threads: linkedRows.rows
  });
});

app.get("/api/search", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) {
    res.status(400).json({ error: "Query must be at least 2 characters" });
    return;
  }

  const rows = await pool.query<
    Pick<ThreadRecord, "id" | "title" | "state" | "created_at" | "last_message_at"> & {
      rank: number;
    }
  >(
    `
    WITH thread_docs AS (
      SELECT
        t.id,
        t.title,
        t.state,
        t.created_at,
        t.last_message_at,
        setweight(to_tsvector('english', COALESCE(t.title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(STRING_AGG(m.content, ' '), '')), 'B')
          AS document
      FROM threads t
      LEFT JOIN messages m ON m.thread_id = t.id
      WHERE t.state IN ('archived', 'superseded')
      GROUP BY t.id
    )
    SELECT
      id,
      title,
      state,
      created_at,
      last_message_at,
      ts_rank_cd(document, plainto_tsquery('english', $1)) AS rank
    FROM thread_docs
    WHERE document @@ plainto_tsquery('english', $1)
    ORDER BY rank DESC, COALESCE(last_message_at, created_at) DESC
    LIMIT 20
    `,
    [q]
  );

  res.json({ results: rows.rows });
});

const server = http.createServer(app);
const realtimeHub = new RealtimeHub(server);
const threadingEngine = new ThreadingEngine(pool, realtimeHub);

async function main(): Promise<void> {
  await runSchemaMigration();
  threadingEngine.start();
  server.listen(config.PORT, () => {
    console.log(
      `Continuum server listening on http://localhost:${config.PORT} ` +
        `(OpenAI ${config.hasOpenAI ? "enabled" : "disabled"})`
    );
  });
}

main().catch((error) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});

