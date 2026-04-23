import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// A session holds the whole consensus round
// status flow: drafting → voting → executing → complete
export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull().default("og"), // og | phala
  status: text("status").notNull().default("drafting"), // drafting | voting | executing | complete
  prompt: text("prompt"),           // the single submitted prompt
  mergedPrompt: text("merged_prompt"), // kept for compatibility, same as prompt
  llmResponse: text("llm_response"),
  attestationReport: text("attestation_report"), // JSON string
  attestationNonce: text("attestation_nonce"),
  createdAt: integer("created_at").notNull(),
  completedAt: integer("completed_at"),
});

// Votes on the prompt (approve/reject)
export const votes = sqliteTable("votes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  userId: integer("user_id").notNull(), // 1-10
  userName: text("user_name").notNull(),
  approve: integer("approve").notNull(), // 1 = approve, 0 = reject
  votedAt: integer("voted_at").notNull(),
});

// Insert schemas
export const insertSessionSchema = createInsertSchema(sessions).omit({ id: true });
export const insertVoteSchema = createInsertSchema(votes).omit({ id: true });

// Insert types
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type InsertVote = z.infer<typeof insertVoteSchema>;

// Select types
export type Session = typeof sessions.$inferSelect;
export type Vote = typeof votes.$inferSelect;

// Keep Input as an alias for backward compat with any remaining refs
export type Input = {
  id: number;
  sessionId: number;
  userId: number;
  userName: string;
  content: string;
  submittedAt: number;
};
