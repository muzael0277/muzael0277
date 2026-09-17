# Domain Events

Events are the reason automations, webhooks, notifications, the CRM timeline and AI
context can be added later without touching business logic. They are introduced in MVP
precisely because retrofitting them is expensive.

## 1. Transactional outbox

A business change and its event are written in **one** transaction:

```ts
await this.prisma.$transaction(async (tx) => {
  const order = await tx.order.create({ ... });
  await this.events.emit(tx, 'order.created', { orderId: order.id, total: order.total });
  return order;
});
```

No event is ever lost because a broker was down, and no event ever announces a change
that got rolled back. `DomainEvent` rows are then drained by a dispatcher
(`status: PENDING → PROCESSING → PROCESSED | FAILED`, with `attempts` and `availableAt`
for backoff) and fanned out to in-process handlers and BullMQ jobs.

## 2. Catalogue

```
customer.created            order.created           booking.created
customer.updated            order.status_changed    booking.rescheduled
customer.inactive           order.completed         booking.cancelled
                            order.cancelled         booking.reminder_due
payment.succeeded           loyalty.earned          inventory.low
payment.failed              loyalty.spent           promo.used
payment.refunded            message.received        member.invited
```

Payloads are versioned (`version: 1`) and contain **ids plus the few fields a consumer
needs**, never whole entities — an entity shape change must not break a consumer.

## 3. Consumers

| Consumer                      | Reacts to                     | Does                                        |
| ----------------------------- | ----------------------------- | ------------------------------------------- |
| `TimelineProjector`           | most                          | appends `CustomerTimelineEntry`             |
| `NotificationDispatcher`      | order/booking/payment/loyalty | renders a template, queues a Telegram send  |
| `LoyaltyAccrual`              | `order.completed`             | credits cashback (ledger + balance, one tx) |
| `AnalyticsRollup`             | order/booking/payment         | updates daily aggregates                    |
| `WebhookDispatcher` (Phase 3) | subscribed events             | signed POST + retries                       |
| `AutomationEngine` (Phase 4)  | all                           | matches triggers → conditions → actions     |

Handlers must be **idempotent** — they key on `(eventId, handlerName)` in
`EventHandlerRun`, because at-least-once delivery is the only honest guarantee.

## 4. Ordering

Events for one aggregate are processed in order via a BullMQ FIFO group keyed by
`aggregateId`. Cross-aggregate ordering is not guaranteed and no consumer may assume it.
