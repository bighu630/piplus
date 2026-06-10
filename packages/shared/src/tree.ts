import type { ProjectDTO, SessionTreeNodeDTO } from './dto';

export type TreeResponse = {
  projects: ProjectDTO[];
};

export function isSessionTreeNodeDTO(value: SessionTreeNodeDTO | undefined): value is SessionTreeNodeDTO {
  return Boolean(value && typeof value.id === 'string');
}
