/**
 * The domain event catalogue.
 *
 * Payloads carry ids plus the few fields a consumer actually needs — never whole
 * entities, so an entity shape change cannot break a consumer
 * (docs/architecture/06-domain-events.md).
 */

export const DomainEventType = {
  CUSTOMER_CREATED: 'customer.created',
  CUSTOMER_UPDATED: 'customer.updated',

  ORDER_CREATED: 'order.created',
  ORDER_STATUS_CHANGED: 'order.status_changed',
  ORDER_COMPLETED: 'order.completed',
  ORDER_CANCELLED: 'order.cancelled',

  BOOKING_CREATED: 'booking.created',
  BOOKING_RESCHEDULED: 'booking.rescheduled',
  BOOKING_CANCELLED: 'booking.cancelled',
  BOOKING_COMPLETED: 'booking.completed',

  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_REFUNDED: 'payment.refunded',

  LOYALTY_EARNED: 'loyalty.earned',
  LOYALTY_SPENT: 'loyalty.spent',

  PROMO_USED: 'promo.used',
  INVENTORY_LOW: 'inventory.low',
  MESSAGE_RECEIVED: 'message.received',
  MEMBER_INVITED: 'member.invited',
} as const;

export type DomainEventTypeValue = (typeof DomainEventType)[keyof typeof DomainEventType];

export interface DomainEventPayloads {
  'customer.created': { customerId: string; source: string; telegramUserId?: string };
  'customer.updated': { customerId: string; changed: string[] };
  'order.created': { orderId: string; orderNumber: string; customerId: string; total: number };
  'order.status_changed': { orderId: string; orderNumber: string; customerId: string; from: string; to: string };
  'order.completed': { orderId: string; orderNumber: string; customerId: string; total: number };
  'order.cancelled': { orderId: string; orderNumber: string; customerId: string; reason?: string };
  'booking.created': { bookingId: string; bookingNumber: string; customerId: string; serviceId: string; resourceId: string; startsAt: string };
  'booking.rescheduled': { bookingId: string; customerId: string; from: string; to: string };
  'booking.cancelled': { bookingId: string; customerId: string; startsAt: string; reason?: string };
  'booking.completed': { bookingId: string; customerId: string; price: number };
  'payment.succeeded': { paymentId: string; orderId?: string; bookingId?: string; customerId?: string; amount: number; provider: string };
  'payment.failed': { paymentId: string; orderId?: string; reason?: string };
  'payment.refunded': { paymentId: string; orderId?: string; amount: number };
  'loyalty.earned': { customerId: string; amount: number; balance: number; orderId?: string };
  'loyalty.spent': { customerId: string; amount: number; balance: number; orderId?: string };
  'promo.used': { promoCodeId: string; code: string; customerId: string; orderId: string; discount: number };
  'inventory.low': { productId: string; variantId?: string; stockQuantity: number; threshold: number };
  'message.received': { conversationId: string; customerId: string; messageId: string };
  'member.invited': { inviteId: string; email: string; role: string };
}

export interface EmittedEvent<T extends DomainEventTypeValue = DomainEventTypeValue> {
  id: string;
  tenantId: string;
  type: T;
  version: number;
  aggregateType: string;
  aggregateId: string;
  payload: T extends keyof DomainEventPayloads ? DomainEventPayloads[T] : Record<string, unknown>;
  occurredAt: Date;
}
