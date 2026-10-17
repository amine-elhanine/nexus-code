import React from "react";

/**
 * Provider-scoped model picker for Settings.
 *
 * Models belong to a provider connection (`ProviderConfig.models` /
 * `EmbeddingProviderConfig.models`), so the list must come from the *selected*
 * provider — never from the static provider catalogue, whose `models` arrays
 * are only seed values, and never from another provider, since the same model
 * name can be served by several of them under different wire protocols.
 *
 * A saved model the provider no longer lists is still rendered (marked as
 * unavailable) rather than dropped: a `<select>` whose value matches no option
 * displays as blank, which reads as "nothing is configured" and would let the
 * next save silently erase a working setting.
 */
export function ProviderModelSelect({
  value,
  models,
  onChange,
  disabled,
  emptyOption,
  emptyHint,
  staleLabel = " — not in this provider's list",
}: {
  value: string;
  models: string[];
  onChange: (model: string) => void;
  disabled?: boolean;
  /** Label for the "let the provider decide" choice. Omit when a model is required. */
  emptyOption?: string;
  /** Shown as the blank choice when the provider offers no models. */
  emptyHint?: string;
  /** Appended to a configured model the provider does not list. */
  staleLabel?: string;
}) {
  const options = models.filter(Boolean);
  const unavailable = Boolean(value) && !options.includes(value);
  return (
    <select
      className="select-field"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{emptyOption ?? emptyHint ?? "Select a model…"}</option>
      {options.map((model) => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
      {unavailable && <option value={value}>{`${value}${staleLabel}`}</option>}
    </select>
  );
}