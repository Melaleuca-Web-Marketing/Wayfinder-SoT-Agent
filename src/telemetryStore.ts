import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

export type TelemetryRating = 'up' | 'down';

interface JsonObject {
  [key: string]: unknown;
}

export interface TelemetrySession {
  id: string;
  agentProfile: string;
  clientApp?: string;
  clientSessionId?: string;
  userAgent?: string;
  metadata?: JsonObject;
  createdAt: string;
}

export interface TelemetryTurn {
  id: string;
  sessionId: string;
  question: string;
  answer: string;
  responseMs?: number;
  model?: string;
  topicHint?: string;
  responseId?: string;
  requestedAt?: string;
  respondedAt?: string;
  metadata?: JsonObject;
  createdAt: string;
}

export interface TelemetryFeedback {
  turnId: string;
  rating: TelemetryRating;
  comment?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TelemetrySessionSummary {
  id: string;
  agentProfile: string;
  clientApp?: string;
  createdAt: string;
  turnCount: number;
  lastTurnAt?: string;
  thumbsUpCount: number;
  thumbsDownCount: number;
}

export interface TelemetrySessionDetail {
  session: TelemetrySession;
  turns: Array<
    TelemetryTurn & {
      feedback?: TelemetryFeedback;
    }
  >;
}

export interface StartTelemetrySessionInput {
  agentProfile: string;
  clientApp?: string;
  clientSessionId?: string;
  userAgent?: string;
  metadata?: JsonObject;
}

export interface RecordTelemetryTurnInput {
  sessionId: string;
  question: string;
  answer: string;
  responseMs?: number;
  model?: string;
  topicHint?: string;
  responseId?: string;
  requestedAt?: string;
  respondedAt?: string;
  metadata?: JsonObject;
}

export interface RecordTelemetryFeedbackInput {
  turnId: string;
  rating: TelemetryRating;
  comment?: string;
}

class TelemetryNotFoundError extends Error {}

interface TelemetryStore {
  startSession(input: StartTelemetrySessionInput): Promise<TelemetrySession>;
  recordTurn(input: RecordTelemetryTurnInput): Promise<TelemetryTurn>;
  recordFeedback(input: RecordTelemetryFeedbackInput): Promise<TelemetryFeedback>;
  listSessions(limit: number): Promise<TelemetrySessionSummary[]>;
  getSessionDetail(sessionId: string): Promise<TelemetrySessionDetail | null>;
}

interface FileTelemetryData {
  sessions: TelemetrySession[];
  turns: TelemetryTurn[];
  feedback: TelemetryFeedback[];
}

class FileTelemetryStore implements TelemetryStore {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async startSession(input: StartTelemetrySessionInput): Promise<TelemetrySession> {
    const session: TelemetrySession = {
      id: randomUUID(),
      agentProfile: input.agentProfile,
      clientApp: input.clientApp,
      clientSessionId: input.clientSessionId,
      userAgent: input.userAgent,
      metadata: input.metadata,
      createdAt: new Date().toISOString(),
    };

    await this.mutate((data) => {
      data.sessions.push(session);
    });

    return session;
  }

  async recordTurn(input: RecordTelemetryTurnInput): Promise<TelemetryTurn> {
    const turn: TelemetryTurn = {
      id: randomUUID(),
      sessionId: input.sessionId,
      question: input.question,
      answer: input.answer,
      responseMs: input.responseMs,
      model: input.model,
      topicHint: input.topicHint,
      responseId: input.responseId,
      requestedAt: input.requestedAt,
      respondedAt: input.respondedAt,
      metadata: input.metadata,
      createdAt: new Date().toISOString(),
    };

    await this.mutate((data) => {
      const sessionExists = data.sessions.some((session) => session.id === input.sessionId);
      if (!sessionExists) {
        throw new TelemetryNotFoundError(`Session ${input.sessionId} not found.`);
      }
      data.turns.push(turn);
    });

    return turn;
  }

