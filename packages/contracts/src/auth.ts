import { z } from 'zod';
import { emailSchema, passwordSchema, phoneSchema, languageSchema, idSchema } from './primitives';

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  firstName: z.string().trim().min(1).max(64),
  lastName: z.string().trim().max(64).optional(),
  phone: phoneSchema.optional(),
  language: languageSchema.default('uz'),
});
export type RegisterInput = z.input<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(16).optional() });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export const updateProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(64).optional(),
  lastName: z.string().trim().max(64).optional(),
  phone: phoneSchema.optional(),
  language: languageSchema.optional(),
  avatarUrl: z.string().url().max(2048).nullable().optional(),
});

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(['ADMIN', 'MANAGER', 'OPERATOR', 'EMPLOYEE', 'ACCOUNTANT', 'COURIER']),
  employeeId: idSchema.optional(),
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'MANAGER', 'OPERATOR', 'EMPLOYEE', 'ACCOUNTANT', 'COURIER']),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(16),
  password: passwordSchema.optional(),
  firstName: z.string().trim().min(1).max(64).optional(),
});

/** Mini App session bootstrap — the raw initData string is verified server-side. */
export const telegramAuthSchema = z
  .object({
    initData: z.string().min(1).max(8192),
    tenantSlug: z.string().min(1).max(64).optional(),
    tenantId: idSchema.optional(),
  })
  .refine((v) => v.tenantSlug || v.tenantId, {
    message: 'tenantSlug or tenantId is required',
  });
