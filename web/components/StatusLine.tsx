import type { Status } from "../format";

export function StatusLine({ status, onRetry }: { status: Status; onRetry?: () => void }) {
  return (
    <div className={`status${status.tone === "warn" ? " warn" : ""}`} role="status">
      {status.busy && <i className="dot" aria-hidden="true" />}
      <span>{status.text}</span>
      {onRetry && (
        <button type="button" className="link" onClick={onRetry}>
          다시 시도
        </button>
      )}
    </div>
  );
}
