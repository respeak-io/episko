// The one DOM accessor the whole app uses. Every element it looks up is a static
// one declared in index.html, which is why the non-null assertion is honest here
// rather than optimistic — a miss is a typo, and it should throw at the call site
// instead of silently doing nothing.
//
// It lives alone in its own module because it is what a DOM-owning module (the
// debug console, the dialogs) needs from main.ts and nothing else; without this,
// extracting any of them would mean importing main.ts, which the dependency
// direction forbids.
export const $ = (id: string) => document.getElementById(id)!;
