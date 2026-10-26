export type PaneLayout = "main" | "balanced" | "draft";

const options = [
  { value: "main", label: "Main flow only" },
  { value: "balanced", label: "Balanced view" },
  { value: "draft", label: "Draft only" },
] as const;

export function PaneLayoutControl({
  value,
  onChange,
}: {
  value: PaneLayout;
  onChange: (value: PaneLayout) => void;
}) {
  return (
    <div className="pane-layout-control" role="group" aria-label="Canvas layout">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.label}
          aria-label={option.label}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          <svg width="20" height="16" viewBox="0 0 20 16" aria-hidden="true">
            <rect x="1" y="1" width="18" height="14" rx="2" fill="none" stroke="currentColor" />
            <path d="M10 1v14" stroke="currentColor" />
            {option.value !== "draft" && <rect x="3" y="3" width="5" height="10" rx="1" fill="currentColor" />}
            {option.value !== "main" && <rect x="12" y="3" width="5" height="10" rx="1" fill="currentColor" />}
          </svg>
        </button>
      ))}
    </div>
  );
}
