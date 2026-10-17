import { DependencyFailureError } from '@payhub/kernel';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  readonly name: string;
  /** How many recent calls the failure rate is measured over. */
  readonly windowSize?: number;
  /** Trip above this fraction of failures, e.g. 0.5 for half. */
  readonly failureRateThreshold?: number;
  /** Never trip on fewer calls than this — one failure is not a trend. */
  readonly minimumCalls?: number;
  /** How long the circuit stays open before a probe is allowed through. */
  readonly resetTimeoutMs: number;
  /** Successful probes required to close the circuit again. */
  readonly successThreshold?: number;
  readonly now?: () => number;
}

export interface CircuitBreakerSnapshot {
  readonly state: CircuitState;
  readonly failureRate: number;
  readonly samples: number;
}

/**
 * Circuit breaker over a **count-based sliding window**.
 *
 * The naive version counts consecutive failures, and that version never
 * opens for the failure mode that matters most: a dependency answering
 * half its calls with a 503. Every failure is followed by a success, the
 * counter resets, and the breaker sits closed while half the traffic
 * fails. Measuring the rate over the last `windowSize` calls — the
 * resilience4j/Hystrix design — catches exactly that.
 *
 * `minimumCalls` is what stops a single early failure from tripping a
 * freshly started pod: a rate of 1/1 is 100 % and means nothing.
 *
 * Half-open admits **one** call at a time. Letting a burst through on the
 * transition is how a recovering dependency gets knocked straight back
 * over — the probe exists to ask a question, not to resume traffic.
 */
export class CircuitBreaker {
  private readonly windowSize: number;
  private readonly failureRateThreshold: number;
  private readonly minimumCalls: number;
  private readonly successThreshold: number;
  private readonly now: () => number;

  /** Ring buffer of recent outcomes: `true` = failure. */
  private readonly window: boolean[];
  private cursor = 0;
  private samples = 0;
  private failures = 0;

  private state: CircuitState = 'closed';
  private openedAt = 0;
  private probeInFlight = false;
  private consecutiveProbeSuccesses = 0;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.windowSize = options.windowSize ?? 20;
    this.failureRateThreshold = options.failureRateThreshold ?? 0.5;
    this.minimumCalls = options.minimumCalls ?? 10;
    this.successThreshold = options.successThreshold ?? 2;
    this.now = options.now ?? Date.now;
    this.window = Array.from({ length: this.windowSize }, () => false);
  }

  get currentState(): CircuitState {
    return this.state;
  }

  snapshot(): CircuitBreakerSnapshot {
    return {
      state: this.state,
      failureRate: this.samples === 0 ? 0 : this.failures / this.samples,
      samples: this.samples,
    };
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const admitted = this.tryAdmit();

    if (!admitted) {
      throw new DependencyFailureError(
        this.options.name,
        `Circuit for ${this.options.name} is open`,
        { retryable: true },
      );
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private tryAdmit(): boolean {
    if (this.state === 'closed') {
      return true;
    }

    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.options.resetTimeoutMs) {
        return false;
      }
      this.state = 'half-open';
      this.consecutiveProbeSuccesses = 0;
      this.probeInFlight = true;
      return true;
    }

    // half-open: exactly one probe at a time.
    if (this.probeInFlight) {
      return false;
    }
    this.probeInFlight = true;
    return true;
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.probeInFlight = false;
      this.consecutiveProbeSuccesses += 1;

      if (this.consecutiveProbeSuccesses >= this.successThreshold) {
        this.close();
      }
      return;
    }

    this.record(false);
  }

  private onFailure(): void {
    if (this.state === 'half-open') {
      // The dependency is still unwell; back to open and start the clock.
      this.probeInFlight = false;
      this.trip();
      return;
    }

    this.record(true);

    if (this.samples >= this.minimumCalls && this.failures / this.samples >= this.failureRateThreshold) {
      this.trip();
    }
  }

  private record(failed: boolean): void {
    if (this.samples === this.windowSize) {
      // Evict the oldest outcome before overwriting its slot.
      if (this.window[this.cursor]) {
        this.failures -= 1;
      }
    } else {
      this.samples += 1;
    }

    this.window[this.cursor] = failed;
    if (failed) {
      this.failures += 1;
    }

    this.cursor = (this.cursor + 1) % this.windowSize;
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = this.now();
    this.consecutiveProbeSuccesses = 0;
  }

  private close(): void {
    this.state = 'closed';
    this.probeInFlight = false;
    this.consecutiveProbeSuccesses = 0;
    this.cursor = 0;
    this.samples = 0;
    this.failures = 0;
    this.window.fill(false);
  }
}
