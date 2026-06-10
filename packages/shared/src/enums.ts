export const ProjectStatus = {
  active: 'active',
  archived: 'archived',
} as const;

export const SessionStatus = {
  active: 'active',
  archived: 'archived',
} as const;

export const RuntimeStatus = {
  idle: 'idle',
  running: 'running',
  stopping: 'stopping',
  error: 'error',
} as const;

export const MessageRole = {
  user: 'user',
  assistant: 'assistant',
  system: 'system',
} as const;

export const MessageKind = {
  normal: 'normal',
  writeback: 'writeback',
} as const;
