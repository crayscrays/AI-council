import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, and } from "drizzle-orm";
import { sessions, votes } from "@shared/schema";
import type { Session, Vote, InsertSession, InsertVote } from "@shared/schema";

const sqlite = new Database("consensus.db");
export const db = drizzle(sqlite);

// Create tables — simplified: no inputs table, sessions use 'drafting' as initial status
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'drafting',
    prompt TEXT,
    merged_prompt TEXT,
    llm_response TEXT,
    attestation_report TEXT,
    attestation_nonce TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    approve INTEGER NOT NULL,
    voted_at INTEGER NOT NULL
  );
`);

export interface IStorage {
  getActiveSession(): Session | undefined;
  getLatestSession(): Session | undefined;
  createSession(): Session;
  updateSession(id: number, updates: Partial<Session>): Session | undefined;
  getVotesForSession(sessionId: number): Vote[];
  submitVote(vote: InsertVote): Vote;
  getUserVote(sessionId: number, userId: number): Vote | undefined;
}

export const storage: IStorage = {
  getLatestSession() {
    return db.select().from(sessions).orderBy(sessions.id).all().slice(-1)[0];
  },

  getActiveSession() {
    return (
      db.select().from(sessions).where(eq(sessions.status, "drafting")).get() ??
      db.select().from(sessions).where(eq(sessions.status, "voting")).get() ??
      db.select().from(sessions).where(eq(sessions.status, "executing")).get()
    );
  },

  createSession() {
    return db.insert(sessions).values({
      status: "drafting",
      createdAt: Date.now(),
    }).returning().get();
  },

  updateSession(id, updates) {
    return db.update(sessions).set(updates).where(eq(sessions.id, id)).returning().get();
  },

  getVotesForSession(sessionId) {
    return db.select().from(votes).where(eq(votes.sessionId, sessionId)).all();
  },

  submitVote(vote) {
    return db.insert(votes).values(vote).returning().get();
  },

  getUserVote(sessionId, userId) {
    return db.select().from(votes)
      .where(and(eq(votes.sessionId, sessionId), eq(votes.userId, userId)))
      .get();
  },
};
