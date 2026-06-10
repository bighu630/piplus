'use client';

import { ChevronRight, FolderKanban, GitBranch, Layers3 } from 'lucide-react';
import { motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import type { TreeResponse } from '@piplus/shared';

type ProjectTreeProps = {
  activeSessionId: string | null;
  onSelectSession: (projectId: string, sessionId: string) => void;
  showArchived: boolean;
  tree: TreeResponse['projects'];
};

export function ProjectTree({ activeSessionId, onSelectSession, showArchived, tree }: ProjectTreeProps) {
  return (
    <div className="space-y-4">
      {tree.map((project) => (
        <motion.section key={project.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: "easeOut" }} className="rounded-[20px] border border-white/6 bg-black/10 p-3">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="tree-icon-wrap">
                  <FolderKanban size={14} strokeWidth={2} />
                </div>
                <p className="truncate text-[14px] font-semibold text-[var(--text)]">{project.name}</p>
              </div>
              <p className="mt-1 text-[12px] text-[var(--text-dim)]">Project</p>
            </div>
            <span className="status-pill status-project">{project.status}</span>
          </div>

          <div className="space-y-1.5">
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

  return (
    <div className="space-y-1.5">
      <div className="flex items-stretch gap-2" style={{ marginLeft: depth * 14 }}>
        {hasChildren ? (
          <button
            aria-label={expanded ? 'collapse session' : 'expand session'}
            className="tree-expander"
            onClick={() => setExpanded((value) => !value)}
            type="button"
          >
            <ChevronRight className={`tree-expander-svg ${expanded ? 'tree-expander-open' : ''}`} size={14} strokeWidth={2} />
          </button>
        ) : (
          <span className="tree-expander tree-expander-empty" />
        )}

        <button
          className={`tree-node ${isActive ? 'tree-node-active' : ''} ${node.archived_at ? 'tree-node-archived' : ''}`}
          onClick={() => onSelectSession(projectId, node.id)}
          type="button"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="tree-icon-wrap tree-icon-wrap-session">
                  {hasChildren ? <GitBranch size={13} strokeWidth={2} /> : <Layers3 size={13} strokeWidth={2} />}
                </div>
                <span className={`runtime-dot runtime-${node.runtime_status}`} />
                <p className="truncate text-[13px] font-medium text-[var(--text)]">{node.title}</p>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-dim)]">
                <span>{node.role_template_key}</span>
                <span className="opacity-50">·</span>
                <span>{node.runtime_status}</span>
                {node.archived_at ? (
                  <>
                    <span className="opacity-50">·</span>
                    <span>archived</span>
                  </>
                ) : null}
              </div>
            </div>
            <span className="tree-depth">L{node.depth}</span>
          </div>
        </button>
      </div>

      {expanded && hasChildren ? (
        <div className="space-y-1.5">
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
