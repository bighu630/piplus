export type InternalWritebackToParentInput = {
  summary: string;
  blocks?: unknown[] | null;
};

export function buildWritebackToParentInput(input: InternalWritebackToParentInput) {
  return {
    summary: input.summary,
    blocks: input.blocks ?? null,
  };
}
