export type InternalSpawnSessionInput = {
  role: string;
  target: string;
  constraints: string[];
};

export function buildSpawnSessionInput(input: InternalSpawnSessionInput) {
  return {
    role: input.role,
    target: input.target,
    constraints: input.constraints,
  };
}