  async recordFeedback(input: RecordTelemetryFeedbackInput): Promise<TelemetryFeedback> {
    const now = new Date().toISOString();
    const entry: TelemetryFeedback = {
      turnId: input.turnId,
      rating: input.rating,
      comment: input.comment,
      createdAt: now,
      updatedAt: now,
    };

    await this.mutate((data) => {
      const turnExists = data.turns.some((turn) => turn.id === input.turnId);
      if (!turnExists) {
        throw new TelemetryNotFoundError(`Turn ${input.turnId} not found.`);
      }

      const existing = data.feedback.find((feedback) => feedback.turnId === input.turnId);
      if (existing) {
        existing.rating = input.rating;
        existing.comment = input.comment;
        existing.updatedAt = now;
        return;
      }

      data.feedback.push(entry);
    });

    const data = await this.read();
    const saved = data.feedback.find((feedback) => feedback.turnId === input.turnId);
    if (!saved) {
      throw new Error('Feedback write failed.');
    }
    return saved;
  }

  async listSessions(limit: number): Promise<TelemetrySessionSummary[]> {
    const data = await this.read();
    const summaries = data.sessions
      .map((session) => {
        const turns = data.turns.filter((turn) => turn.sessionId === session.id);
        const turnIds = new Set(turns.map((turn) => turn.id));
        const feedback = data.feedback.filter((item) => turnIds.has(item.turnId));
        const thumbsUpCount = feedback.filter((item) => item.rating === 'up').length;
        const thumbsDownCount = feedback.filter((item) => item.rating === 'down').length;
        const sortedTurns = [...turns].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const lastTurnAt = sortedTurns.length > 0 ? sortedTurns[sortedTurns.length - 1].createdAt : undefined;

        const summary: TelemetrySessionSummary = {
          id: session.id,
          agentProfile: session.agentProfile,
          clientApp: session.clientApp,
          createdAt: session.createdAt,
          turnCount: turns.length,
          lastTurnAt,
          thumbsUpCount,
          thumbsDownCount,
        };
        return summary;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return summaries.slice(0, limit);
  }

  async getSessionDetail(sessionId: string): Promise<TelemetrySessionDetail | null> {
    const data = await this.read();
    const session = data.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return null;
    }

    const feedbackByTurnId = new Map(data.feedback.map((feedback) => [feedback.turnId, feedback]));
    const turns = data.turns
      .filter((item) => item.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((turn) => ({
        ...turn,
        feedback: feedbackByTurnId.get(turn.id),
      }));

    return {
      session,
      turns,
    };
  }

  private async mutate(fn: (data: FileTelemetryData) => void): Promise<void> {
    const data = await this.read();
    fn(data);
    await this.write(data);
  }

  private async read(): Promise<FileTelemetryData> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as FileTelemetryData;
      return {
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        turns: Array.isArray(parsed.turns) ? parsed.turns : [],
        feedback: Array.isArray(parsed.feedback) ? parsed.feedback : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { sessions: [], turns: [], feedback: [] };
      }
      throw error;
    }
  }

  private async write(data: FileTelemetryData): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tempPath, this.filePath);
  }
}

