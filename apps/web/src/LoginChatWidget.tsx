import React, { useEffect, useRef, useState } from "react";

export function LoginChatWidget() {
  const [open, setOpen] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  function close() {
    setOpen(false);
    launcher.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open]);
  return (
    <aside className="login-chat-widget" aria-label="AI support">
      {open && (
        <section
          id="login-ai-chat"
          className="login-chat-panel"
          role="dialog"
          aria-modal="false"
          aria-label="AI assistant"
        >
          <header>
            <strong>AI assistant</strong>
            <button
              ref={closeButton}
              type="button"
              onClick={close}
              aria-label="Close AI assistant"
            >
              ✕
            </button>
          </header>
          <iframe
            src="https://agentconnex.b-connect.site/chat/11a48734-ad2a-4938-bb87-0aa8da9ca5fb"
            title="AI assistant"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        </section>
      )}
      <button
        ref={launcher}
        className="login-chat-launcher"
        type="button"
        aria-expanded={open}
        aria-controls={open ? "login-ai-chat" : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {open ? "Close chat" : "Chat with AI"}
      </button>
    </aside>
  );
}
