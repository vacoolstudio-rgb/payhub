import { parsePayload, scanFrames } from './sse';
import { useCallback, useRef, useState } from 'react';

export interface StreamState {
  answer: string;
  streaming: boolean;
  error: string | null;
}

/**
 * Server-Sent Events consumer for the assistant.
 *
 * `fetch` with a `ReadableStream` rather than `EventSource`, for one
 * concrete reason: `EventSource` cannot set an `Authorization` header, so
 * the token would have to go in the query string and end up in every proxy
 * log. Parsing the SSE frames by hand is a dozen lines and keeps the bearer
 * token where it belongs.
 */
export function useAssistantStream(token: string | null) {
  const [state, setState] = useState<StreamState>({ answer: '', streaming: false, error: null });
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState((previous) => ({ ...previous, streaming: false }));
  }, []);

  const ask = useCallback(
    async (question: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState({ answer: '', streaming: true, error: null });

      const base = (import.meta.env['VITE_API_URL'] as string | undefined) ?? '';
      const url = `${base}/api/v1/assistant/stream?question=${encodeURIComponent(question)}`;

      try {
        const response = await fetch(url, {
          headers: {
            accept: 'text/event-stream',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          signal: controller.signal,
          credentials: 'include',
        });

        if (!response.ok || !response.body) {
          const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
          throw new Error(problem?.detail ?? `Stream failed with ${response.status}`);
        }

        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += value;

          const scanned = scanFrames(buffer);
          buffer = scanned.rest;

          for (const { event, data } of scanned.frames) {
            const parsed = parsePayload(data);

            // A truncated or malformed frame costs one token, not the
            // whole answer.
            if (!parsed) {
              continue;
            }

            if (event === 'token' && parsed.text) {
              setState((previous) => ({ ...previous, answer: previous.answer + parsed.text }));
            } else if (event === 'error') {
              setState((previous) => ({
                ...previous,
                streaming: false,
                error: parsed.message ?? 'Assistant failed',
              }));
              return;
            } else if (event === 'done') {
              setState((previous) => ({ ...previous, streaming: false }));
              return;
            }
          }
        }

        setState((previous) => ({ ...previous, streaming: false }));
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          return;
        }
        setState({
          answer: '',
          streaming: false,
          error: error instanceof Error ? error.message : 'Assistant failed',
        });
      }
    },
    [token],
  );

  return { ...state, ask, cancel };
}
