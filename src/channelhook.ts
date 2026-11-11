// Puts ./channel's rule under every localStorage call of a preview build. main.ts imports this
// FIRST: state.ts and synclink read keys at module scope, and synclink's hook must wrap this one.
import { leaves, nextMark, overlay, parseChannel, switchedFrom, type Channel, type Store } from "./channel";
import { safeParse } from "./store";

export const CHANNEL: Channel = import.meta.env.VITE_EPISKO_CHANNEL === "preview" ? "preview" : "stable";

/** Both halves of a setting as stored, with no overlay between. On stable, writes still reach sync. */
export let baseStore: Store = {
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
  remove: (k) => localStorage.removeItem(k),
};

if (CHANNEL === "preview" && typeof Storage !== "undefined") {
  const P = Storage.prototype;
  const native = { get: P.getItem, set: P.setItem, remove: P.removeItem };
  baseStore = {
    get: (k) => native.get.call(localStorage, k),
    set: (k, v) => native.set.call(localStorage, k, v),
    remove: (k) => native.remove.call(localStorage, k),
  };
  const o = overlay(baseStore, CHANNEL);
  P.getItem = function (this: Storage, k: string) { return this === localStorage ? o.get(k) : native.get.call(this, k); };
  P.setItem = function (this: Storage, k: string, v: string) { if (this === localStorage) o.set(k, String(v)); else native.set.call(this, k, v); };
  P.removeItem = function (this: Storage, k: string) { if (this === localStorage) o.remove(k); else native.remove.call(this, k); };
}

/** Whether a write to `key` may go to the user's other machines from this build. */
export const sends = (key: string): boolean => leaves(key, CHANNEL);

/** Records this run's channel, and answers the one it replaced, if the last run was the other. */
export function markChannel(version: string): Channel | null {
  const prev = safeParse(localStorage.getItem("cc-channel"));
  localStorage.setItem("cc-channel", JSON.stringify(nextMark(prev, CHANNEL, version, Date.now())));
  return switchedFrom(prev, CHANNEL);
}

export const updateChannel = (): Channel => parseChannel(localStorage.getItem("cc-update-channel"), CHANNEL);
export const setUpdateChannel = (c: Channel) => localStorage.setItem("cc-update-channel", c);
