import { Injectable } from '@nestjs/common';

/**
 * Whether this instance is on its way out.
 *
 * Readiness answers "can it serve traffic?", and during a rolling
 * update the honest answer turns false some time before the socket
 * closes. Removing a pod from a Service is asynchronous: the endpoint
 * is withdrawn, kube-proxy rules are rewritten on every node, and in
 * the seconds that takes, new connections still arrive at a pod that
 * is already terminating.
 *
 * Measured on this service before the flag existed: `/health/ready`
 * answered 200 at the moment SIGTERM arrived and the socket refused
 * connections 40 ms later, with no failing probe in between. Nothing
 * told the load balancer to stop — so every rolling deploy hands a few
 * real users a connection error.
 *
 * The flag closes that window by failing readiness first and closing
 * the socket only after the orchestrator has had time to notice.
 */
@Injectable()
export class ShutdownState {
  private draining = false;

  /** One way. A draining instance never becomes ready again. */
  beginDraining(): void {
    this.draining = true;
  }

  get isDraining(): boolean {
    return this.draining;
  }
}
