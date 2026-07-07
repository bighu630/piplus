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
