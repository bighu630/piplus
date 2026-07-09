import type { RoleManagerDb } from '../role-manager/service';
import type { PiClient } from '@piplus/pi-client';
import { createRoleManagerService } from '../role-manager/service';

export async function createProjectWithPlanner(db: RoleManagerDb, piClient: PiClient, name: string, createdBy: string, projectPath?: string, sourceType?: string, sourceUrl?: string, plannerModel?: { provider: string; id: string } | null, gitConfigJson?: string) {
  const roleManager = createRoleManagerService(db, piClient);
  return roleManager.createProjectWithPlanner({ name, createdBy, projectPath, sourceType, sourceUrl, plannerModel, gitConfigJson });
}
