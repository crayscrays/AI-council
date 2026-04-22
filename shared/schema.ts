import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// A session holds the whole consensus round
export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  status: text("status").notNull().default("collecting"), // collecting | reviewing | voting | executing | complete
  mergedPrompt: text("merged_prompt"),
  llmResponse: text("llm_response"),
  attestationReport: text("attestation_report"), // JSON string
  attestationNonce: text("attestation_nonce"),
  createdAt: integer("created_at").notNull(),
  completedAt: integer("completed_at"),
});

// Each user's input contribution
export const inputs = sqliteTable("inputs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  userId: integer("user_id").notNull(), // 1-10
  userName: text("user_name").notNull(),
  content: text("content").notNull(),
  submittedAt: integer("submitted_at").notNull(),
});

// Votes on the merged prompt
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
export const insertInputSchema = createInsertSchema(inputs).omit({ id: true });
export const insertVoteSchema = createInsertSchema(votes).omit({ id: true });

// Insert types
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type InsertInput = z.infer<typeof insertInputSchema>;
export type InsertVote = z.infer<typeof insertVoteSchema>;

// Select types
export type Session = typeof sessions.$inferSelect;
export type Input = typeof inputs.$inferSelect;
export type Vote = typeof votes.$inferSelect;
