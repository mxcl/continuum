import OpenAI from "openai";

import { config } from "./config";
import type {
  AssignmentDecision,
  MergeDecision,
  ThreadCandidate
} from "./types";

interface ArchivedCandidate {
  id: string;
  title: string;
  recent_excerpt: string;
}

interface MergeCandidate {
  id: string;
  title: string;
  recent_excerpt: string;
}

const assignmentSchema = {
  name: "thread_assignment",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["assign", "create"]
      },
      threadId: {
        type: ["string", "null"]
      },
      title: {
        type: ["string", "null"]
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1
      },
      reason: {
        type: "string"
      }
    },
    required: ["action", "threadId", "title", "confidence", "reason"]
  },
  strict: true
} as const;

const revivalSchema = {
  name: "revival_link",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      archivedThreadId: {
        type: ["string", "null"]
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1
      },
      reason: {
        type: "string"
      }
    },
    required: ["archivedThreadId", "confidence", "reason"]
  },
  strict: true
} as const;

const mergeSchema = {
  name: "thread_merge",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      shouldMerge: { type: "boolean" },
      sourceThreadId: { type: "string" },
      targetThreadId: { type: "string" },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1
      },
      reason: { type: "string" }
    },
    required: [
      "shouldMerge",
      "sourceThreadId",
      "targetThreadId",
      "confidence",
      "reason"
    ]
  },
  strict: true
} as const;

export class AIDecider {
  private readonly client: OpenAI | null;

  constructor() {
    this.client = config.OPENAI_API_KEY
      ? new OpenAI({ apiKey: config.OPENAI_API_KEY })
      : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  async decideAssignment(
    message: { author: string; content: string; created_at: string },
    candidates: ThreadCandidate[]
  ): Promise<AssignmentDecision> {
    if (!this.client) {
      throw new Error("OpenAI client is not configured");
    }

    const completion = await this.client.chat.completions.create({
      model: config.OPENAI_MODEL,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: assignmentSchema
      },
      messages: [
        {
          role: "system",
          content:
            "You assign live chat messages to active threads. Use assign when " +
            "one thread is clearly the same discussion. Use create for new " +
            "topics. Be conservative. Return valid JSON only."
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              message,
              candidates
            },
            null,
            2
          )
        }
      ]
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No response content for assignment decision");
    }

    return JSON.parse(content) as AssignmentDecision;
  }

  async decideRevivalLink(
    message: { author: string; content: string; created_at: string },
    candidates: ArchivedCandidate[]
  ): Promise<{ archivedThreadId: string | null; confidence: number }> {
    if (!this.client) {
      throw new Error("OpenAI client is not configured");
    }

    const completion = await this.client.chat.completions.create({
      model: config.OPENAI_MODEL,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: revivalSchema
      },
      messages: [
        {
          role: "system",
          content:
            "A new message starts a new thread. Decide whether it revives one " +
            "archived historical thread. Pick null if no close match."
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              message,
              archivedCandidates: candidates
            },
            null,
            2
          )
        }
      ]
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No response content for revival decision");
    }

    const parsed = JSON.parse(content) as {
      archivedThreadId: string | null;
      confidence: number;
    };
    return parsed;
  }

  async decideMerge(
    source: MergeCandidate,
    target: MergeCandidate
  ): Promise<MergeDecision> {
    if (!this.client) {
      throw new Error("OpenAI client is not configured");
    }

    const completion = await this.client.chat.completions.create({
      model: config.OPENAI_MODEL,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: mergeSchema
      },
      messages: [
        {
          role: "system",
          content:
            "Decide if two active discussions are duplicates and should be " +
            "merged. Merge only when the overlap is high and clear."
        },
        {
          role: "user",
          content: JSON.stringify({ source, target }, null, 2)
        }
      ]
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No response content for merge decision");
    }

    return JSON.parse(content) as MergeDecision;
  }
}

