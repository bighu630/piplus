export type InternalSpawnSessionInput = {
  role: string;
  objective: string;
  scope?: string;
  task?: string;
  constraints: string[];
};

export function buildSpawnSessionInput(input: InternalSpawnSessionInput) {
  return {
    role: input.role,
    objective: input.objective,
    scope: input.scope,
    task: input.task,
    constraints: input.constraints,
  };
}
