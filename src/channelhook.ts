// Puts ./channel's rule under every localStorage call of a preview build. main.ts imports this
// FIRST: state.ts and synclink read keys at module scope, and synclink's hook must wrap this one.
import { leaves, nextMark, overlay, type Channel } from "./channel";
import { safeParse } from "./store";

export const CHANNEL: Channel = import.meta.env.VITE_EPISKO_CHANNEL === "preview" ? "preview" : "stable";

if (CHANNEL === "preview" && typeof Storage !== "undefined") {
  const P = Storage.prototype;
  const native = { get: P.getItem, set: P.setItem, remove: P.removeItem };
  const o = overlay({
    get: (k) => native.get.call(localStorage, k),
    set: (k, v) => native.set.call(localStorage, k, v),
    remove: (k) => native.remove.call(localStorage, k),
  }, CHANNEL);
  P.getItem = function (this: Storage, k: string) { return this === localStorage ? o.get(k) : native.get.call(this, k); };
  P.setItem = function (this: Storage, k: string, v: string) { if (this === localStorage) o.set(k, String(v)); else native.set.call(this, k, v); };
  P.removeItem = function (this: Storage, k: string) { if (this === localStorage) o.remove(k); else native.remove.call(this, k); };
}

/** Whether a write to `key` may go to the user's other machines from this build. */
export const sends = (key: string): boolean => leaves(key, CHANNEL);

export function markChannel(version: string) {
  const mark = nextMark(safeParse(localStorage.getItem("cc-channel")), CHANNEL, version, Date.now());
  localStorage.setItem("cc-channel", JSON.stringify(mark));
}
