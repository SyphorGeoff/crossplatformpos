/*
 * Inbox state (messaging arc F1): the iOS MessagingManager poll, ported.
 *  - polls `Messages` every 5 s while an employee is signed in (startMessageTimer,
 *    MessagingManager.m:590-601); stops on the keypad
 *  - the fetched list REPLACES the local list each poll (:117); unread = its length
 *    ("unread" is server-side: a read message simply stops arriving)
 *  - a message never seen on this device with LocalNotified=0 fires `onNew` once
 *    (the iOS local notification, :120-159) and is then flagged LocalNotified
 *  - markRead posts Mark_Messages_Read and drops the message locally at once
 *    (iOS waits for the next poll; dropping now just avoids a 5 s ghost)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMessages, markRead as postMarkRead, setLocalNotified, type InboxMessage } from "@/protocol/messaging";
import type { SessionConfig } from "@/protocol/order";

const POLL_MS = 5_000;

export interface MessagesApi {
  messages: InboxMessage[];
  unread: number;
  loading: boolean;
  error: string;
  pollCount: number;   // completed polls since sign-in (the sign-in auto-open waits for the first)
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

export function useMessages(
  cfg: () => SessionConfig,
  empPosId: string | null,
  onNew?: (m: InboxMessage) => void,
): MessagesApi {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pollCount, setPollCount] = useState(0);
  const seen = useRef<Set<string>>(new Set());
  const inFlight = useRef(false);
  const cfgRef = useRef(cfg); cfgRef.current = cfg;
  const onNewRef = useRef(onNew); onNewRef.current = onNew;

  const refresh = useCallback(async () => {
    if (!empPosId || inFlight.current) return;
    inFlight.current = true; setLoading(true);
    try {
      const list = await fetchMessages(cfgRef.current(), empPosId);
      setMessages(list); setError("");
      for (const m of list) {
        if (seen.current.has(m.id)) continue;
        seen.current.add(m.id);
        if (!m.localNotified) {
          onNewRef.current?.(m);
          void setLocalNotified(cfgRef.current(), empPosId, m.id);
        }
      }
    } catch (e) { setError(String((e as Error).message ?? e)); }
    finally { inFlight.current = false; setLoading(false); setPollCount((n) => n + 1); }
  }, [empPosId]);

  useEffect(() => {
    if (!empPosId) { setMessages([]); seen.current.clear(); setPollCount(0); return; }
    void refresh();
    const t = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => window.clearInterval(t);
  }, [empPosId, refresh]);

  const markRead = useCallback(async (id: string) => {
    setMessages((ms) => ms.filter((m) => m.id !== id));
    await postMarkRead(cfgRef.current(), id);
  }, []);

  const markAllRead = useCallback(async () => {
    const ids = messages.map((m) => m.id);
    setMessages([]);
    for (const id of ids) await postMarkRead(cfgRef.current(), id); // one ID per request (iOS shape)
  }, [messages]);

  return { messages, unread: messages.length, loading, error, pollCount, refresh, markRead, markAllRead };
}
