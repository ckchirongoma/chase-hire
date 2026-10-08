"use client";

/** Submit button that asks for confirmation: a submitted live scorecard is final. */
export default function LiveSubmitButton({ label = "Submit (final)", message }: { label?: string; message: string }) {
  return (
    <button
      type="submit"
      name="intent"
      value="submit"
      className="btn"
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {label}
    </button>
  );
}
