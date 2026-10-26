import { useEffect, useRef, useState } from "react";
import { Trash2, X } from "lucide-react";
import type { Draft } from "../shared/model.js";
import { ApiError, operationId } from "./api.js";

export function DeleteDraftDialog({
  draft,
  close,
  confirm,
}: {
  draft: Draft;
  close: () => void;
  confirm: (requestId: string) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const requestId = useRef(operationId());
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelButton.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
      else
        document
          .querySelector<HTMLElement>('.draft-tabs [aria-selected="true"]')
          ?.focus();
    };
  }, []);
  return (
    <div
      className="draft-delete-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) close();
      }}
    >
      <form
        className="modal draft-delete-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-draft-title"
        aria-describedby="delete-draft-description"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            if (!saving) close();
          }
          if (event.key === "Tab") {
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            );
            const first = buttons[0];
            const last = buttons.at(-1);
            if (
              !first ||
              (event.shiftKey && document.activeElement === first) ||
              (!event.shiftKey && document.activeElement === last)
            ) {
              event.preventDefault();
              (event.shiftKey ? last : first)?.focus();
            }
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (saving) return;
          setSaving(true);
          setMessage("");
          void confirm(requestId.current)
            .catch((error) => {
              setMessage(
                error instanceof ApiError && error.code === "revision_conflict"
                  ? "This draft changed while the confirmation was open. Cancel and try again to review its latest contents."
                  : error instanceof Error
                    ? error.message
                    : "Could not delete the draft.",
              );
            })
            .finally(() => setSaving(false));
        }}
      >
        <button
          className="modal-close icon-button"
          type="button"
          disabled={saving}
          onClick={close}
          aria-label="Close delete confirmation"
        >
          <X size={17} />
        </button>
        <div className="modal-symbol delete-symbol">
          <Trash2 size={21} />
        </div>
        <h2 id="delete-draft-title">Delete draft?</h2>
        <p id="delete-draft-description">
          Delete <strong>{draft.name}</strong> and its draft contents? Saved
          main versions will be kept.
        </p>
        {message && (
          <p className="form-error" role="alert">
            {message}
          </p>
        )}
        <div className="modal-actions">
          <button
            ref={cancelButton}
            className="button subtle"
            type="button"
            disabled={saving}
            onClick={close}
          >
            Cancel
          </button>
          <button className="button danger" disabled={saving}>
            {saving ? "Deleting…" : "Delete draft"}
          </button>
        </div>
      </form>
    </div>
  );
}
