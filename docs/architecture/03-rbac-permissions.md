# Roles, Permissions & Entitlements

Three orthogonal questions, three mechanisms. Conflating them is how permission systems rot.

| Question                                    | Mechanism                             | Failure                |
| ------------------------------------------- | ------------------------------------- | ---------------------- |
| _Is this person allowed to do this?_        | RBAC — role → permissions             | `403 FORBIDDEN`        |
| _Has this business turned this feature on?_ | Modules — `TenantModule`              | `403 MODULE_DISABLED`  |
| _Does their plan include it?_               | Entitlements — `Plan` → `PlanFeature` | `402 UPGRADE_REQUIRED` |

## 1. Permissions

Permissions are `resource:action` strings defined once in `packages/rbac`, shared by the
API (enforcement) and the admin app (navigation and control visibility). The frontend
uses them to avoid showing dead buttons; the backend uses them to actually decide.

```
customer:read   customer:write   customer:delete   customer:export
product:read    product:write    product:delete
service:read    service:write    service:delete
order:read      order:write      order:status      order:cancel   order:refund
booking:read    booking:write    booking:cancel    booking:reassign
employee:read   employee:write   branch:read       branch:write
inventory:read  inventory:write
loyalty:read    loyalty:adjust   promo:read        promo:write
message:read    message:write    message:assign
analytics:read  analytics:financial
settings:read   settings:write   integration:read  integration:write
member:read     member:invite    member:role       audit:read
```

`integration:write` and `analytics:financial` are separated on purpose: a manager may run
the shop without being able to touch payment credentials or see margin.

## 2. Role matrix

| Permission group        | OWNER | ADMIN         | MANAGER       | OPERATOR                 | EMPLOYEE    | ACCOUNTANT       | COURIER           |
| ----------------------- | ----- | ------------- | ------------- | ------------------------ | ----------- | ---------------- | ----------------- |
| customers               | full  | full          | r/w           | r/w                      | —           | read             | —                 |
| catalog / services      | full  | full          | r/w           | read                     | read        | read             | —                 |
| orders                  | full  | full          | r/w + status  | read + status (assigned) | —           | read             | status (assigned) |
| bookings                | full  | full          | full          | read                     | own only    | —                | —                 |
| employees / branches    | full  | full          | read          | —                        | own profile | —                | —                 |
| inventory               | full  | full          | r/w           | —                        | —           | read             | —                 |
| loyalty                 | full  | full          | read + adjust | read                     | —           | read             | —                 |
| messages                | full  | full          | full          | full                     | —           | —                | —                 |
| analytics               | full  | full          | read          | —                        | —           | read + financial | —                 |
| settings / integrations | full  | settings only | —             | —                        | —           | —                | —                 |
| members / audit         | full  | invite only   | —             | —                        | —           | —                | —                 |

`OWNER` is the only role that can change billing, transfer ownership, delete the tenant or
edit integration secrets. The last `OWNER` of a tenant cannot be demoted or removed —
enforced in `MembershipService`, tested.

`ACCOUNTANT` and `COURIER` ship with the matrix but are not offered in the MVP invite UI.
`CUSTOM_ROLE` is the future path: `TenantMembership.permissionOverrides` (JSON, already in
the schema) is merged over the role's set, so custom roles need no migration.

## 3. Row-level scoping beyond the matrix

Some roles see only _their_ rows. That is not expressible as a permission string, so
services take a `scope` derived from the actor:

- `EMPLOYEE` + `booking:read` → `WHERE resource.employeeId = me`
- `OPERATOR` + `order:read` → `WHERE assignedOperatorId = me OR assignedOperatorId IS NULL`

`ActorScope.applyTo(query, actor)` centralises this so it cannot drift between endpoints.

## 4. Enforcement

```ts
@RequirePermission('order:status')
@RequireModule(Module.ORDERS)
@Patch(':id/status')
updateStatus(...) {}
```

- `PermissionsGuard` — resolves the membership role → permission set (+ overrides) and
  checks the decorator. **Absence of the decorator on a non-`@Public` route is a startup
  error**, not an open door: a bootstrap check enumerates every route and refuses to boot
  if one is unannotated. That turns "someone forgot the guard" from a vulnerability into
  a failed deploy.
- `ModuleGuard` — checks `TenantModule.enabled`.
- `EntitlementService.assert(tenant, 'advanced_analytics')` — called in services, not
  scattered through components. UI reads the same entitlements from
  `GET /v1/tenants/:id/entitlements`.

## 5. Platform (super admin)

`User.platformRole`:

- `SUPPORT` — read-only across tenants, every access written to `AuditLog`.
- `ADMIN` — tenant lifecycle, plans, feature flags, templates.

Platform routes live under `/v1/platform/*`, use `PlatformGuard`, and are the only
non-worker place `prisma.$system()` is allowed.
