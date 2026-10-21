import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
}

/**
 * The last thing between a render error and a blank page.
 *
 * React unmounts the entire tree when a render throws and nothing catches
 * it. On a dashboard showing balances that means the screen goes white
 * with no message, no correlation id and nothing in the console the user
 * can report — the worst possible failure mode for the one screen where
 * somebody is looking for their money.
 *
 * Still a class component: `componentDidCatch` has no hook equivalent,
 * and that is a deliberate gap in React rather than an oversight here.
 *
 * Deliberately not a retry button that re-renders the same subtree — if
 * the error is in the data, that just throws again. Reloading starts from
 * a clean state, which is the honest option.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept to the console rather than shipped anywhere: this project has
    // no browser error collector, and pretending otherwise would be worse
    // than saying so.
    console.error('Render failed', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;

    if (!error) {
      return this.props.children;
    }

    return (
      <main className="error-boundary" role="alert">
        <h1>Something broke on this screen</h1>
        <p>
          Your balances and payments are unaffected — this is a display
          failure, not a change to your money.
        </p>
        <pre>{error.message}</pre>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}
