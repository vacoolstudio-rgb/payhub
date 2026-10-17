import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

export interface TracingOptions {
  readonly enabled: boolean;
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly endpoint: string;
  readonly environment: string;
}

/**
 * Starts OpenTelemetry **before** anything else is imported.
 *
 * Auto-instrumentation works by monkey-patching module exports (`pg`,
 * `ioredis`, `http`, `kafkajs`). If the application has already imported and
 * captured a reference to those functions, the patch arrives too late and the
 * spans never appear — which is why each service calls this from a tiny
 * `instrumentation.ts` loaded first, not from `AppModule`.
 */
export async function startTracing(options: TracingOptions): Promise<void> {
  if (!options.enabled || sdk) {
    return;
  }

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion,
      'deployment.environment.name': options.environment,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${options.endpoint}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Health and metrics scrapes would swamp the trace backend.
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (request) =>
            request.url?.startsWith('/health') === true ||
            request.url?.startsWith('/metrics') === true,
        },
        // Noisy, low-signal, and expensive on a busy event loop.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
    ],
  });

  sdk.start();
}

export async function stopTracing(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}
