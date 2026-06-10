import { sql } from 'drizzle-orm';
import type { RoleManagerDb } from '../role-manager/service';

export type AuditAction =
  | 'project.created'
  | 'session.created'
  | 'session.archived'
  | 'session.stopped'
  | 'message.sent'
  | 'title.changed';

function id() {
  return `audit_${crypto.randomUUID().slice(0, 12)}`;
}

export type AuditService = {
  record(
    userId: string,
    action: AuditAction,
    targetType: string,
    targetId: string,
    payload?: Record<string, unknown>,
  ): Promise<string>;
};

export function createAuditService(db: RoleManagerDb): AuditService {
  return {
    async record(userId, action, targetType, targetId, payload = {}) {
      const auditId = id();
      const timestamp = Date.now();
      const payloadJson = JSON.stringify(payload);

      await db.run(sql`
        INSERT INTO audit_events (id, user_id, action, target_type, target_id, payload, created_at)
        VALUES (${auditId}, ${userId}, ${action}, ${targetType}, ${targetId}, ${payloadJson}, ${timestamp})
      `);

      return auditId;
    },
  };
}
