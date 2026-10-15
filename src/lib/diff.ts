/**
 * Line diff (Myers O(ND) with prefix/suffix trimming) and unified-diff rendering.
 * Pure functions: no I/O, no color.
 */

export type EditType = "eq" | "del" | "add";
export interface Edit {
  type: EditType;
  /** 0-based index into the old lines (eq/del) */
  a: number;
  /** 0-based index into the new lines (eq/add) */
  b: number;
}

/** Beyond this edit distance we stop searching and emit a full replace (keeps memory bounded). */
const MAX_D = 3000;

interface Lines {
  lines: string[];
  /** comparison keys: the last line carries a marker when the file has no trailing newline */
  keys: string[];
  noEol: boolean;
}

function splitLines(text: string): Lines {
  if (text === "") return { lines: [], keys: [], noEol: false };
  const lines = text.split("\n");
  let noEol = true;
  if (lines[lines.length - 1] === "") {
    lines.pop();
    noEol = false;
  }
  const keys = lines.slice();
  if (noEol && keys.length) keys[keys.length - 1] += "\u0000noeol";
  return { lines, keys, noEol };
}

export function diffKeys(a: string[], b: string[]): Edit[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const edits: Edit[] = [];
  for (let i = 0; i < pre; i++) edits.push({ type: "eq", a: i, b: i });
  const mid = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf));
  for (const e of mid) edits.push({ type: e.type, a: e.a + pre, b: e.b + pre });
  for (let i = suf; i > 0; i--) edits.push({ type: "eq", a: a.length - i, b: b.length - i });
  return edits;
}

function myers(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((_, j) => ({ type: "add" as const, a: 0, b: j }));
  if (m === 0) return a.map((_, i) => ({ type: "del" as const, a: i, b: 0 }));
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const snaps: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= Math.min(max, MAX_D); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[off + k - 1] as number) < (v[off + k + 1] as number)))
        x = v[off + k + 1] as number;
      else x = (v[off + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        snaps.push(v.slice(off - d, off + d + 1));
        found = d;
        break outer;
      }
    }
    snaps.push(v.slice(off - d, off + d + 1));
  }
  if (found === -1) {
    // too different: delete everything, add everything
    return [
      ...a.map((_, i) => ({ type: "del" as const, a: i, b: 0 })),
      ...b.map((_, j) => ({ type: "add" as const, a: n, b: j })),
    ];
  }
  const rev: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = snaps[d - 1] as Int32Array; // k in [-(d-1), d-1] at index k + d - 1
    const at = (k: number) => prev[k + d - 1] as number;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      rev.push({ type: "eq", a: x, b: y });
    }
    if (x === prevX) rev.push({ type: "add", a: x, b: prevY });
    else rev.push({ type: "del", a: prevX, b: y });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    rev.push({ type: "eq", a: x, b: y });
  }
  return rev.reverse();
}

export type LineKind = "header" | "hunk" | "ctx" | "del" | "add" | "meta";
export interface DiffLine {
  kind: LineKind;
  text: string;
}

export interface UnifiedDiff {
  changed: boolean;
  added: number;
  removed: number;
  lines: DiffLine[];
}

export function unifiedDiff(
  oldText: string,
  newText: string,
  opts: { oldLabel: string; newLabel: string; context?: number },
): UnifiedDiff {
  const ctx = opts.context ?? 3;
  const A = splitLines(oldText);
  const B = splitLines(newText);
  const edits = diffKeys(A.keys, B.keys);
  const changes: number[] = [];
  let added = 0;
  let removed = 0;
  edits.forEach((e, i) => {
    if (e.type !== "eq") changes.push(i);
    if (e.type === "add") added++;
    if (e.type === "del") removed++;
  });
  if (changes.length === 0) return { changed: false, added: 0, removed: 0, lines: [] };

  const lines: DiffLine[] = [
    { kind: "header", text: `--- ${opts.oldLabel}` },
    { kind: "header", text: `+++ ${opts.newLabel}` },
  ];

  // group change indices into hunks
  const groups: [number, number][] = [];
  let gStart = Math.max(0, (changes[0] as number) - ctx);
  let gEnd = Math.min(edits.length, (changes[0] as number) + ctx + 1);
  for (const ci of changes.slice(1)) {
    if (ci - ctx <= gEnd) gEnd = Math.min(edits.length, ci + ctx + 1);
    else {
      groups.push([gStart, gEnd]);
      gStart = Math.max(0, ci - ctx);
      gEnd = Math.min(edits.length, ci + ctx + 1);
    }
  }
  groups.push([gStart, gEnd]);

  // count lines before each position to compute hunk starts
  for (const [s, e] of groups) {
    let aBefore = 0;
    let bBefore = 0;
    for (let i = 0; i < s; i++) {
      const t = (edits[i] as Edit).type;
      if (t !== "add") aBefore++;
      if (t !== "del") bBefore++;
    }
    let aLen = 0;
    let bLen = 0;
    const body: DiffLine[] = [];
    for (let i = s; i < e; i++) {
      const ed = edits[i] as Edit;
      if (ed.type === "eq") {
        aLen++;
        bLen++;
        body.push({ kind: "ctx", text: ` ${A.lines[ed.a]}` });
        if (A.noEol && ed.a === A.lines.length - 1) body.push({ kind: "meta", text: "\\ No newline at end of file" });
      } else if (ed.type === "del") {
        aLen++;
        body.push({ kind: "del", text: `-${A.lines[ed.a]}` });
        if (A.noEol && ed.a === A.lines.length - 1) body.push({ kind: "meta", text: "\\ No newline at end of file" });
      } else {
        bLen++;
        body.push({ kind: "add", text: `+${B.lines[ed.b]}` });
        if (B.noEol && ed.b === B.lines.length - 1) body.push({ kind: "meta", text: "\\ No newline at end of file" });
      }
    }
    const range = (before: number, len: number) => `${len === 0 ? before : before + 1}${len === 1 ? "" : `,${len}`}`;
    lines.push({ kind: "hunk", text: `@@ -${range(aBefore, aLen)} +${range(bBefore, bLen)} @@` });
    lines.push(...body);
  }
  return { changed: true, added, removed, lines };
}
