'use client';

import { Archive, ChevronRight, FolderKanban, Plus, Trash2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import type { TreeResponse } from '@piplus/shared';

type ProjectTreeProps = {
  activeSessionId: string | null;
  onSelectSession: (projectId: string, sessionId: string) => void;
  onSelectProject: (id: string) => void;
  showArchived: boolean;
  tree: TreeResponse['projects'];
  onCreateSession: () => void;
  creatingSession: boolean;
  onArchiveProject?: (projectId: string) => void;
  onDeleteProject?: (projectId: string) => void;
};

function roleLabel(key: string) {
  const map: Record<string, string> = {
    planner: '规划者',
    worker: '执行者',
    reviewer: '审查者',
    researcher: '研究者',
    blank: '空白',
  };
  return map[key] ?? key;
}

export function ProjectTree({ activeSessionId, onSelectSession, onSelectProject, showArchived, tree, onCreateSession, creatingSession, onArchiveProject, onDeleteProject }: ProjectTreeProps) {
  return (
    <div className="space-y-4">
      {tree.map((project) => (
        <motion.section key={project.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: "easeOut" }} className="rounded-[24px] border border-[var(--line)] bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.025))] p-4 shadow-[var(--glass-highlight),0_12px_28px_rgba(0,0,0,0.12)]">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="tree-icon-wrap">
                <FolderKanban size={14} strokeWidth={2} />
              </div>
              <p className="truncate text-[14px] font-semibold text-[var(--text)]">{project.name}</p>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {onArchiveProject ? (
                <button
                  className="ghost-button ghost-button-sm p-1"
                  onClick={() => onArchiveProject(project.id)}
                  type="button"
                  title="归档项目"
                >
                  <Archive size={12} />
                </button>
              ) : null}
              {onDeleteProject ? (
                <button
                  className="ghost-button ghost-button-sm p-1 text-red-400/60 hover:text-red-300"
                  onClick={() => {
                    if (confirm('确定删除此项目？会清除所有会话和消息。')) {
                      onDeleteProject(project.id);
                    }
                  }}
                  type="button"
                  title="删除项目"
                >
                  <Trash2 size={12} />
                </button>
              ) : null}
            </div>
          </div>

          {/* subtle new session button inside project */}
          <button
            className="mb-2 flex w-full items-center gap-1.5 py-1 text-[13px] text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
            disabled={creatingSession}
            onClick={() => { onSelectProject(project.id); onCreateSession(); }}
            type="button"
          >
            <Plus size={12} strokeWidth={2} />
            <span>{creatingSession ? '...' : '新建空白 Session'}</span>
          </button>

          <div className="space-y-1 pb-3">
            {project.sessions
              .filter((item) => showArchived || !item.archived_at)
              .map((session) => (
                <TreeNodeRow
                  activeSessionId={activeSessionId}
                  key={session.id}
                  node={session}
                  onSelectSession={onSelectSession}
                  projectId={project.id}
                  showArchived={showArchived}
                />
              ))}
          </div>
        </motion.section>
      ))}
    </div>
  );
}

function TreeNodeRow({
  activeSessionId,
  node,
  onSelectSession,
  projectId,
  showArchived,
  depth = 0,
}: {
  activeSessionId: string | null;
  node: TreeResponse['projects'][number]['sessions'][number];
  onSelectSession: (projectId: string, sessionId: string) => void;
  projectId: string;
  showArchived: boolean;
  depth?: number;
}) {
  const defaultExpanded = useMemo(() => depth < 2, [depth]);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasChildren = node.children.length > 0;
  const isActive = activeSessionId === node.id;
  const isStopped = node.runtime_status === 'stopping';
  const isArchived = Boolean(node.archived_at);

  return (
    <div>
      <div className="flex items-center gap-1" style={{ marginLeft: depth === 0 ? 0 : depth * 10 }}>
        {hasChildren ? (
          <button
            aria-label={expanded ? 'collapse session' : 'expand session'}
            className="flex items-center justify-center w-5 h-5 rounded-[8px] text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-white/5 transition-colors flex-shrink-0"
            onClick={() => setExpanded((value) => !value)}
            type="button"
          >
            <ChevronRight className={`transition-transform duration-160 ${expanded ? 'rotate-90' : ''}`} size={12} strokeWidth={2} />
          </button>
        ) : depth > 0 ? (
          <span className="w-5 flex-shrink-0" />
        ) : null}

        <button
          className={`flex-1 text-left rounded-[12px] border border-transparent bg-transparent px-2.5 py-1.5 text-[12px] transition-all duration-160 ${isActive ? 'bg-[linear-gradient(180deg,rgba(106,121,255,0.16),rgba(106,121,255,0.1))] border-[rgba(143,154,255,0.28)] shadow-[inset_3px_0_0_rgba(143,154,255,0.5),inset_0_1px_0_rgba(255,255,255,0.04),0_12px_24px_rgba(64,76,180,0.14)]' : 'hover:bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.03))] hover:border-[var(--line-soft)]'} ${isArchived ? 'opacity-52' : ''}`}
          onClick={() => onSelectSession(projectId, node.id)}
          type="button"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="break-words text-[14px] font-medium text-[var(--text)]">{node.title}</span>
            <span className="ml-auto flex-shrink-0 rounded-[6px] border border-[var(--line-soft)] bg-[rgba(255,255,255,0.04)] px-1.5 py-px text-[9px] text-[var(--text-dim)]">
              {roleLabel(node.role_template_key)}
            </span>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                flexShrink: 0,
                backgroundColor: isArchived || isStopped ? '#6b7280' : '#4ade80',
              }}
            />
          </div>
        </button>
      </div>

      {expanded && hasChildren ? (
        <div>
          {node.children
            .filter((item) => showArchived || !item.archived_at)
            .map((child) => (
              <TreeNodeRow
                activeSessionId={activeSessionId}
                key={child.id}
                node={child}
                onSelectSession={onSelectSession}
                projectId={projectId}
                showArchived={showArchived}
                depth={depth + 1}
              />
            ))}
        </div>
      ) : null}
    </div>
  );
}
