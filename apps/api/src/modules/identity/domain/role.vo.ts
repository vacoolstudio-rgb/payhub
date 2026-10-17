/**
 * RBAC with an explicit permission matrix.
 *
 * Roles are what the business talks about; permissions are what the code
 * checks. Keeping the mapping in one place means "can a support agent refund
 * a payment?" is answered by reading this table, not by grepping for
 * `@Roles('support')` across forty controllers.
 */
export const Role = {
  User: 'user',
  MerchantOwner: 'merchant_owner',
  Support: 'support',
  Admin: 'admin',
  /** Machine principal authenticated by an API key. */
  Service: 'service',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export const Permission = {
  WalletRead: 'wallet:read',
  WalletReadAny: 'wallet:read:any',
  PaymentCreate: 'payment:create',
  PaymentRead: 'payment:read',
  PaymentReadAny: 'payment:read:any',
  PaymentRefund: 'payment:refund',
  PaymentCancel: 'payment:cancel',
  MerchantManage: 'merchant:manage',
  MerchantReadAny: 'merchant:read:any',
  ApiKeyManage: 'api-key:manage',
  WalletFreeze: 'wallet:freeze',
  AssistantUse: 'assistant:use',
  AdminAll: 'admin:*',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

const MATRIX: Record<Role, readonly Permission[]> = {
  [Role.User]: [
    Permission.WalletRead,
    Permission.PaymentCreate,
    Permission.PaymentRead,
    Permission.PaymentCancel,
    Permission.AssistantUse,
  ],
  [Role.MerchantOwner]: [
    Permission.WalletRead,
    Permission.PaymentCreate,
    Permission.PaymentRead,
    Permission.PaymentRefund,
    Permission.PaymentCancel,
    Permission.MerchantManage,
    Permission.ApiKeyManage,
    Permission.AssistantUse,
  ],
  [Role.Support]: [
    Permission.WalletReadAny,
    Permission.PaymentReadAny,
    Permission.MerchantReadAny,
  ],
  [Role.Admin]: [Permission.AdminAll],
  [Role.Service]: [Permission.PaymentCreate, Permission.PaymentRead, Permission.PaymentRefund],
};

export function permissionsFor(roles: readonly Role[]): Permission[] {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of MATRIX[role] ?? []) {
      granted.add(permission);
    }
  }
  return [...granted];
}

export function hasPermission(granted: readonly string[], required: string): boolean {
  return granted.includes(Permission.AdminAll) || granted.includes(required);
}

export function isRole(value: string): value is Role {
  return Object.values(Role).includes(value as Role);
}
