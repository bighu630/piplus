import type { RoleManagerDb } from '../role-manager/service';
import type { PiClient } from '@piplus/pi-client';
import { createRoleManagerService } from '../role-manager/service';

export type SessionCreateInput = {
  projectId: string;
  createdBy: string;
  inheritModel?: {
    provider: string;
    id: string;
  } | null;
};

export async function createTopLevelSession(db: RoleManagerDb, piClient: PiClient, input: SessionCreateInput) {
  const roleManager = createRoleManagerService(db, piClient);
  return roleManager.createTopLevelBlankSession(input);
}
