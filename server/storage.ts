import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, and } from "drizzle-orm";
import { sessions } from "@shared/schema";
import type { Session, InsertSession } from "@shared/schema";

const sqlite = new Database("consensus.db");
export const db = drizzle(sqlite);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL DEFAULT 'og',
    status TEXT NOT NULL DEFAULT 'drafting',
    prompt TEXT,
    merged_prompt TEXT,
    llm_response TEXT,
    attestation_report TEXT,
    attestation_nonce TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );
`);
try { sqlite.exec(`ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'og'`); } catch { /* already exists */ }

export interface IStorage {
  getActiveSession(provider: string): Session | undefined;
  getLatestSession(provider: string): Session | undefined;
  createSession(provider: string): Session;
  updateSession(id: number, updates: Partial<Session>): Session | undefined;
}

export const storage: IStorage = {
  getLatestSession(provider) {
    return db.select().from(sessions).where(eq(sessions.provider, provider)).orderBy(sessions.id).all().slice(-1)[0];
  },

  getActiveSession(provider) {
    return (
      db.select().from(sessions).where(and(eq(sessions.provider, provider), eq(sessions.status, "drafting"))).get() ??
      db.select().from(sessions).where(and(eq(sessions.provider, provider), eq(sessions.status, "executing"))).get()
    );
  },

  createSession(provider) {
    return db.insert(sessions).values({
      provider,
      status: "drafting",
      createdAt: Date.now(),
    }).returning().get();
  },

  updateSession(id, updates) {
    return db.update(sessions).set(updates).where(eq(sessions.id, id)).returning().get();
  },

};
