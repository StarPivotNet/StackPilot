import { z } from "zod";

export const PermissionSchema = z.enum([
  "ssh:read", "ssh:connect", "ssh:manage", "ssh:sessions:terminate",
  "overview:read", "overview:operate", "schedules:read", "schedules:write", "nodes:read", "nodes:manage",
  "services:read", "services:operate",
  "terminal:read", "terminal:execute",
  "systemd:read",
  "sites:read", "sites:logs", "sites:deploy", "sites:operate", "sites:renew",
  "files:read", "files:write", "files:delete", "firewall:read", "firewall:operate", "databases:read", "databases:sql:read", "databases:backup",
  "databases:operate", "databases:install", "databases:restore",
  "tasks:read", "tasks:create", "tasks:cancel", "audit:read", "audit:export", "users:read", "users:manage", "roles:read", "roles:manage", "tokens:manage", "system:backup",
]);
export type Permission = z.infer<typeof PermissionSchema>;
export const NodeScopeSchema = z.union([z.literal("all"), z.array(z.string().uuid()).max(1000)]);
export type NodeScope = z.infer<typeof NodeScopeSchema>;
export const PublicUserSchema = z.object({ id: z.string().uuid(), username: z.string(), displayName: z.string(), permissions: z.array(PermissionSchema), nodeScope: NodeScopeSchema, roles: z.array(z.string()) });
export type PublicUser = z.infer<typeof PublicUserSchema>;
export const LoginRequestSchema = z.object({ username: z.string().trim().min(1).max(128), password: z.string().min(1).max(1024) }).strict();
export const LoginResponseSchema = z.object({ user: PublicUserSchema, csrfToken: z.string().min(32), expiresAt: z.string().datetime() });
export const CurrentUserResponseSchema = z.object({ user: PublicUserSchema, csrfToken: z.string().min(32) });
export const SessionStatusResponseSchema = z.discriminatedUnion("authenticated", [z.object({ authenticated: z.literal(false) }), z.object({ authenticated: z.literal(true), user: PublicUserSchema, csrfToken: z.string().min(32) })]);
export const ReauthenticateRequestSchema = z.object({ password: z.string().min(1).max(1024) }).strict();
export const ReauthenticateResponseSchema = z.object({ proof: z.string().min(32), expiresAt: z.string().datetime() });
export const PasswordChangeRequestSchema = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(12).max(128) }).strict();
export const CreateApiTokenRequestSchema = z.object({ name: z.string().trim().min(1).max(80), permissions: z.array(PermissionSchema).min(1), nodeScope: NodeScopeSchema, expiresAt: z.string().datetime().nullable() }).strict();
export const ApiTokenRecordSchema = z.object({ id: z.string().uuid(), name: z.string(), permissions: z.array(PermissionSchema), nodeScope: NodeScopeSchema, createdAt: z.string().datetime(), expiresAt: z.string().datetime().nullable(), lastUsedAt: z.string().datetime().nullable(), revokedAt: z.string().datetime().nullable() });
export const CreateApiTokenResponseSchema = z.object({ token: z.string().min(32), record: ApiTokenRecordSchema });
export type ApiTokenRecord = z.infer<typeof ApiTokenRecordSchema>;
export type CreateApiTokenRequest = z.infer<typeof CreateApiTokenRequestSchema>;
export const ApiTokenListResponseSchema = z.object({ tokens: z.array(ApiTokenRecordSchema) });
export const RoleRecordSchema = z.object({ id: z.string(), name: z.string(), description: z.string(), builtin: z.boolean(), permissions: z.array(PermissionSchema) });
export const RoleListResponseSchema = z.object({ roles: z.array(RoleRecordSchema) });
export const UpsertRoleRequestSchema = z.object({ id: z.string().trim().min(2).max(80).regex(/^[a-z0-9-]+$/), name: z.string().trim().min(1).max(80), description: z.string().trim().max(240), permissions: z.array(PermissionSchema).min(1) }).strict();
export const UserRecordSchema = z.object({ id: z.string().uuid(), username: z.string(), displayName: z.string(), disabled: z.boolean(), roles: z.array(z.string()), nodeScope: NodeScopeSchema });
export const UserListResponseSchema = z.object({ users: z.array(UserRecordSchema) });
export const CreateUserRequestSchema = z.object({ username: z.string().trim().min(1).max(128).regex(/^[\p{L}\p{N}_.@-]+$/u), displayName: z.string().trim().min(1).max(128), password: z.string().min(12).max(128), roleIds: z.array(z.string()).min(1), nodeScope: NodeScopeSchema }).strict();
export const UpdateUserAccessRequestSchema = z.object({ roleIds: z.array(z.string()).min(1), nodeScope: NodeScopeSchema, disabled: z.boolean() }).strict();