class PostgresTelemetryStore implements TelemetryStore {
  private pool: Pool;
  private schemaReady: Promise<void> | null = null;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      ssl: shouldUseSsl(databaseUrl) ? { rejectUnauthorized: false } : undefined,
    });
  }

  async startSession(input: StartTelemetrySessionInput): Promise<TelemetrySession> {
    await this.ensureSchema();

    const id = randomUUID();
    const result = await this.pool.query(
      `
      INSERT INTO chat_sessions (id, agent_profile, client_app, client_session_id, user_agent, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, agent_profile, client_app, client_session_id, user_agent, metadata, created_at
      `,
      [id, input.agentProfile, input.clientApp ?? null, input.clientSessionId ?? null, input.userAgent ?? null, input.metadata ?? null],
    );

    return mapSessionRow(result.rows[0]);
  }

  async recordTurn(input: RecordTelemetryTurnInput): Promise<TelemetryTurn> {
    await this.ensureSchema();

    const id = randomUUID();
    try {
      const result = await this.pool.query(
        `
        INSERT INTO chat_turns (
          id,
          session_id,
          question,
          answer,
          response_ms,
          model,
          topic_hint,
          response_id,
          requested_at,
          responded_at,
          metadata
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING id, session_id, question, answer, response_ms, model, topic_hint, response_id, requested_at, responded_at, metadata, created_at
        `,
        [
          id,
          input.sessionId,
          input.question,
          input.answer,
          input.responseMs ?? null,
          input.model ?? null,
          input.topicHint ?? null,
          input.responseId ?? null,
          input.requestedAt ?? null,
          input.respondedAt ?? null,
          input.metadata ?? null,
        ],
      );

      return mapTurnRow(result.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === '23503') {
        throw new TelemetryNotFoundError(`Session ${input.sessionId} not found.`);
      }
      throw error;
    }
  }

  async recordFeedback(input: RecordTelemetryFeedbackInput): Promise<TelemetryFeedback> {
    await this.ensureSchema();

    try {
      const result = await this.pool.query(
        `
        INSERT INTO chat_feedback (turn_id, rating, comment)
        VALUES ($1,$2,$3)
        ON CONFLICT (turn_id)
        DO UPDATE SET
          rating = EXCLUDED.rating,
          comment = EXCLUDED.comment,
          updated_at = NOW()
        RETURNING turn_id, rating, comment, created_at, updated_at
        `,
        [input.turnId, input.rating, input.comment ?? null],
      );

      return mapFeedbackRow(result.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === '23503') {
        throw new TelemetryNotFoundError(`Turn ${input.turnId} not found.`);
      }
      throw error;
    }
  }

  async listSessions(limit: number): Promise<TelemetrySessionSummary[]> {
    await this.ensureSchema();

    const result = await this.pool.query(
      `
      SELECT
        s.id,
        s.agent_profile,
        s.client_app,
        s.created_at,
        COUNT(t.id)::int AS turn_count,
        MAX(t.created_at) AS last_turn_at,
        COALESCE(SUM(CASE WHEN f.rating = 'up' THEN 1 ELSE 0 END), 0)::int AS thumbs_up_count,
        COALESCE(SUM(CASE WHEN f.rating = 'down' THEN 1 ELSE 0 END), 0)::int AS thumbs_down_count
      FROM chat_sessions s
      LEFT JOIN chat_turns t ON t.session_id = s.id
      LEFT JOIN chat_feedback f ON f.turn_id = t.id
      GROUP BY s.id
      ORDER BY s.created_at DESC
      LIMIT $1
      `,
      [limit],
    );

    return result.rows.map((row) => ({
      id: String(row.id),
      agentProfile: String(row.agent_profile),
      clientApp: toOptionalString(row.client_app),
      createdAt: toIsoString(row.created_at),
      turnCount: Number(row.turn_count ?? 0),
      lastTurnAt: row.last_turn_at ? toIsoString(row.last_turn_at) : undefined,
      thumbsUpCount: Number(row.thumbs_up_count ?? 0),
      thumbsDownCount: Number(row.thumbs_down_count ?? 0),
    }));
  }

  async getSessionDetail(sessionId: string): Promise<TelemetrySessionDetail | null> {
    await this.ensureSchema();

    const sessionResult = await this.pool.query(
      `
      SELECT id, agent_profile, client_app, client_session_id, user_agent, metadata, created_at
      FROM chat_sessions
      WHERE id = $1
      `,
      [sessionId],
    );

    if (sessionResult.rowCount === 0) {
      return null;
    }

    const turnsResult = await this.pool.query(
      `
      SELECT
        t.id,
        t.session_id,
        t.question,
        t.answer,
        t.response_ms,
        t.model,
        t.topic_hint,
        t.response_id,
        t.requested_at,
        t.responded_at,
        t.metadata,
        t.created_at,
        f.rating AS feedback_rating,
        f.comment AS feedback_comment,
        f.created_at AS feedback_created_at,
        f.updated_at AS feedback_updated_at
      FROM chat_turns t
      LEFT JOIN chat_feedback f ON f.turn_id = t.id
      WHERE t.session_id = $1
      ORDER BY t.created_at ASC
      `,
      [sessionId],
    );

    const turns = turnsResult.rows.map((row) => {
      const turn = mapTurnRow(row);
      const feedback = row.feedback_rating ? mapFeedbackRow({
        turn_id: row.id,
        rating: row.feedback_rating,
        comment: row.feedback_comment,
        created_at: row.feedback_created_at,
        updated_at: row.feedback_updated_at,
      }) : undefined;

      return {
        ...turn,
        feedback,
      };
    });

    return {
      session: mapSessionRow(sessionResult.rows[0]),
      turns,
    };
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.initializeSchema();
    }
    await this.schemaReady;
  }

  private async initializeSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        agent_profile TEXT NOT NULL,
        client_app TEXT,
        client_session_id TEXT,
        user_agent TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS chat_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        response_ms INTEGER,
        model TEXT,
        topic_hint TEXT,
        response_id TEXT,
        requested_at TIMESTAMPTZ,
        responded_at TIMESTAMPTZ,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS chat_feedback (
        turn_id TEXT PRIMARY KEY REFERENCES chat_turns(id) ON DELETE CASCADE,
        rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
        comment TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query('CREATE INDEX IF NOT EXISTS idx_chat_turns_session_id ON chat_turns(session_id)');
  }
}

