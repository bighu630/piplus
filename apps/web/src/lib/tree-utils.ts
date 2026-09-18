import type { ProjectDTO, SessionTreeNodeDTO } from '@piplus/shared';

export function findSessionNode(projects: ProjectDTO[], sessionId: string): SessionTreeNodeDTO | null {
  for (const project of projects) {
    const stack = [...project.sessions];
    while (stack.length > 0) {
      const node = stack.shift()!;
      if (node.id === sessionId) return node;
      stack.push(...node.children);
    }
  }
  return null;
}

export function updateNodeRuntimeStatus(
  sessions: SessionTreeNodeDTO[],
  targetId: string,
  status: 'idle' | 'running' | 'stopping' | 'error'
): SessionTreeNodeDTO[] {
  return sessions.map(node => {
    if (node.id === targetId) {
      return { ...node, runtime_status: status };
    }
    if (node.children?.length) {
      return { ...node, children: updateNodeRuntimeStatus(node.children, targetId, status) };
    }
    return node;
  });
}

/** 树中第一个未归档会话（BFS：先项目顺序、再层序）及其所属项目。 */
export function findFirstSession(projects: ProjectDTO[]): { projectId: string; sessionId: string } | null {
  for (const project of projects) {
    const stack = [...project.sessions];
    while (stack.length > 0) {
      const node = stack.shift()!;
      if (!node.archived_at) return { projectId: project.id, sessionId: node.id };
      stack.push(...node.children);
    }
  }
  return null;
}

/** 会话所属项目 id；会话不在树中返回 null。 */
export function findProjectId(projects: ProjectDTO[], sessionId: string): string | null {
  for (const project of projects) {
    const stack = [...project.sessions];
    while (stack.length > 0) {
      const node = stack.shift()!;
      if (node.id === sessionId) return project.id;
      stack.push(...node.children);
    }
  }
  return null;
}
