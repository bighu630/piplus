import { MessageKind, MessageRole, ProjectStatus, RuntimeStatus, SessionStatus } from './enums';

export type ProjectDTO = {
  id: string;
  name: string;
  status: keyof typeof ProjectStatus;
  project_path: string;
  source_type: string;
  source_url: string;
  archived_at: string | null;
  last_activity_at: string;
  created_at: string;
  sessions: SessionTreeNodeDTO[];
};

export type SessionTreeNodeDTO = {
  id: string;
  project_id: string;
  parent_session_id: string | null;
  root_session_id: string;
  depth: number;
  role_template_key: string;
  title: string;
  status: keyof typeof SessionStatus;
  runtime_status: keyof typeof RuntimeStatus;
  archived_at: string | null;
  last_activity_at: string;
  children: SessionTreeNodeDTO[];
};

export type SessionInfoDTO = {
  session: {
    id: string;
    title: string;
    project_id: string;
    parent_session_id: string | null;
    root_session_id: string;
    created_by: string;
    created_at: string;
    archived_at: string | null;
    pi_session_id: string;
    pi_session_locator_json: string;
    current_model: {
      provider: string;
      id: string;
      label: string;
    } | null;
    status: keyof typeof SessionStatus;
    runtime_status: keyof typeof RuntimeStatus;
  };
  project: {
    id: string;
    name: string;
  };
  lineage: {
    parent_session: { id: string; title: string } | null;
    root_session: { id: string; title: string } | null;
    depth: number;
  };
  role_template: {
    key: string;
    version: string;
    name: string;
  };
  prompts: {
    role_base_prompt_snapshot: string;
    user_supplied_prompt: string;
    parent_supplied_prompt: string;
    compiled_prompt: string;
  };
  sync: {
    sync_status: string;
    last_synced_at: string | null;
    last_pi_message_id: string | null;
    last_error: string | null;
    retry_count: number;
  };
  recent_events: Array<{
    id: string;
    type: string;
    payload: string;
    created_at: string;
  }>;
};

export type ChatMessageDTO = {
  id: string;
  role: keyof typeof MessageRole | 'tool';
  message_kind: keyof typeof MessageKind | 'tool_call' | 'tool';
  source_session_id: string | null;
  content_text: string;
  created_at: string;
  tool_name?: string | null;
  tool_args_json?: string | null;
};

export type SessionFileTreeNodeDTO = {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  children?: SessionFileTreeNodeDTO[];
};

export type SessionFileTreeResponseDTO = {
  session_id: string;
  root_path: string;
  tree: SessionFileTreeNodeDTO[];
};

export type SessionFileContentResponseDTO = {
  session_id: string;
  path: string;
  content: string;
  truncated: boolean;
};

export type SessionContextUsageDTO = {
  session_id: string;
  tokens: number | null;
  context_window: number;
  percent: number | null;
};
