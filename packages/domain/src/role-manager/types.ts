export type SpawnSessionInput = {
  role: string;
  target: string;
  constraints: string[];
};

export type WritebackToParentInput = {
  summary: string;
  blocks?: unknown[] | null;
};
