"use client";

import { useEffect, useRef, useState } from "react";

/** Only text, only this tab, and only with a server-provided owner identity. */
export function useTextDraft(key: string | null, initial: string, migrateFrom?: string | null) {
  const [draft, setDraft] = useState({
    key, token: {}, value: initial, baseline: initial,
    dirty: false, loaded: false, persisted: false,
  });
  const current = useRef(draft);
  const locations = useRef(new WeakMap<object, string | null>());
  current.current = draft;
  const value = draft.key === key ? draft.value : initial;

  useEffect(() => {
    const previous = current.current;
    if (previous.loaded && previous.key === key) {
      const nextValue = previous.dirty ? previous.value : initial;
      if (previous.baseline !== initial || previous.value !== nextValue) {
        const next = { ...previous, baseline: initial, value: nextValue };
        current.current = next;
        setDraft(next);
      }
      return;
    }
    let restored = initial;
    let persisted = false;
    try {
      if (key !== null) {
        const moving = previous.key !== key && previous.key === migrateFrom;
        const stored = moving ? previous.value : sessionStorage.getItem(key);
        restored = stored ?? initial;
        if (moving) {
          if (restored !== initial) sessionStorage.setItem(key, restored);
          else sessionStorage.removeItem(key);
          sessionStorage.removeItem(migrateFrom!);
        } else if (stored === initial) {
          sessionStorage.removeItem(key);
        }
        persisted = true;
      }
    } catch {
      // Storage can be unavailable or full. The navigation guard remains active.
      if (previous.key === key || previous.key === migrateFrom) restored = previous.value;
    }
    const moving = previous.key !== key && previous.key === migrateFrom;
    const next = {
      key,
      token: moving || previous.key === key ? previous.token : {},
      value: restored, baseline: initial, dirty: restored !== initial, loaded: true, persisted,
    };
    locations.current.set(next.token, key);
    current.current = next;
    setDraft(next);
  }, [key, initial, migrateFrom]);

  function setValue(nextValue: string) {
    const baseline = current.current.key === key ? current.current.baseline : initial;
    const dirty = nextValue !== baseline;
    let persisted = false;
    try {
      if (key !== null) {
        if (dirty) sessionStorage.setItem(key, nextValue);
        else sessionStorage.removeItem(key);
        persisted = true;
      }
    } catch {}
    const token = current.current.key === key ? current.current.token : {};
    const next = { key, token, value: nextValue, baseline, dirty, loaded: true, persisted };
    locations.current.set(token, key);
    current.current = next;
    setDraft(next);
  }

  function clear(nextValue = "", expectedValue = value) {
    const active = current.current;
    const token = draft.token;
    const ownsActive = active.token === token;
    // A late ACK may belong to the text before the user's next edit.
    if (ownsActive && active.value !== expectedValue) return;
    try {
      // A migration already moved its origin. Never delete an independent
      // chat:new draft recreated after that move or while using another chat.
      const location = locations.current.get(token);
      if (location !== null && location !== undefined &&
          (ownsActive || active.key !== location)) sessionStorage.removeItem(location);
    } catch {}
    if (!ownsActive) return;
    const next = {
      key: active.key, value: nextValue,
      token: active.token,
      baseline: nextValue, dirty: false, loaded: true, persisted: false,
    };
    current.current = next;
    setDraft(next);
  }

  const getValue = () => current.current.key === key ? current.current.value : initial;
  return { value, getValue, setValue, clear, persisted: draft.key === key && draft.persisted };
}

/** Also covers plain internal links; beforeunload alone misses client navigation. */
export function useUnsavedChangesWarning(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let allowNextUnload = false;
    let navigationReset: ReturnType<typeof setTimeout> | undefined;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (allowNextUnload) {
        allowNextUnload = false;
        clearTimeout(navigationReset);
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    };
    const beforeNavigate = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
          event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
      const target = new URL(anchor.href, window.location.href);
      if (target.origin === window.location.origin && target.pathname === window.location.pathname &&
          target.search === window.location.search && target.hash) return;
      allowNextUnload = false;
      clearTimeout(navigationReset);
      if (!window.confirm("Есть несохранённые изменения. Уйти со страницы?")) {
        event.preventDefault();
        event.stopPropagation();
      } else {
        allowNextUnload = true;
        // Native link activation unloads in this task. Client navigation or a
        // later preventDefault must not leave permission for a future reload.
        navigationReset = setTimeout(() => { allowNextUnload = false; }, 0);
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", beforeNavigate, true);
    return () => {
      clearTimeout(navigationReset);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", beforeNavigate, true);
    };
  }, [enabled]);
}
