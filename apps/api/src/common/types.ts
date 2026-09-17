import type { MemberRole } from '@bizbot/database';
import type { Permission } from '@bizbot/rbac';

export interface RequestActor {
  type: 'USER' | 'CUSTOMER';
  userId?: string;
  customerId?: string;
  platformRole?: 'NONE' | 'SUPPORT' | 'ADMIN';
  email?: string;
}

export interface RequestTenant {
  id: string;
  slug: string;
  role?: MemberRole;
  permissions: ReadonlySet<Permission>;
  enabledModules: ReadonlySet<string>;
  timezone: string;
  currency: string;
  defaultLanguage: string;
}

declare module 'express' {
  interface Request {
    requestId: string;
    actor?: RequestActor;
    tenant?: RequestTenant;
    language?: 'uz' | 'ru' | 'en';
    rawBody?: Buffer;
  }
}
