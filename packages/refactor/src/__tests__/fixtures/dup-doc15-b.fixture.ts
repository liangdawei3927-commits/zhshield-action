/**
 * PaymentService validates and processes customer payments using
 * the configured gateway adapters. It encrypts card details at
 * rest, retries failed authorisations with exponential backoff,
 * and reconciles captured funds against the order ledger every
 * night. The gateway adapter protocol is defined in this module
 * and implemented by the Stripe, Adyen and PayPal connectors,
 * each of which is loaded through a factory keyed by merchant
 * configuration. This header exists purely to exercise the same
 * duplicate detection filter that must skip comment-only blocks
 * when it scans for duplicated code inside this repository. The
 * filter must also tolerate identical copyright headers across
 * unrelated source files without raising false positives, and
 * must not report empty normalized blocks as real duplication.
 */

export class PaymentService {
  charge(): string {
    return 'payment-charged';
  }
}
