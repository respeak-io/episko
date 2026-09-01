// The comment scanner behind test/comments.test.ts: which lines carry code and which carry
// comment text, per language, without a parser. Kept apart so a script can import it too.

export type Lang = "ts" | "rs" | "css" | "html";
export const langOf = (f: string): Lang =>
  f.endsWith(".rs") ? "rs" : f.endsWith(".css") ? "css" : f.endsWith(".html") ? "html" : "ts";

export interface Density { code: number; comment: number; longest: number; longestAt: number }

/** Which lines carry code and which carry comment text, without a parser: strings, template
 *  literals, regex literals, raw strings and char literals are skipped so a `//` inside one
 *  is code. */
export function scan(src: string, lang: Lang): { code: boolean[]; cmt: boolean[] } {
  const n = src.length;
  const code: boolean[] = [false], cmt: boolean[] = [false];
  let i = 0, line = 0;
  const eat = (to: number, isCmt: boolean) => {
    for (; i < to; i++) {
      const ch = src[i];
      if (ch === "\n") { line++; code.push(false); cmt.push(false); }
      else if (!/\s/.test(ch)) (isCmt ? cmt : code)[line] = true;
    }
  };
  const ident = (ch: string | undefined) => ch !== undefined && /[\w$]/.test(ch);
  while (i < n) {
    const c = src[i], two = src.slice(i, i + 2);
    if (lang === "html") {
      if (src.startsWith("<!--", i)) { const j = src.indexOf("-->", i + 4); eat(j < 0 ? n : j + 3, true); continue; }
      eat(i + 1, false); continue;
    }
    if (two === "//" && lang !== "css") { const j = src.indexOf("\n", i); eat(j < 0 ? n : j, true); continue; }
    if (two === "/*") {
      let depth = 1, j = i + 2;
      while (j < n && depth) {
        if (lang === "rs" && src.startsWith("/*", j)) { depth++; j += 2; continue; }
        if (src.startsWith("*/", j)) { depth--; j += 2; continue; }
        j++;
      }
      eat(j, true); continue;
    }
    if (c === '"' || (c === "'" && lang !== "rs")) {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++;
        if (src[j] === "\n" && lang !== "rs") break;
        j++;
      }
      eat(Math.min(j + 1, n), false); continue;
    }
    if (c === "`" && lang === "ts") {
      let j = i + 1;
      while (j < n && src[j] !== "`") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src.startsWith("${", j)) {
          let depth = 1; j += 2;
          while (j < n && depth) {
            const d = src[j];
            if (d === "{") depth++;
            else if (d === "}") depth--;
            else if (d === "`") { const k = src.indexOf("`", j + 1); j = k < 0 ? n : k; }
            else if (d === '"' || d === "'") {
              let k = j + 1;
              while (k < n && src[k] !== d) { if (src[k] === "\\") k++; k++; }
              j = k;
            }
            j++;
          }
          continue;
        }
        j++;
      }
      eat(Math.min(j + 1, n), false); continue;
    }
    if (lang === "rs") {
      const raw = /^(?:b|c)?r(#*)"/.exec(src.slice(i, i + 16));
      if (raw && !ident(src[i - 1])) {
        const end = '"' + raw[1];
        const k = src.indexOf(end, i + raw[0].length);
        eat(k < 0 ? n : k + end.length, false); continue;
      }
      if (c === "'") {
        let j = i + 1;
        if (src[i + 1] === "\\") { const k = src.indexOf("'", i + 2); j = k < 0 ? n : k + 1; }
        else if (src[i + 2] === "'" && src[i + 1] !== "'") j = i + 3;
        eat(j, false); continue;
      }
    }
    if (lang === "ts" && c === "/") {
      let k = i - 1;
      while (k >= 0 && (src[k] === " " || src[k] === "\t")) k--;
      const prev = k >= 0 ? src[k] : "(";
      const word = /[A-Za-z_$][\w$]*$/.exec(src.slice(Math.max(0, k - 20), k + 1))?.[0];
      const kw = ["return", "typeof", "case", "in", "of", "do", "else", "void", "throw"];
      if ("(,=:[!&|?{};+-*%<>~^\n".includes(prev) || (word !== undefined && kw.includes(word))) {
        let j = i + 1, cls = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === "[") cls = true;
          else if (src[j] === "]") cls = false;
          else if (src[j] === "/" && !cls) break;
          j++;
        }
        if (src[j] === "/") {
          j++;
          while (j < n && /[a-z]/i.test(src[j])) j++;
          eat(j, false); continue;
        }
      }
    }
    eat(i + 1, false);
  }
  return { code, cmt };
}

export function density(src: string, lang: Lang): Density {
  let { code, cmt } = scan(src, lang);
  if (src.endsWith("\n")) { code = code.slice(0, -1); cmt = cmt.slice(0, -1); }
  let run = 0, longest = 0, longestAt = 0, comment = 0;
  const codeLines = code.filter(Boolean).length;
  for (let l = 0; l < code.length; l++) {
    if (cmt[l] && !code[l]) {
      comment++;
      run++;
      if (run > longest) { longest = run; longestAt = l + 2 - run; }
    } else run = 0;
  }
  return { code: codeLines, comment, longest, longestAt };
}
