// fixture: long-method test
// contains one long method and one short method

export class OrderService {
  processOrder(): void {
    // step 1: validate input
    const input = 'test';
    console.log(input);

    // step 2: calculate pricing
    const basePrice = 100;
    const tax = basePrice * 0.1;
    const discount = basePrice > 50 ? basePrice * 0.05 : 0;
    const total = basePrice + tax - discount;
    console.log(total);

    // step 3: check inventory
    const stock = 10;
    if (stock <= 0) {
      throw new Error('out of stock');
    }

    // step 4: process payment
    const paid = true;
    if (!paid) {
      throw new Error('payment failed');
    }

    // step 5: generate receipt
    const receiptId = 'RCP-001';
    console.log(receiptId);

    // step 6: send notification
    const notified = true;
    if (!notified) {
      console.log('retry notification');
    }
  }

  shortMethod(): string {
    return 'ok';
  }
}

export function standaloneFunc(a: string, b: string, c: string, d: string, e: string): string {
  return [a, b, c, d, e].join(',');
}
