'use client';

import { LIMITS, REACTIONS, type ChatMessageDto, type Reaction } from '@lsp/shared';
import { Avatar, cx } from '@lsp/ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { errorMessage } from '@/lib/hooks';
import type { FloatingReaction } from '@/lib/live-session';
import { SendIcon, TrashIcon } from '../icons';
import { useToast } from '../toast';

export function ChatPanel({
  messages,
  onSend,
  onDelete,
  canModerate,
  disabled,
  dark,
}: {
  messages: ChatMessageDto[];
  onSend: (text: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  canModerate: boolean;
  disabled?: string | null;
  dark?: boolean;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const toast = useToast();

  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    try {
      await onSend(text);
      setText('');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSending(false);
    }
  }

  return (
    <section aria-label="Chat" className="flex h-full min-h-0 flex-col">
      <ol ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3" aria-live="polite">
        {messages.length === 0 && (
          <li className={cx('py-8 text-center text-sm', dark ? 'text-slate-500' : 'text-slate-400')}>No messages yet. Say hello 👋</li>
        )}
        {messages.map((m) => (
          <li key={m.id} className="group flex gap-2.5">
            <Avatar name={m.displayName} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-2 text-xs">
                <span className={cx('font-semibold', dark ? 'text-slate-200' : 'text-slate-900')}>{m.displayName}</span>
                {m.role !== 'VIEWER' && (
                  <span className="rounded bg-brand-600/20 px-1 text-[10px] font-semibold uppercase text-brand-400">host</span>
                )}
                <time className="text-slate-500" dateTime={m.createdAt}>
                  {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </time>
              </p>
              <p className={cx('break-words text-sm', m.deleted ? 'italic text-slate-500' : dark ? 'text-slate-300' : 'text-slate-700')}>
                {m.deleted ? 'Message removed by a moderator' : m.text}
              </p>
            </div>
            {canModerate && !m.deleted && onDelete && (
              <button
                aria-label="Delete message"
                className="invisible self-start rounded p-1 text-slate-500 hover:text-red-500 group-hover:visible focus:visible"
                onClick={() => onDelete(m.id).catch((err: unknown) => toast(errorMessage(err), 'error'))}
              >
                <TrashIcon size={14} />
              </button>
            )}
          </li>
        ))}
      </ol>
      <form onSubmit={submit} className={cx('flex items-center gap-2 border-t p-3', dark ? 'border-white/10' : 'border-slate-200')}>
        <label htmlFor="chat-input" className="sr-only">
          Message
        </label>
        <input
          id="chat-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={LIMITS.chatMaxLength}
          disabled={!!disabled || sending}
          placeholder={disabled ?? 'Send a message'}
          className={cx(
            'h-10 min-w-0 flex-1 rounded-full px-4 text-sm outline-none ring-1 focus:ring-2 focus:ring-brand-500',
            dark ? 'bg-studio-800 text-slate-100 ring-white/10 placeholder:text-slate-500' : 'bg-slate-100 ring-transparent',
          )}
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!!disabled || sending || !text.trim()}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40"
        >
          <SendIcon size={16} />
        </button>
      </form>
    </section>
  );
}

export function ReactionBar({ onReact, disabled }: { onReact: (r: Reaction) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-1 rounded-full bg-black/40 p-1 backdrop-blur" role="group" aria-label="Reactions">
      {REACTIONS.slice(0, 6).map((r) => (
        <button
          key={r}
          type="button"
          disabled={disabled}
          onClick={() => onReact(r)}
          className="h-9 w-9 rounded-full text-lg transition hover:scale-125 hover:bg-white/10 disabled:opacity-40"
          aria-label={`React ${r}`}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

export function ReactionOverlay({ items }: { items: FloatingReaction[] }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-72 overflow-hidden" aria-hidden="true">
      {items.map((r) => (
        <span key={r.id} className="absolute bottom-4 animate-float-up text-3xl" style={{ left: `${r.left}%` }}>
          {r.emoji}
        </span>
      ))}
    </div>
  );
}