function mapSessionRow(row: Record<string, unknown>): TelemetrySession {
  return {
    id: String(row.id),
    agentProfile: String(row.agent_profile),
    clientApp: toOptionalString(row.client_app),
    clientSessionId: toOptionalString(row.client_session_id),
    userAgent: toOptionalString(row.user_agent),
    metadata: toJsonObject(row.metadata),
    createdAt: toIsoString(row.created_at),
  };
}

function mapTurnRow(row: Record<string, unknown>): TelemetryTurn {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    question: String(row.question),
    answer: String(row.answer),
    responseMs: toOptionalNumber(row.response_ms),
    model: toOptionalString(row.model),
    topicHint: toOptionalString(row.topic_hint),
    responseId: toOptionalString(row.response_id),
    requestedAt: row.requested_at ? toIsoString(row.requested_at) : undefined,
    respondedAt: row.responded_at ? toIsoString(row.responded_at) : undefined,
    metadata: toJsonObject(row.metadata),
    createdAt: toIsoString(row.created_at),
  };
}

function mapFeedbackRow(row: Record<string, unknown>): TelemetryFeedback {
  return {
    turnId: String(row.turn_id),
    rating: normalizeRating(row.rating),
    comment: toOptionalString(row.comment),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function normalizeRating(value: unknown): TelemetryRating {
  return value === 'up' ? 'up' : 'down';
}

function toJsonObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function toIsoString(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

function shouldUseSsl(databaseUrl: string): boolean {
  const normalized = databaseUrl.toLowerCase();
  return normalized.includes('sslmode=require') || normalized.includes('neon.tech') || normalized.includes('vercel-storage.com');
}

function resolveTelemetryStore(): TelemetryStore {
  const databaseUrl = process.env.TELEMETRY_DATABASE_URL?.trim();
  if (databaseUrl) {
    console.log('[telemetry] using postgres store');
    return new PostgresTelemetryStore(databaseUrl);
  }

  const defaultFilePath = process.env.VERCEL ? '/tmp/telemetry-store.json' : path.resolve('.telemetry', 'telemetry-store.json');
  const filePath = process.env.TELEMETRY_FILE_PATH?.trim() || defaultFilePath;
  console.log(`[telemetry] using file store at ${filePath}`);
  return new FileTelemetryStore(filePath);
}

const store = resolveTelemetryStore();

export async function startTelemetrySession(input: StartTelemetrySessionInput): Promise<TelemetrySession> {
  return store.startSession({
    ...input,
    metadata: toJsonObject(input.metadata),
  });
}

export async function recordTelemetryTurn(input: RecordTelemetryTurnInput): Promise<TelemetryTurn> {
  return store.recordTurn({
    ...input,
    requestedAt: toTimestampOrUndefined(input.requestedAt),
    respondedAt: toTimestampOrUndefined(input.respondedAt),
    metadata: toJsonObject(input.metadata),
  });
}

export async function recordTelemetryFeedback(input: RecordTelemetryFeedbackInput): Promise<TelemetryFeedback> {
  return store.recordFeedback({
    ...input,
    comment: input.comment?.trim() || undefined,
  });
}

export async function listTelemetrySessions(limit: number): Promise<TelemetrySessionSummary[]> {
  return store.listSessions(limit);
}

export async function getTelemetrySessionDetail(sessionId: string): Promise<TelemetrySessionDetail | null> {
  return store.getSessionDetail(sessionId);
}

export function isTelemetryNotFoundError(error: unknown): error is TelemetryNotFoundError {
  return error instanceof TelemetryNotFoundError;
}

function toTimestampOrUndefined(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}
