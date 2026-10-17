import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useAssistantStream } from './useAssistantStream';

const SUGGESTIONS = [
  'What is my current balance?',
  'How much did I pay in fees this month?',
  'Did any of my payments fail, and why?',
];

export function AssistantPanel(): React.JSX.Element {
  const { token } = useAuth();
  const { answer, streaming, error, ask, cancel } = useAssistantStream(token);
  const [question, setQuestion] = useState('');

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    if (question.trim()) {
      void ask(question.trim());
    }
  }

  return (
    <section className="card">
      <header className="card-head">
        <h2>Assistant</h2>
        <span className="pill">SSE stream</span>
      </header>

      <form className="assistant-form" onSubmit={onSubmit}>
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask about your transactions…"
          maxLength={500}
        />
        <button className="primary" type="submit" disabled={streaming}>
          Ask
        </button>
        {streaming && (
          <button type="button" className="ghost" onClick={cancel}>
            Stop
          </button>
        )}
      </form>

      <div className="suggestions">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="chip"
            onClick={() => {
              setQuestion(suggestion);
              void ask(suggestion);
            }}
          >
            {suggestion}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      {(answer || streaming) && (
        <p className="assistant-answer">
          {answer}
          {/* A caret while streaming: the first token can take a moment, and
              silence reads as a broken page. */}
          {streaming && <span className="caret" aria-hidden="true" />}
        </p>
      )}
    </section>
  );
}
