import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// A session holds the whole inference round
// status flow: drafting → executing → complete
export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull().default("og"), // og | phala
  status: text("status").notNull().default("drafting"), // drafting | executing | complete
  prompt: text("prompt"),           // the single submitted prompt
  mergedPrompt: text("merged_prompt"), // kept for compatibility, same as prompt
  llmResponse: text("llm_response"),
  attestationReport: text("attestation_report"), // JSON string
  attestationNonce: text("attestation_nonce"),
  createdAt: integer("created_at").notNull(),
  completedAt: integer("completed_at"),
});

// Insert schemas
export const insertSessionSchema = createInsertSchema(sessions).omit({ id: true });

// Insert types
export type InsertSession = z.infer<typeof insertSessionSchema>;

// Select types
export type Session = typeof sessions.$inferSelect;

// Keep Input as an alias for backward compat with any remaining refs
export type Input = {
  id: number;
  sessionId: number;
  userId: number;
  userName: string;
  content: string;
  submittedAt: number;
};
