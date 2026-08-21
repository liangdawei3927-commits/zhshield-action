/**
 * OrderService manages the lifecycle of customer orders from
 * creation through fulfilment and returns. It coordinates the
 * checkout process end to end, validates payment details with
 * the payment gateway, reserves stock for each line item and
 * emits domain events for downstream consumers. The service is
 * intentionally framework-free so it can be unit tested with
 * plain object fakes instead of heavy mocking frameworks. All
 * repository access goes through narrow ports which are injected
 * into the constructor, keeping the core logic free of storage
 * concerns. This header exists purely to exercise the duplicate
 * detection filter that must skip comment-only blocks when it
 * scans for duplicated code inside this repository. The filter
 * must also tolerate identical copyright headers across files.
 */

export class OrderService {
  createOrder(): string {
    return 'order-created';
  }
}
