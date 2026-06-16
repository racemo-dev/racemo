export type PromptStatus = "pending" | "testing" | "done";

export interface Prompt {
  id: string;
  text: string;
  folder?: string;
  status: PromptStatus;
  createdAt: number;
  completedAt?: number;
}
