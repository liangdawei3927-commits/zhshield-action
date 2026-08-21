/**
 * OrderService facade.
 * Coordinates checkout.
 * Emits domain events.
 */

export class OrderService {
  createOrder(): string {
    return 'order-created';
  }
}
