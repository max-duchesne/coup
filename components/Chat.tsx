"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { supabase } from "@/lib/supabase";
import { fetchMessages, sendMessage, type ChatMessage } from "@/lib/chat";
import { FONT_DISPLAY, M } from "@/lib/design";

type Props = {
  gameCode: string;
  playerId: string;
  playerName: string;
  onNewMessage?: (msg: ChatMessage) => void;
};

export default function Chat({ gameCode, playerId, playerName, onNewMessage }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onNewMessageRef = useRef(onNewMessage);
  useEffect(() => { onNewMessageRef.current = onNewMessage; }, [onNewMessage]);
  const playerIdRef = useRef(playerId);
  useEffect(() => { playerIdRef.current = playerId; }, [playerId]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Load history and subscribe to new messages.
  useEffect(() => {
    if (!gameCode) return;

    void fetchMessages(gameCode).then((msgs) => {
      setMessages(msgs);
      setTimeout(scrollToBottom, 50);
    });

    const channel = supabase
      .channel(`chat:${gameCode}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_messages",
          filter: `game_code=eq.${gameCode}`,
        },
        (payload) => {
          const row = payload.new as {
            id: number;
            game_code: string;
            player_id: string;
            player_name: string;
            message: string;
            created_at: string;
          };
          const msg: ChatMessage = {
            id: row.id,
            gameCode: row.game_code,
            playerId: row.player_id,
            playerName: row.player_name,
            message: row.message,
            createdAt: row.created_at,
          };
          setMessages((prev) => [...prev, msg]);
          setTimeout(scrollToBottom, 50);
          if (row.player_id !== playerIdRef.current) {
            onNewMessageRef.current?.(msg);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [gameCode, scrollToBottom]);

  const handleSend = async () => {
    const trimmed = draft.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setDraft("");
    try {
      await sendMessage(gameCode, playerId, playerName, trimmed);
    } catch {
      // Re-populate draft on failure.
      setDraft(trimmed);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: M.surface,
        border: `1px solid ${M.border}`,
        borderRadius: 18,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "16px 20px",
          borderBottom: `1px solid ${M.border}`,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 13,
            letterSpacing: "0.28em",
            color: M.muted,
            textTransform: "uppercase",
          }}
        >
          Chat
        </span>
      </div>

      {/* Message list */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "14px 18px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {messages.length === 0 ? (
          <p
            style={{
              color: M.muted,
              fontSize: 16,
              textAlign: "center",
              margin: "auto",
              letterSpacing: "0.02em",
            }}
          >
            No messages yet.
          </p>
        ) : (
          messages.map((msg) => {
            const isMe = msg.playerId === playerId;
            return (
              <div
                key={msg.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: isMe ? "flex-end" : "flex-start",
                  gap: 3,
                }}
              >
                {!isMe && (
                  <span
                    style={{
                      fontFamily: FONT_DISPLAY,
                      fontSize: 11,
                      letterSpacing: "0.22em",
                      color: M.muted,
                      textTransform: "uppercase",
                    }}
                  >
                    {msg.playerName}
                  </span>
                )}
                <div
                  style={{
                    maxWidth: "85%",
                    padding: "9px 14px",
                    borderRadius: isMe ? "14px 14px 5px 14px" : "14px 14px 14px 5px",
                    background: isMe ? M.goldDim : M.surface2,
                    border: `1px solid ${isMe ? "rgba(201,162,83,0.25)" : M.border}`,
                    fontSize: 17,
                    color: isMe ? "#e8d5a3" : M.text,
                    lineHeight: 1.45,
                    wordBreak: "break-word",
                  }}
                >
                  {msg.message}
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div
        style={{
          padding: "12px 14px",
          borderTop: `1px solid ${M.border}`,
          display: "flex",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message…"
          maxLength={500}
          className="coup-input"
          style={{
            flex: 1,
            minWidth: 0,
            background: M.surface2,
            border: `1px solid ${M.border}`,
            borderRadius: 999,
            padding: "10px 16px",
            color: M.text,
            fontSize: 17,
            outline: "none",
          }}
        />
        <button
          onClick={() => void handleSend()}
          disabled={!draft.trim() || sending}
          className="coup-btn"
          style={{
            flexShrink: 0,
            padding: "10px 18px",
            borderRadius: 999,
            border: `1px solid ${draft.trim() ? "rgba(201,162,83,0.35)" : M.border}`,
            background: "transparent",
            color: draft.trim() ? M.gold : M.muted,
            fontSize: 16,
            opacity: !draft.trim() || sending ? 0.4 : 1,
            whiteSpace: "nowrap",
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
