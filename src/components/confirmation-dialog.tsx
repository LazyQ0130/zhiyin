"use client";
import { useEffect, useRef, type ReactNode } from "react";

export function ConfirmationDialog({ titleId, descriptionId, children, onClose }: { titleId: string; descriptionId?: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]'));
      const first = focusable[0]; const last = focusable.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);
  return <div className="dialog-backdrop" role="presentation" onClick={onClose}><section ref={dialog} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onClick={(event) => event.stopPropagation()}>{children}</section></div>;
}
