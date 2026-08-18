"use strict";
/* ══════════════════════════════════════════════════════════════════════
   PYTHON COMPILER v5.0 — targets the REAL CoreEngine canonical grammar
   (compilers/core-engine.js), not plain JavaScript.

   WHY THIS VERSION EXISTS
   core-engine.js is a hand-written interpreter with its own small
   grammar: let/if/else/while/for/function/return/break/continue,
   arrays, a fixed builtin function list, and a fixed set of array/
   string methods. It has NO classes, NO dict/object literals, NO
   try/catch, NO arrow functions/lambdas-as-values, NO template
   literals, NO destructuring, NO spread. Earlier versions of this
   compiler emitted modern JS (classes, template literals, etc.) which
   that interpreter's parser cannot read at all - that's why even
   `print("Hello World")` was failing with a parser error. This version
   emits ONLY constructs the real interpreter understands.

   Three small, additive builtins were added to core-engine.js to make
   correct Python semantics possible (see callBuiltin in that file):
     truediv(a,b)   - Python's `/` is always float division; the
                      canonical `/` operator intentionally truncates
                      for two integers (correct for C/Java/Go, not
                      Python), so true division needs its own builtin.
     pystr(v)       - like str(), but prints True/False/None the
                      Python way. Needs a real typeof check that the
                      canonical language itself cannot perform.
     pyreversed(v)  - reversed() must return the same shape it was
                      given (string in -> string out, list in -> list
                      out); also needs real typeof.
   Everything else Python needs beyond the raw grammar (enumerate, zip,
   sum, sorted, list.insert/remove/extend, str.startswith, etc.) is
   implemented as small helper functions WRITTEN IN THE CANONICAL
   LANGUAGE ITSELF and prepended to every compiled program - no further
   engine changes required.

   WHAT IS NOT SUPPORTED (and why) - these raise a clear compile-time
   error instead of producing broken output:
     - class / OOP            → the engine has no object/property model
     - dict / set literals     → no object-literal syntax in the grammar
     - try / except / finally  → no exception handling in the grammar
     - lambda used as a value  → functions aren't first-class values in
                                  the engine (Call only dispatches by an
                                  identifier name), so callbacks
                                  (sorted(key=...), map(fn, ...), etc.)
                                  can't work either
     - *args / **kwargs        → functions are fixed-arity
     - decorators, yield, async, with-statement, multiple inheritance
   Default argument values, tuple unpacking (`a, b = b, a`), f-strings,
   comprehensions used directly in an assignment, slicing, most common
   str/list operations, and the walrus operator (`x := expr`, as its own
   `NamedExpr` AST node - see core-engine.js) ARE supported - see the
   transform code below for the exact mapping.
═══════════════════════════════════════════════════════════════════════ */

const PythonCompiler = (() => {

  /* ───────────────────────── low level helpers ───────────────────────── */

  function stripComment(line) {
    let inStr = null, escape = false, out = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (escape) { out += c; escape = false; continue; }
      if (c === '\\') { escape = true; out += c; continue; }
      if (inStr) { out += c; if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'") { inStr = c; out += c; continue; }
      if (c === '#') break;
      out += c;
    }
    return out;
  }

  // Python allows a statement to span multiple physical lines two ways:
  // implicitly, while inside an unclosed (), [], or {} (the common case -
  // multi-line function calls, list/dict/tuple literals), and explicitly,
  // via a trailing backslash. This engine's main loop otherwise treats
  // every physical line as its own complete statement, so either form
  // used to produce nonsense: a multi-line list of lambdas, for example,
  // got compiled one physical line at a time, each of which looks like a
  // bare `lambda ...:` statement (rejected) or a stray trailing comma
  // (a syntax error) in isolation.
  //
  // Returns a new array the SAME LENGTH as rawLines (preserving line
  // numbers for error messages) - each starting line of a continued
  // statement holds the full joined (space-separated) text, and the
  // physical lines it swallowed become empty (so every existing
  // line-indexed helper - hasFollowingContinuation, countExceptClauses,
  // defBodyContainsYield, etc. - keeps working unmodified, since they
  // already skip blank lines and look at one logical line at a time).
  // Triple-quoted strings are tracked (so brackets inside one, and any
  // line-break inside one, don't affect bracket depth) but not joined
  // here - that's already handled separately, later, by the existing
  // inMultiline mechanism in toCanonical's main loop.
  function joinContinuationLines(rawLines) {
    const result = new Array(rawLines.length).fill('');
    function lineDepthDelta(text) {
      let depthDelta = 0, inStr = null, tripleQuote = null, k = 0;
      const n = text.length;
      while (k < n) {
        if (tripleQuote) {
          if (text.slice(k, k + 3) === tripleQuote) { tripleQuote = null; k += 3; continue; }
          k++; continue;
        }
        const c = text[k];
        if (inStr) {
          if (c === '\\') { k += 2; continue; }
          if (c === inStr) { inStr = null; k++; continue; }
          k++; continue;
        }
        if (c === '#') break;
        if (text.slice(k, k + 3) === '"""' || text.slice(k, k + 3) === "'''") { tripleQuote = text.slice(k, k + 3); k += 3; continue; }
        if (c === '"' || c === "'") { inStr = c; k++; continue; }
        if (c === '(' || c === '[' || c === '{') { depthDelta++; k++; continue; }
        if (c === ')' || c === ']' || c === '}') { depthDelta--; k++; continue; }
        k++;
      }
      return depthDelta;
    }
    let i = 0;
    while (i < rawLines.length) {
      let depth = lineDepthDelta(stripComment(rawLines[i]));
      let joined = stripComment(rawLines[i]);
      let explicitCont = /\\\s*$/.test(joined);
      if (explicitCont) joined = joined.replace(/\\\s*$/, '');
      let j = i;
      while ((depth > 0 || explicitCont) && j + 1 < rawLines.length) {
        j++;
        let next = stripComment(rawLines[j]);
        explicitCont = false;
        const m = /\\\s*$/.test(next);
        if (m) { next = next.replace(/\\\s*$/, ''); explicitCont = true; }
        joined = joined + ' ' + next.trim();
        depth += lineDepthDelta(stripComment(rawLines[j]));
      }
      result[i] = joined;
      i = j + 1;
    }
    return result;
  }

  function countOccurrences(str, sub) {
    let n = 0, i = 0;
    while ((i = str.indexOf(sub, i)) !== -1) { n++; i += sub.length; }
    return n;
  }

  function splitTopLevel(str, sep = ',') {
    const parts = [];
    let depth = 0, cur = '', inStr = null, escape = false;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (escape) { cur += c; escape = false; continue; }
      if (inStr) {
        cur += c;
        if (c === '\\') escape = true;
        else if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'") { inStr = c; cur += c; continue; }
      if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; }
      if (c === ')' || c === ']' || c === '}') { depth--; cur += c; continue; }
      if (depth === 0 && str.slice(i, i + sep.length) === sep) {
        parts.push(cur); cur = ''; i += sep.length - 1; continue;
      }
      cur += c;
    }
    if (cur.trim() !== '' || parts.length > 0) parts.push(cur);
    return parts.map(p => p.trim()).filter(p => p.length > 0);
  }

  function findTopLevelKeyword(str, kw) {
    let depth = 0, inStr = null, escape = false;
    const re = new RegExp('^' + kw + '\\b');
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (escape) { escape = false; continue; }
      if (inStr) { if (c === '\\') escape = true; else if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'") { inStr = c; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (depth === 0 && re.test(str.slice(i))) return i;
    }
    return -1;
  }

  // top-level ':' inside [ ] used for slicing (not dict/annotation colons,
  // since we don't support those anyway - this only ever looks inside brackets)
  function splitSliceColon(inner) {
    const parts = [];
    let depth = 0, inStr = null, cur = '';
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (inStr) { cur += c; if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'") { inStr = c; cur += c; continue; }
      if (c === '(' || c === '[') { depth++; cur += c; continue; }
      if (c === ')' || c === ']') { depth--; cur += c; continue; }
      if (c === ':' && inner[i + 1] !== '=' && depth === 0) { parts.push(cur); cur = ''; continue; }
      cur += c;
    }
    parts.push(cur);
    return parts;
  }

  class UnsupportedError extends Error {}

  function unsupported(feature, why) {
    throw new UnsupportedError(`${feature} is not supported on this platform${why ? ' (' + why + ')' : ''}.`);
  }

  /* ───────────────────────── string masking ─────────────────────────
     Keyword passes (and/or/not/in/is - though and/or/not pass through
     unchanged here, in/is do not) must never touch text inside string
     literals. Mask every string literal before those passes and restore
     it right before returning. */

  const MASK_OPEN = '\u0002', MASK_CLOSE = '\u0003';

  function maskStrings(content) {
    const store = [];
    let out = '', inStr = null, escape = false, buf = '';
    for (let i = 0; i < content.length; i++) {
      const c = content[i];
      if (inStr) {
        buf += c;
        if (escape) { escape = false; continue; }
        if (c === '\\') { escape = true; continue; }
        if (c === inStr) { store.push(buf); out += MASK_OPEN + (store.length - 1) + MASK_CLOSE; inStr = null; buf = ''; }
        continue;
      }
      if (c === '"' || c === "'") { inStr = c; buf = c; continue; }
      out += c;
    }
    if (inStr) out += buf;
    return { masked: out, store };
  }

  function unmaskStrings(content, store) {
    const re = new RegExp(MASK_OPEN + '(\\d+)' + MASK_CLOSE, 'g');
    return content.replace(re, (m, i) => store[parseInt(i, 10)]);
  }

  // Literal text (unescaped) of a masked placeholder / plain quoted string,
  // used at compile time for %-format and .format() literal parsing.
  function literalStringValue(maskedTokenOrRaw, store) {
    let raw = maskedTokenOrRaw;
    const m = raw.match(new RegExp('^' + MASK_OPEN + '(\\d+)' + MASK_CLOSE + '$'));
    if (m) raw = store[parseInt(m[1], 10)];
    if (!raw || (raw[0] !== '"' && raw[0] !== "'")) return null;
    const q = raw[0];
    if (raw[raw.length - 1] !== q || raw.length < 2) return null;
    let body = raw.slice(1, -1), out = '';
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '\\' && i + 1 < body.length) {
        const e = body[i + 1];
        const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" };
        out += map[e] !== undefined ? map[e] : e;
        i++;
      } else out += body[i];
    }
    return out;
  }

  function jsQuote(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
  }

  // Used only by the multi-line triple-quoted-string mechanism below:
  // escapes backslashes/quotes for a chunk that will become part of one
  // ongoing (unquoted-here) string token, but deliberately does NOT
  // escape newlines - the whole point is to let the real line break
  // between this chunk and the next survive into the output, since the
  // lexer's string tokenizer already happily consumes a literal newline
  // as part of one string (that's what makes Python's own triple-quoted
  // strings able to span lines in the first place).
  function escapeMultilineChunk(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /* ───────────────────────── f-strings ─────────────────────────
     f"...{expr}..." -> ("literal" + pystr(expr) + "literal" ...)
     (canonical has no template-literal interpolation, so this always
     becomes plain string concatenation; pystr() keeps True/False/None
     capitalised the Python way.) */

  // Turns a Python format-spec-mini-language string (the part after ':' in
  // f"{x:.2f}", or after '%' in "%5.2f") into a canonical expression.
  // Supports the common cases (fixed decimals, width, alignment); anything
  // fancier (thousands separators, sign forcing, hex/oct/bin specs) falls
  // back to plain str() rather than erroring, since getting the shape
  // approximately right beats refusing to compile.
  function buildFormattedValue(exprText, spec) {
    const m = spec.match(/^([<>^]?)(\d*)(?:\.(\d+))?([fdxXob%]?)$/);
    if (!m) return `pystr(${exprText})`;
    const [, align, width, prec, type] = m;
    let valueExpr;
    if (type === 'f') valueExpr = `pyfixed(${exprText}, ${prec !== undefined ? prec : 6})`;
    else if (type === 'd') valueExpr = `pystr(pyint(${exprText}))`;
    else if (type === '%') valueExpr = `(pyfixed((${exprText}) * 100, ${prec !== undefined ? prec : 6}) + "%")`;
    else if (type === 'x') valueExpr = `hex(${exprText}).slice(2)`;
    else if (type === 'X') valueExpr = `hex(${exprText}).slice(2).upper()`;
    else if (type === 'o') valueExpr = `oct(${exprText}).slice(2)`;
    else if (type === 'b') valueExpr = `bin(${exprText}).slice(2)`;
    else valueExpr = `pystr(${exprText})`;
    if (width) return `pypad(${valueExpr}, ${width}, ${jsQuote(align || '')})`;
    return valueExpr;
  }

  // Python bytes literals b'...' / B"..." become `pybytes('...')` - a
  // runtime call that UTF-8 encodes the literal's text into a real byte
  // array (matching what str.encode() produces), so `b' ' + x.encode()`
  // etc. work with actual byte semantics rather than silently being
  // treated as ordinary strings.
  // Handles Python string-literal prefixes: b'...'/B"..." (bytes) and
  // r'...'/R"..." plus rb/br combos (raw - every backslash in the body is
  // literal, never an escape).
  //
  // This scans with real string-boundary tracking (like maskStrings does)
  // rather than pattern-matching the raw, unmasked text, because a blind
  // regex can't tell "a prefix letter right before a new string's opening
  // quote" apart from "an ordinary letter that happens to be the last
  // character before some *other* string's closing quote" (e.g. the dict
  // key 'b', or a string ending in "...b'" like r'a.b') — both look
  // identical from outside. Tracking whether we're currently inside a
  // string removes that ambiguity entirely: prefixes are only ever
  // recognized when we're not already inside one.
  //
  // Raw bodies need their own care: the shared lexer used for every
  // language processes backslash escapes and silently drops the backslash
  // on anything it doesn't recognize (so \d would become just "d") - fine
  // for ordinary strings, fatal for raw ones (which is what makes them the
  // natural way to write regex like r'\d+'). Each raw body is first
  // re-scanned using Python's own raw-string tokenizing rule (a backslash
  // always "protects" the next character from ending the string, so
  // r'\\' is 2 literal backslashes, not an unterminated string) to find
  // its true extent, then re-encoded one character at a time so it
  // survives the lexer's escape processing unchanged, however many
  // backslashes or embedded quote characters it contains.
  function stripStringPrefixes(content) {
    let out = '', i = 0, inStr = null, escape = false;
    const n = content.length;
    while (i < n) {
      const c = content[i];
      if (inStr) {
        out += c;
        if (escape) { escape = false; i++; continue; }
        if (c === '\\') { escape = true; i++; continue; }
        if (c === inStr) inStr = null;
        i++; continue;
      }
      if (c === 'r' || c === 'R' || c === 'b' || c === 'B') {
        const prevOut = out.length ? out[out.length - 1] : '';
        if (!/\w/.test(prevOut)) {
          let j = i, isRaw = false, hasB = false;
          while (j < n && j < i + 2 && /[rRbB]/.test(content[j])) {
            if (content[j] === 'r' || content[j] === 'R') isRaw = true;
            if (content[j] === 'b' || content[j] === 'B') hasB = true;
            j++;
          }
          const q = content[j];
          if (j > i && (q === '"' || q === "'")) {
            if (!isRaw && !hasB) { i = j; continue; }
            let k = j + 1;
            while (k < n) {
              if (content[k] === '\\' && k + 1 < n) { k += 2; continue; }
              if (content[k] === q) break;
              k++;
            }
            let literal;
            if (isRaw) {
              const body = content.slice(j + 1, k);
              let safeBody = '';
              for (const ch of body) {
                if (ch === '\\') safeBody += '\\\\';
                else if (ch === q) safeBody += '\\' + q;
                else safeBody += ch;
              }
              literal = q + safeBody + q;
            } else {
              // Non-raw bytes literal (b'...'): keep the text exactly as
              // written, including its own escapes - those get processed
              // normally later by the same lexer that handles every other
              // string, so nothing extra is needed here.
              literal = content.slice(j, k + 1);
            }
            out += hasB ? `pybytes(${literal})` : literal;
            i = k + 1;
            continue;
          }
        }
      }
      if (c === '"' || c === "'") { inStr = c; out += c; i++; continue; }
      out += c; i++;
    }
    return out;
  }

  function expandFStrings(line) {
    return line.replace(/f(["'])([\s\S]*?)\1/g, (_, quote, content) => {
      const parts = [];
      let i = 0;
      while (i < content.length) {
        if (content[i] === '{' && content[i + 1] === '{') { parts.push(jsQuote('{')); i += 2; continue; }
        if (content[i] === '}' && content[i + 1] === '}') { parts.push(jsQuote('}')); i += 2; continue; }
        if (content[i] === '{') {
          let depth = 1, j = i + 1;
          while (j < content.length && depth > 0) {
            if (content[j] === '{') depth++; else if (content[j] === '}') depth--;
            j++;
          }
          let inner = content.slice(i + 1, j - 1);
          // find the format-spec colon at bracket depth 0 (so slicing like
          // {x[1:2]} isn't mistaken for a format spec)
          let bd = 0, specIdx = -1, inStr = null;
          for (let k = 0; k < inner.length; k++) {
            const c = inner[k];
            if (inStr) { if (c === inStr) inStr = null; continue; }
            if (c === '"' || c === "'") { inStr = c; continue; }
            if (c === '(' || c === '[') bd++;
            else if (c === ')' || c === ']') bd--;
            else if (c === ':' && bd === 0) { specIdx = k; break; }
          }
          let spec = null;
          if (specIdx >= 0) { spec = inner.slice(specIdx + 1); inner = inner.slice(0, specIdx); }
          const convMatch = inner.match(/!([rsa])$/);
          const conv = convMatch ? convMatch[1] : null;
          if (conv) inner = inner.slice(0, convMatch.index);
          inner = inner.trim();
          const exprText = inner;
          parts.push(spec ? buildFormattedValue(exprText, spec.trim()) : `pystr(${exprText})`);
          i = j;
        } else {
          let j = i;
          while (j < content.length && content[j] !== '{' && content[j] !== '}') j++;
          if (j > i) parts.push(jsQuote(content.slice(i, j)));
          i = j;
        }
      }
      if (parts.length === 0) return '""';
      return '(' + parts.join(' + ') + ')';
    });
  }

  /* ───────────────────────── slicing ─────────────────────────
     NAME[a:b] -> NAME.slice(a, b)      (works for both strings & lists)
     NAME[::-1] -> pyreversed(NAME)     (the one step value we can support) */

  // The engine's parser now understands `{key: value, ...}` dict literals
  // natively, so those pass straight through untouched. Python set
  // literals `{a, b, c}` (no colon) have no engine equivalent, so they
  // become an array-based pyset(...) helper call instead.
  function convertSetLiterals(content) {
    let changed = true, guard = 0;
    while (changed && guard++ < 10) {
      changed = false;
      content = content.replace(/\{([^{}]*)\}/g, (m, inner) => {
        if (inner.trim() === '') return m; // {} is an empty dict in Python
        // a generated function/block body (from lambda conversion) looks
        // like `{ return (x * x); }` - it has no colon either, but it's
        // definitely not a Python set literal, so bail out on anything
        // that looks like a statement rather than a bare expression list.
        if (/;|\breturn\b/.test(inner)) return m;
        if (/^\s*\*\*/.test(inner) || /,\s*\*\*/.test(inner)) return m; // dict spread {**a, **b} - leave for the engine
        let depth = 0, inStr = null, hasColon = false;
        for (let i = 0; i < inner.length; i++) {
          const c = inner[i];
          if (inStr) { if (c === inStr) inStr = null; continue; }
          if (c === '"' || c === "'") { inStr = c; continue; }
          if (c === '(' || c === '[') depth++;
          else if (c === ')' || c === ']') depth--;
          else if (c === ':' && inner[i + 1] !== '=' && depth === 0) { hasColon = true; break; }
        }
        if (hasColon) return m; // real dict literal - leave for the engine
        changed = true;
        return `pyset([${inner}])`;
      });
    }
    return content;
  }

  // Forward, recursive scanner (not a regex). The old implementation
  // matched the receiver in front of `[a:b]` with a regex whose "one
  // call's worth of parens" alternative (`\([^()]*\)`) could not
  // describe a *nested* call like `list(input())` - `input()` has
  // parens inside the outer parens, so the regex simply failed to match
  // anything there and the slice (e.g. `list(input())[:-1]`) was left
  // untouched in the output, which the engine's canonical parser then
  // can't read (`Unexpected token ":"`).
  // This version walks the text left to right using the existing
  // balanced-paren/bracket matchers (which handle arbitrary nesting
  // correctly, unlike a fixed regex) and recurses into the contents of
  // every paren/bracket group it passes over, so a slice works no
  // matter how deeply it's nested inside calls, indexing, or other
  // slices.
  function convertSlicing(content) {
    let out = '', i = 0;
    const n = content.length;
    while (i < n) {
      let atomEnd = -1;
      if (content[i] === MASK_OPEN) {
        let j = i + 1;
        while (j < n && content[j] !== MASK_CLOSE) j++;
        if (j < n) atomEnd = j + 1;
      } else if (/[A-Za-z_]/.test(content[i])) {
        let j = i;
        while (j < n && /\w/.test(content[j])) j++;
        atomEnd = j;
      }
      if (atomEnd === -1) { out += content[i]; i++; continue; }

      let recv = content.slice(i, atomEnd);
      let chainEnd = atomEnd;
      while (chainEnd < n) {
        const c = content[chainEnd];
        if (c === '.') {
          let j = chainEnd + 1;
          while (j < n && /\w/.test(content[j])) j++;
          if (j === chainEnd + 1) break; // dot not followed by a name
          recv += content.slice(chainEnd, j);
          chainEnd = j;
        } else if (c === '(') {
          const close = findMatchingParen(content, chainEnd);
          if (close === -1) break;
          const inner = convertSlicing(content.slice(chainEnd + 1, close));
          recv += '(' + inner + ')';
          chainEnd = close + 1;
        } else if (c === '[') {
          const close = findMatchingBracket(content, chainEnd);
          if (close === -1) break;
          const rawInner = content.slice(chainEnd + 1, close);
          if (rawInner.includes(':')) {
            const segs = splitSliceColon(rawInner).map(s => convertSlicing(s));
            if (segs.length > 3) break; // not a slice this engine can express
            const [s, e, st] = [segs[0] || '', segs[1] || '', segs[2] || ''];
            const arg = v => v.trim() === '' ? 'null' : `(${v.trim()})`;
            recv = `pyslicestep(${recv}, ${arg(s)}, ${arg(e)}, ${arg(st)})`;
            chainEnd = close + 1;
            // keep looping - supports chained ops after a slice, e.g.
            // `a[1:3][0]` or `a[1:][::-1]`
          } else {
            recv += '[' + convertSlicing(rawInner) + ']'; // plain index
            chainEnd = close + 1;
          }
        } else break;
      }
      out += recv;
      i = chainEnd;
    }
    return out;
  }

  /* ───────────────────────── list/dict/set comprehensions ─────────────────────────
     Only usable as the entire right-hand side of a simple assignment -
     the engine has no expression-level function literals to build an
     inline map/filter chain, so comprehensions must be expanded into an
     explicit preceding loop. Returns null if `rhs` isn't a comprehension. */

  function findTopLevelColon(str) {
    let depth = 0, inStr = null;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (inStr) { if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'") { inStr = c; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ':' && str[i + 1] !== '=' && depth === 0) return i;
    }
    return -1;
  }

  function expandComprehension(varName, rhs) {
    let kind, inner;
    let m = rhs.match(/^\[([\s\S]*)\]$/);
    if (m) { kind = 'list'; inner = m[1]; }
    else {
      m = rhs.match(/^\{([\s\S]*)\}$/);
      if (!m) return null;
      inner = m[1];
      const forIdxProbe = findTopLevelKeyword(inner, 'for');
      const exprPart = forIdxProbe === -1 ? inner : inner.slice(0, forIdxProbe);
      kind = findTopLevelColon(exprPart) !== -1 ? 'dict' : 'set';
    }
    const forIdx = findTopLevelKeyword(inner, 'for');
    if (forIdx === -1) return null;
    const rawExpr = inner.slice(0, forIdx).trim();
    let rest = inner.slice(forIdx + 3);
    const inIdx = findTopLevelKeyword(rest, 'in');
    if (inIdx === -1) return null;
    const loopVarRaw = rest.slice(0, inIdx).trim();
    rest = rest.slice(inIdx + 2);
    const ifIdx = findTopLevelKeyword(rest, 'if');
    let rawIter, rawCond = null;
    if (ifIdx === -1) rawIter = rest.trim();
    else { rawIter = rest.slice(0, ifIdx).trim(); rawCond = rest.slice(ifIdx + 2).trim(); }

    const iterExpr = transformExpression(rawIter);
    const cond = rawCond !== null ? transformExpression(rawCond) : null;

    let loopVar = loopVarRaw, unpackPreamble = '';
    if (loopVarRaw.includes(',')) {
      const names = loopVarRaw.split(',').map(s => s.trim());
      loopVar = '__cval';
      unpackPreamble = names.map((n, i) => `${n} = __cval[${i}];`).join(' ') + ' ';
    }

    const lines = [];
    if (kind === 'dict') {
      const colonAt = findTopLevelColon(rawExpr);
      if (colonAt === -1) unsupported('Malformed dict comprehension', 'expected `{key: value for ...}`');
      const key = transformExpression(rawExpr.slice(0, colonAt).trim());
      const val = transformExpression(rawExpr.slice(colonAt + 1).trim());
      lines.push(`${varName} = {};`);
      lines.push(`for (${loopVar} in ${iterExpr}) {`);
      const body = `${varName}[${key}] = ${val};`;
      lines.push(cond ? `${unpackPreamble}if (${cond}) { ${body} }` : `${unpackPreamble}${body}`);
      lines.push('}');
      return lines;
    }

    const expr = transformExpression(rawExpr);
    lines.push(`${varName} = [];`);
    lines.push(`for (${loopVar} in ${iterExpr}) {`);
    const push = `${varName}.push(${expr});`;
    lines.push(cond ? `${unpackPreamble}if (${cond}) { ${push} }` : `${unpackPreamble}${push}`);
    lines.push('}');
    if (kind === 'set') lines.push(`${varName} = pyset(${varName});`);
    return lines;
  }

  /* ───────────────────────── method-call rewriting ───────────────────────── */

  const RECV = '(\\u0002\\d+\\u0003|[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*|\\[[^\\[\\]]*\\]|\\([^()]*\\))*)';

  // Finds the index of the ')' matching the '(' at openIdx (which must be
  // content[openIdx] === '('). Operates on already-masked content, so no
  // string-literal awareness is needed here.
  function findMatchingParen(content, openIdx) {
    let depth = 0, inStr = null, escape = false;
    for (let i = openIdx; i < content.length; i++) {
      const c = content[i];
      if (inStr) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'") { inStr = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  function findMatchingBracket(content, openIdx) {
    let depth = 0, inStr = null, escape = false;
    for (let i = openIdx; i < content.length; i++) {
      const c = content[i];
      if (inStr) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'") { inStr = c; continue; }
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  function findMatchingBrace(content, openIdx) {
    let depth = 0, inStr = null, escape = false;
    for (let i = openIdx; i < content.length; i++) {
      const c = content[i];
      if (inStr) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'") { inStr = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  // Several string methods take no arguments in their normal bound-call
  // form (`"x".upper()`), so their compile-time conversion below only
  // ever looked at the receiver and just rebuilt a fixed zero-arg call -
  // correct for that form, but silently wrong for the *unbound* call
  // form `str.upper(x)` (used e.g. via `map(str.upper, ...)` written out
  // longhand, or just directly), where the receiver captured is the
  // literal `str` type and `x` - the actual instance the method should
  // run on - was being thrown away entirely, always calling upper() on
  // nothing. This detects exactly that case (receiver is bare `str`, and
  // an argument was actually supplied) and redirects the method onto
  // that argument instead.
  function unboundAwareReceiver(r, a) {
    return (r === 'str' && a.trim() !== '') ? splitTopLevel(a, ',')[0].trim() : r;
  }

  function replaceCall(content, methodName, fn) {
    const re = new RegExp(RECV + '\\.' + methodName + '\\(', 'g');
    let out = '', last = 0, m;
    while ((m = re.exec(content)) !== null) {
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = findMatchingParen(content, openIdx);
      if (closeIdx === -1) continue;
      const args = content.slice(openIdx + 1, closeIdx);
      out += content.slice(last, m.index) + fn(m[1], args);
      last = closeIdx + 1;
      re.lastIndex = closeIdx + 1;
    }
    out += content.slice(last);
    return out;
  }

  function convertMethodCalls(content) {
    // list-ish (native methods that already exist in callMethod)
    content = replaceCall(content, 'append', (r, a) => `${r}.push(${a})`);
    content = replaceCall(content, 'extend', (r, a) => `pyextend(${r}, ${a})`);
    content = replaceCall(content, 'insert', (r, a) => {
      const p = splitTopLevel(a, ',');
      return `pyinsert(${r}, ${p[0]}, ${p[1]})`;
    });
    content = replaceCall(content, 'remove', (r, a) => `pyremove(${r}, ${a})`);
    content = replaceCall(content, 'count', (r, a) => `pycount(${r}, ${a})`);
    content = replaceCall(content, 'index', (r, a) => `${r}.indexOf(${splitTopLevel(a, ',')[0]})`);
    content = replaceCall(content, 'reverse', (r) => `${r}.reverse()`);

    // strings
    content = replaceCall(content, 'strip', (r, a) => `${unboundAwareReceiver(r, a)}.strip()`);
    content = replaceCall(content, 'lstrip', (r, a) => `${unboundAwareReceiver(r, a)}.strip()`); // approximation - see notes
    content = replaceCall(content, 'rstrip', (r, a) => `${unboundAwareReceiver(r, a)}.strip()`); // approximation - see notes
    content = replaceCall(content, 'upper', (r, a) => `${unboundAwareReceiver(r, a)}.upper()`);
    content = replaceCall(content, 'lower', (r, a) => `${unboundAwareReceiver(r, a)}.lower()`);
    content = replaceCall(content, 'startswith', (r, a) => `pystartswith(${r}, ${a})`);
    content = replaceCall(content, 'endswith', (r, a) => `pyendswith(${r}, ${a})`);
    content = replaceCall(content, 'find', (r, a) => `${r}.indexOf(${a})`);
    content = replaceCall(content, 'replace', (r, a) => `${r}.replace(${a})`);
    content = replaceCall(content, 'split', (r, a) => `${r}.split(${a})`);
    content = replaceCall(content, 'rsplit', (r, a) => {
      const p = splitTopLevel(a, ',');
      const sep = p[0] !== undefined ? p[0].trim() : '';
      const maxsplit = p[1] !== undefined ? p[1].trim() : '';
      return `pyrsplit(${r}, ${sep === '' ? 'null' : sep}, ${maxsplit === '' ? 'null' : maxsplit})`;
    });
    content = replaceCall(content, 'removesuffix', (r, a) => `pyremovesuffix(${r}, ${a})`);
    content = replaceCall(content, 'removeprefix', (r, a) => `pyremoveprefix(${r}, ${a})`);
    content = replaceJoin(content);
    content = replaceCall(content, 'capitalize', (r, a) => `pycapitalize(${unboundAwareReceiver(r, a)})`);
    content = replaceCall(content, 'title', (r, a) => `pycapitalize(${unboundAwareReceiver(r, a)})`); // approximation (whole-string only)
    content = replaceCall(content, 'isdigit', (r) => `pyisdigit(${r})`);
    content = replaceCall(content, 'encode', (r) => `pyencode(${r})`);
    content = replaceCall(content, 'decode', (r) => `pydecode(${r})`);

    return content;
  }

  function replaceJoin(content) {
    const re = new RegExp(RECV + '\\.join\\(', 'g');
    let out = '', last = 0, m;
    while ((m = re.exec(content)) !== null) {
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = findMatchingParen(content, openIdx);
      if (closeIdx === -1) continue;
      const args = content.slice(openIdx + 1, closeIdx);
      out += content.slice(last, m.index) + `(${args}).join(${m[1]})`;
      last = closeIdx + 1;
      re.lastIndex = closeIdx + 1;
    }
    out += content.slice(last);
    return out;
  }

  // Python's list.sort() sorts in place with no return value semantics
  // that matter here; the engine's native .sort() with no args already
  // gives a sensible default (numeric-or-string) comparator, so this is
  // just a straight passthrough (no key= support - see header notes).
  // pd.Series(data, index=[...]) - reorders the index= keyword argument
  // into pd_series's second positional slot, same technique as
  // convertSortCalls just below for key=/reverse= (this engine's calling
  // convention has no general keyword-argument support - see the header
  // notes - so each keyword-argument call site that's worth supporting
  // gets its own small, explicit rewrite like this one).
  function convertPandasSeriesCalls(content) {
    const re = /\bpd_series\(/g;
    let out = '', last = 0, m;
    while ((m = re.exec(content)) !== null) {
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = findMatchingParen(content, openIdx);
      if (closeIdx === -1) continue;
      const args = content.slice(openIdx + 1, closeIdx);
      const parts = splitTopLevel(args, ',');
      let dataArg = null, indexArg = null;
      for (const p of parts) {
        const mi = p.match(/^index\s*=\s*([\s\S]+)$/);
        if (mi) indexArg = mi[1];
        else if (dataArg === null) dataArg = p;
      }
      const rebuilt = indexArg !== null ? `pd_series(${dataArg}, ${indexArg})` : `pd_series(${dataArg})`;
      out += content.slice(last, m.index) + rebuilt;
      last = closeIdx + 1;
      re.lastIndex = closeIdx + 1;
    }
    out += content.slice(last);
    return out;
  }

  function convertSortCalls(content) {
    const re = new RegExp(RECV + '\\.sort\\(', 'g');
    let out = '', last = 0, m;
    while ((m = re.exec(content)) !== null) {
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = findMatchingParen(content, openIdx);
      if (closeIdx === -1) continue;
      const args = content.slice(openIdx + 1, closeIdx);
      let keyFn = 'null', reverse = 'false';
      for (const p of splitTopLevel(args, ',')) {
        const mk = p.match(/^key\s*=\s*([\s\S]+)$/);
        const mr = p.match(/^reverse\s*=\s*([\s\S]+)$/);
        if (mk) keyFn = mk[1];
        if (mr) reverse = mr[1];
      }
      out += content.slice(last, m.index) + `pysortinplace(${m[1]}, ${keyFn}, ${reverse})`;
      last = closeIdx + 1;
      re.lastIndex = closeIdx + 1;
    }
    out += content.slice(last);
    return out;
  }

  /* ───────────────────────── operators ───────────────────────── */

  // Scans one "operand" starting at position i: a parenthesised group, a
  // bracketed group, a masked-string token, or an identifier/number
  // (optional leading unary '-'), followed by any chain of .name / (...)
  // / [...]. Whenever it consumes a paren/bracket group, it recurses
  // `rewrite` into that group's contents first, so an operator *inside* a
  // call or subscript is still found and converted, e.g. the `%` in
  // `print(a[0] % 3)`.
  //
  // This replaces two earlier, both broken, approaches: (1) a flat regex
  // character class that couldn't represent an operand starting with `(`
  // or containing `[...]` at all (producing mangled output), and (2) a
  // non-recursive version of this same scanner that treated any
  // paren/bracket group it consumed as a fully opaque blob - meaning an
  // operator nested inside a call was never reached, so it silently kept
  // running through the engine's native operator instead of the
  // Python-semantics one. That's *worse* than an error for `%`, since
  // JS's native `%` happens to agree with Python's for positive operands
  // (disagreeing only on negative ones) - so plausible-looking test cases
  // could pass by coincidence while the conversion wasn't happening at
  // all. `rewrite` is the enclosing rewriteBinaryOp call, passed in so
  // recursion applies the exact same operator conversion as the caller.
  function scanOperandRec(s, i, rewrite) {
    const n = s.length;
    let text, end;
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i];
      let j = i + 1;
      while (j < n && s[j] !== q) { if (s[j] === '\\') j++; j++; }
      if (j >= n) return null;
      text = s.slice(i, j + 1); end = j + 1;
    } else if (s[i] === '(') {
      const close = findMatchingParen(s, i);
      if (close === -1) return null;
      text = '(' + rewrite(s.slice(i + 1, close)) + ')';
      end = close + 1;
    } else if (s[i] === '[') {
      const close = findMatchingBracket(s, i);
      if (close === -1) return null;
      text = '[' + rewrite(s.slice(i + 1, close)) + ']';
      end = close + 1;
    } else if (s[i] === MASK_OPEN) {
      let j = i + 1;
      while (j < n && s[j] !== MASK_CLOSE) j++;
      if (j >= n) return null;
      text = s.slice(i, j + 1); end = j + 1;
    } else if (/[\w-]/.test(s[i])) {
      let k = i;
      if (s[i] === '-') { if (!/[\w.]/.test(s[i + 1] || '')) return null; k++; }
      const wordStart = k;
      while (k < n && /[\w.]/.test(s[k])) k++;
      if (k === wordStart) return null;
      text = s.slice(i, k); end = k;
    } else return null;
    while (end < n) {
      if (s[end] === '.') {
        let j = end + 1;
        while (j < n && /\w/.test(s[j])) j++;
        if (j === end + 1) break;
        text += s.slice(end, j); end = j;
      } else if (s[end] === '(') {
        const close = findMatchingParen(s, end);
        if (close === -1) break;
        text += '(' + rewrite(s.slice(end + 1, close)) + ')'; end = close + 1;
      } else if (s[end] === '[') {
        const close = findMatchingBracket(s, end);
        if (close === -1) break;
        text += '[' + rewrite(s.slice(end + 1, close)) + ']'; end = close + 1;
      } else break;
    }
    return { text, end };
  }

  // Rewrites every `a OP b` (at any nesting depth - see scanOperandRec)
  // into buildReplacement(aText, bText). Runs to a fixed point (bounded
  // by a guard) so a top-level chain like `a % b % c` - which needs
  // `a % b` rewritten before `(...) % c` can be recognised as an
  // operand-op-operand triple in turn - ends up fully, left-associatively
  // converted.
  function rewriteBinaryOp(content, opStr, notFollowedByChar, buildReplacement, wordBoundary) {
    const self = (s) => rewriteBinaryOp(s, opStr, notFollowedByChar, buildReplacement, wordBoundary);
    let changed = true, guard = 0;
    while (changed && guard++ < 10) {
      changed = false;
      let out = '', i = 0;
      const n = content.length;
      while (i < n) {
        const lhs = scanOperandRec(content, i, self);
        if (!lhs) { out += content[i]; i++; continue; }
        let j = lhs.end;
        while (j < n && content[j] === ' ') j++;
        const afterOp = content[j + opStr.length];
        const matches = content.slice(j, j + opStr.length) === opStr &&
          (!notFollowedByChar || afterOp !== notFollowedByChar) &&
          (!wordBoundary || !/\w/.test(afterOp || ''));
        if (matches) {
          let k = j + opStr.length;
          while (k < n && content[k] === ' ') k++;
          const rhs = scanOperandRec(content, k, self);
          if (rhs) {
            out += buildReplacement(lhs.text, rhs.text);
            i = rhs.end;
            changed = true;
            continue;
          }
        }
        out += lhs.text;
        i = lhs.end;
      }
      content = out;
    }
    return content;
  }

  // "%s" % value / "%s %s" % (a, b) - Python's %-formatting operator.
  // Checks whether the LEFT operand of `%` is a compile-time-known
  // string literal; if so, expands it into the same kind of concatenated
  // pystr()/pyint()/pyfixed() expression convertFormatMethod builds for
  // .format() literals. If the left side isn't a literal (or contains no
  // %-directives), this falls through to ordinary modulo - `x % y` for
  // two numbers works exactly as before.
  function buildPercentFormat(literal, argsRaw, store) {
    let argsList;
    if (/^[([]/.test(argsRaw) && /[)\]]$/.test(argsRaw)) {
      argsList = splitTopLevel(argsRaw.slice(1, -1), ',');
      if (argsList.length === 1 && argsList[0].trim() === '') argsList = [];
    } else {
      argsList = [argsRaw];
    }
    const parts = [];
    let ai = 0, i = 0;
    while (i < literal.length) {
      if (literal[i] === '%' && literal[i + 1] === '%') { parts.push(pushMasked(store, jsQuote('%'))); i += 2; continue; }
      if (literal[i] === '%') {
        const mm = literal.slice(i).match(/^%[-+0 ]?\d*(?:\.(\d+))?[sdifr]/);
        if (mm) {
          const type = mm[0][mm[0].length - 1];
          const prec = mm[1];
          const argExpr = argsList[ai++];
          if (type === 'd' || type === 'i') parts.push(`pystr(pyint(${argExpr}))`);
          else if (type === 'f') parts.push(`pyfixed(${argExpr}, ${prec !== undefined ? prec : 6})`);
          else parts.push(`pystr(${argExpr})`);
          i += mm[0].length;
          continue;
        }
      }
      let j = i;
      while (j < literal.length && literal[j] !== '%') j++;
      parts.push(pushMasked(store, jsQuote(literal.slice(i, j))));
      i = j;
    }
    return parts.length ? '(' + parts.join(' + ') + ')' : '""';
  }

  function convertDivMod(content, store) {
    // true division: a / b  -> truediv(a, b)   (but never `//`)
    content = rewriteBinaryOp(content, '/', '/', (a, b) => `truediv(${a}, ${b})`);
    // `%` - either Python modulo (floor-based sign) or %-string-formatting,
    // depending on whether the left operand is a known string literal.
    content = rewriteBinaryOp(content, '%', null, (a, b) => {
      const literal = store ? literalStringValue(a, store) : null;
      if (literal !== null && /%[-+0 ]?\d*(?:\.\d+)?[sdifr%]/.test(literal)) return buildPercentFormat(literal, b, store);
      return `pymod(${a}, ${b})`;
    });
    return content;
  }

  // Python chains comparisons: `a <= b <= c` means `(a <= b) and (b <= c)`,
  // each operand evaluated once. This engine's native comparison operators
  // are flat and left-associative like C/JS - exactly right for a single
  // comparison, but `a <= b <= c` would otherwise become `(a <= b) <= c`,
  // silently comparing a boolean against c instead of raising an error.
  // That's the actual bug behind "0" <= char <= "9" always giving the
  // wrong answer rather than failing loudly.
  //
  // Only rewrites when 2+ comparators chain together (a single `a <= b`
  // is left completely untouched, still handled natively); only the six
  // symbolic comparators chain here (`in`/`is` chains are rare and
  // already handled at a different pipeline stage). Reuses
  // scanOperandRec, so a comparator buried inside a call/subscript is
  // still found the same way convertDivMod's operands are. One accepted
  // trade-off: middle operands are evaluated twice in the expanded form
  // (`b` appears in both `a <= b` and `b <= c`) - fine for the
  // overwhelmingly common case of comparing plain values, but means a
  // chained comparison with a side-effecting call in the middle (rare)
  // would run that call twice.
  function convertChainedComparisons(content) {
    const COMPARATORS = ['<=', '>=', '==', '!=', '<', '>'];
    function matchComparator(s, pos) {
      for (const op of COMPARATORS) if (s.slice(pos, pos + op.length) === op) return op;
      return null;
    }
    const self = (s) => convertChainedComparisons(s);
    let changed = true, guard = 0;
    while (changed && guard++ < 10) {
      changed = false;
      let out = '', i = 0;
      const n = content.length;
      while (i < n) {
        const first = scanOperandRec(content, i, self);
        if (!first) { out += content[i]; i++; continue; }
        const operands = [first.text];
        const ops = [];
        let pos = first.end;
        while (true) {
          let j = pos;
          while (j < n && content[j] === ' ') j++;
          const op = matchComparator(content, j);
          if (!op) break;
          let k = j + op.length;
          while (k < n && content[k] === ' ') k++;
          const next = scanOperandRec(content, k, self);
          if (!next) break;
          ops.push(op);
          operands.push(next.text);
          pos = next.end;
        }
        if (ops.length >= 2) {
          const parts = [];
          for (let k = 0; k < ops.length; k++) parts.push(`(${operands[k]} ${ops[k]} ${operands[k + 1]})`);
          out += parts.join(' and ');
          i = pos;
          changed = true;
          continue;
        }
        out += first.text;
        i = first.end;
      }
      content = out;
    }
    return content;
  }

  function convertMembership(content) {
    content = content.replace(/\bnot\s+in\b/g, '\u0001NOTIN\u0001');
    content = rewriteBinaryOp(content, '\u0001NOTIN\u0001', null, (a, b) => `(not pyin(${a}, ${b}))`);
    content = rewriteBinaryOp(content, 'in', null, (a, b) => `pyin(${a}, ${b})`, true);
    return content;
  }

  function convertIdentity(content) {
    content = content.replace(/\bis\s+not\b/g, '!=');
    content = content.replace(/\bis\b/g, '==');
    return content;
  }

  /* ───────────────────────── tuple unpacking ───────────────────────── */

  function convertUnpacking(content) {
    let text = content;
    // (a, b) = expr / (a, *b) = expr - same as the bare form below, just
    // wrapped in parens; unwrap before the real pattern match.
    const parenM = text.match(/^\(([^()]+)\)\s*=\s*([^=].*)$/);
    if (parenM && /^(?:\*?[A-Za-z_]\w*)(?:\s*,\s*\*?[A-Za-z_]\w*)+,?$/.test(parenM[1].trim())) {
      text = `${parenM[1].trim().replace(/,$/, '')} = ${parenM[2]}`;
    }
    const m = text.match(/^((?:\*?[A-Za-z_]\w*)(?:\s*,\s*\*?[A-Za-z_]\w*)+)\s*=\s*([^=].*)$/);
    if (!m) return null;
    const rawTargets = m[1].split(',').map(s => s.trim());
    const starTargets = rawTargets.filter(t => t.startsWith('*'));
    if (starTargets.length > 1) unsupported('Multiple starred targets in one unpacking assignment', 'Python itself only allows one');
    const starIdx = rawTargets.findIndex(t => t.startsWith('*'));

    const tmp = '__unpack';
    let rhsText = m[2].trim();
    if (splitTopLevel(convertTupleLiterals(rhsText), ',').length > 1) rhsText = '[' + rhsText + ']';
    const lines = [`${tmp} = ${transformExpression(rhsText)};`];
    if (starIdx === -1) {
      rawTargets.forEach((t, i) => lines.push(`${t} = ${tmp}[${i}];`));
    } else {
      const before = rawTargets.slice(0, starIdx);
      const starName = rawTargets[starIdx].slice(1);
      const after = rawTargets.slice(starIdx + 1);
      before.forEach((t, i) => lines.push(`${t} = ${tmp}[${i}];`));
      if (after.length === 0) {
        lines.push(`${starName} = ${tmp}.slice(${before.length});`);
      } else {
        lines.push(`${starName} = ${tmp}.slice(${before.length}, len(${tmp}) - ${after.length});`);
        after.forEach((t, i) => lines.push(`${t} = ${tmp}[len(${tmp}) - ${after.length - i}];`));
      }
    }
    return lines;
  }

  /* ───────────────────────── def params ─────────────────────────
     canonical function params are bare names with no default-value
     syntax at all, so defaults are applied via a body preamble instead
     (the engine already fills missing call args with null). */

  function transformDefParams(paramsStr) {
    const parts = splitTopLevel(paramsStr, ',');
    const names = [];
    for (let p of parts) {
      p = p.trim();
      if (!p) continue;
      if (p.startsWith('*')) unsupported('*args / **kwargs', 'the engine only supports fixed-arity functions');
      let name = p, def = null;
      const eq = splitTopLevel(p, '=');
      if (eq.length > 1) { name = eq[0]; def = eq.slice(1).join('='); }
      name = name.split(':')[0].trim();
      names.push(def !== null ? `${name} = ${transformExpression(def)}` : name);
    }
    return { params: names.join(', '), preamble: '' };
  }

  /* ───────────────────────── main transpiler ───────────────────────── */

  // Shared with compileHeader (for `match`/`case`, below) - gives each
  // `match` statement its own uniquely-named subject variable so nested
  // match statements can't shadow one another. Reset per toCanonical()
  // call so numbering doesn't grow unbounded across repeated runs.
  let matchCounter = 0;
  // Tracks `import numpy as X` so `X.arange(...)` etc. can be rewritten
  // the same way `numpy.arange(...)` is - nobody writes bare `numpy.`,
  // `as np` is the near-universal convention. Defaults to the literal
  // module name so plain `import numpy` (no alias) still works.
  let numpyAlias = 'numpy';
  let pandasAlias = 'pandas';
  // Shared (read-only from compileHeader/transformStatement's side)
  // references to toCanonical's own rawLines/blockStack - needed so a
  // `def` header can look ahead into its own body for a `yield`
  // statement (to decide whether it's a generator function), and so
  // `return`/`yield` compilation can find the nearest enclosing function
  // and check that same flag. blockStackRef is reassigned to *the same
  // array object* toCanonical's main loop pushes/pops - not a copy - so
  // mutations there are visible here automatically.
  let rawLinesRef = [];
  let blockStackRef = [null];
  let currentPyLine = 0;
  let currentIndent = 0;

  function toCanonical(src) {
    src = src.replace(/\t/g, '    ').replace(/\r\n?/g, '\n');
    matchCounter = 0;
    numpyAlias = 'numpy';
    pandasAlias = 'pandas';
    const rawLines = joinContinuationLines(src.split('\n'));
    rawLinesRef = rawLines;
    const out = [];
    const indentStack = [0];
    const blockStack = [null];
    blockStackRef = blockStack;
    let pendingBlock = null;
    let inMultiline = false, multilineQuote = null;

    function emit(line) { out.push(line); }

    function closeBlocksTo(indent) {
      while (indent < indentStack[indentStack.length - 1]) {
        indentStack.pop();
        const popped = blockStack.pop();
        if (popped && popped.kind === 'function' && popped.isGenerator) emit('return __gen;');
        emit('}');
      }
    }

    function hasFollowingContinuation(fromLine, indent) {
      for (let k = fromLine + 1; k < rawLines.length; k++) {
        const stripped = stripComment(rawLines[k]);
        if (stripped.trim() === '') continue;
        const ind = stripped.match(/^(\s*)/)[0].length;
        if (ind !== indent) return false;
        return /^(elif|else|except|finally|case)\b/.test(stripped.trim());
      }
      return false;
    }

    function countExceptClauses(fromLine, indent) {
      let count = 0;
      for (let k = fromLine + 1; k < rawLines.length; k++) {
        const stripped = stripComment(rawLines[k]);
        if (stripped.trim() === '') continue;
        const ind = stripped.match(/^(\s*)/)[0].length;
        if (ind < indent) break;
        if (ind > indent) continue; // inside a block body, skip
        if (/^except\b/.test(stripped.trim())) { count++; continue; }
        if (/^finally\b/.test(stripped.trim())) continue;
        break;
      }
      return count;
    }

    for (let pyLine = 0; pyLine < rawLines.length; pyLine++) {
      const raw = rawLines[pyLine];

      if (inMultiline) {
        const q = multilineQuote;
        if (raw.includes(q)) {
          const idx = raw.indexOf(q);
          emit(escapeMultilineChunk(raw.slice(0, idx)) + '"' + (raw.slice(idx + 3) ? ';' : ''));
          inMultiline = false; multilineQuote = null;
          continue;
        }
        emit(escapeMultilineChunk(raw));
        continue;
      }

      let line = stripComment(raw);
      if (line.trim() === '') { emit(''); continue; }

      const indent = line.match(/^(\s*)/)[0].length;
      let content = line.slice(indent);

      let openedTriple = false;
      for (const q of ['"""', "'''"]) {
        if (countOccurrences(content, q) % 2 === 1) {
          closeBlocksTo(indent);
          const idx = content.indexOf(q);
          emit(' '.repeat(indent) + content.slice(0, idx) + '"' + escapeMultilineChunk(content.slice(idx + 3)));
          inMultiline = true; multilineQuote = q; pendingBlock = null; openedTriple = true;
          break;
        }
      }
      if (openedTriple) continue;

      content = content.replace(/"""([\s\S]*?)"""/g, (m, inner) => jsQuote(inner));
      content = content.replace(/'''([\s\S]*?)'''/g, (m, inner) => jsQuote(inner));

      closeBlocksTo(indent);

      if (indent > indentStack[indentStack.length - 1]) {
        indentStack.push(indent);
        blockStack.push(pendingBlock || { kind: 'other' });
        pendingBlock = null;
      }

      const trimmed = content.trim();
      const enclosingBlock = blockStack[blockStack.length - 1] || null;
      const continues = hasFollowingContinuation(pyLine, indent);
      currentPyLine = pyLine;
      currentIndent = indent;

      if (/^try\s*:$/.test(trimmed)) {
        const exceptCount = countExceptClauses(pyLine, indent);
        if (exceptCount > 1) {
          throw new UnsupportedError(`Line ${pyLine + 1}: Multiple \`except\` clauses on one \`try\` are not supported (the engine's grammar only allows a single catch per try) - combine them into one \`except:\` block.\n    ${trimmed}`);
        }
      }

      let result;
      try {
        result = compileStatement(trimmed, enclosingBlock, continues);
      } catch (e) {
        if (e instanceof UnsupportedError) {
          throw new UnsupportedError(`Line ${pyLine + 1}: ${e.message}\n    ${trimmed}`);
        }
        throw e;
      }

      if (result.opensBlock) pendingBlock = result.blockInfo;
      if (result.selfPush) { indentStack.push(indent + 0.5); blockStack.push(result.blockInfo || { kind: 'other' }); }

      for (const codeLine of result.lines) emit(' '.repeat(indent) + codeLine);
    }

    closeBlocksTo(0);
    return PRELUDE + '\n' + out.join('\n') + '\n';
  }

  function compileStatement(stmt, enclosingBlock, continues) {
    const enclosingKind = enclosingBlock ? enclosingBlock.kind : null;
    const HEADER_RE = /^(if|elif|else|while|for|def|try|except|finally|class|match|case|with)\b/;
    if (/^lambda\s/.test(stmt)) {
      unsupported('`lambda` as its own statement', 'not representable in the engine\'s grammar - assign it to a name first, or use it inline as an expression');
    }
    if (/^\s*(global|nonlocal)\b/.test(stmt)) return { lines: [], opensBlock: false };
    if (/^@/.test(stmt)) {
      let name = stmt.slice(1).trim();
      // strip a decorator call's arguments, e.g. @app.route("/x") -> @app.route
      // (we only act on staticmethod/classmethod/property/x.setter; anything
      // else is passed through and simply has no effect, matching how the
      // engine's parser treats unrecognised decorators)
      const callIdx = name.indexOf('(');
      if (callIdx !== -1) name = name.slice(0, callIdx);
      return { lines: [`@${name}`], opensBlock: false };
    }

    if (HEADER_RE.test(stmt)) {
      const colonIdx = findHeaderColon(stmt);
      if (colonIdx === -1) return { lines: [transformExpression(stmt) + ';'], opensBlock: false };
      const header = stmt.slice(0, colonIdx);
      const restRaw = stmt.slice(colonIdx + 1).trim();
      const headerType = header.match(/^\w+/)[0];
      const headerResult = compileHeader(header, enclosingBlock);

      if (restRaw) {
        const bodyLines = splitTopLevel(restRaw, ';').flatMap(p => compileStatement(p.trim(), null, false).lines);
        const canContinue = ['if', 'elif', 'while', 'for', 'case'].includes(headerType);
        if (canContinue && continues) {
          return { lines: [headerResult.code, ...bodyLines], opensBlock: false, selfPush: true, blockInfo: { kind: 'oneliner' } };
        }
        return { lines: [headerResult.code, ...bodyLines, '}'], opensBlock: false };
      }
      return { lines: [headerResult.code], opensBlock: true, blockInfo: headerResult.blockInfo };
    }

    if (splitTopLevel(stmt, ';').length > 1) {
      return { lines: splitTopLevel(stmt, ';').flatMap(s => compileStatement(s.trim(), enclosingBlock, false).lines), opensBlock: false };
    }

    return { lines: transformStatement(stmt), opensBlock: false };
  }

  function findHeaderColon(stmt) {
    let depth = 0, inStr = null, escape = false;
    for (let i = 0; i < stmt.length; i++) {
      const c = stmt[i];
      if (escape) { escape = false; continue; }
      if (inStr) { if (c === '\\') escape = true; else if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'") { inStr = c; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ':' && stmt[i + 1] !== '=' && depth === 0) return i;
    }
    return -1;
  }

  // Compiles one `case` pattern into a boolean expression testing `subj`
  // (the match statement's subject variable, or a subscript of it for
  // nested sequence elements). Supported: wildcard `_`, capture names
  // (`case x:`), literals/values via plain `==` (numbers, strings,
  // True/False/None, dotted constants, negative numbers - anything that
  // isn't a bare name is just compared as a value), `|` alternatives, and
  // fixed-length sequence patterns `(a, b)` / `[a, b]` / bare `a, b`
  // (recursing into each element, so nesting works). Mapping patterns
  // (`{...}`) and class patterns (`Point(x=0, y=0)`) are NOT supported -
  // rewrite those as a guard instead (`case _ if isinstance(x, Point) and
  // x.x == 0:`), same trade-off this engine already makes for other
  // advanced-but-rare Python features.
  //
  // Captures bind via `:=` (the same walrus/assignment-expression support
  // added earlier) wrapped as `((name := value) || true)` - `|| true`
  // (not `&&`) is deliberate: it must always evaluate to true *after*
  // performing the assignment, regardless of whether the captured value
  // itself happens to be falsy (0, '', false, ...), or a falsy-but-valid
  // capture would wrongly look like a failed match.
  function compileMatchPattern(patternText, subj) {
    const text = patternText.trim();
    if (text === '_') return 'true';

    const alts = splitTopLevel(text, '|');
    if (alts.length > 1) {
      return '(' + alts.map(a => compileMatchPattern(a, subj)).join(' || ') + ')';
    }

    if (/^[A-Za-z_]\w*$/.test(text) && !['True', 'False', 'None'].includes(text)) {
      return `((${text} := ${subj}) || true)`;
    }

    let elementsText = null;
    if (text.startsWith('(') && findMatchingParen(text, 0) === text.length - 1) elementsText = text.slice(1, -1);
    else if (text.startsWith('[') && findMatchingBracket(text, 0) === text.length - 1) elementsText = text.slice(1, -1);
    else if (splitTopLevel(text, ',').length > 1) elementsText = text;

    if (elementsText !== null) {
      const elements = splitTopLevel(elementsText, ',');
      if (elements.some(e => e.trim().startsWith('*'))) {
        unsupported('`*rest` inside a sequence pattern', 'this engine only supports fixed-length sequence patterns');
      }
      const checks = [`(pytype(${subj}) == "<class 'list'>" && len(${subj}) == ${elements.length})`,
        ...elements.map((el, i) => compileMatchPattern(el, `${subj}[${i}]`))];
      return '(' + checks.join(' && ') + ')';
    }

    if (/^\{/.test(text)) unsupported('mapping patterns in `case`', 'use a guard instead, e.g. `case _ if key in d:`');
    if (/^[A-Za-z_][\w.]*\s*\(/.test(text)) unsupported('class patterns in `case`', 'use a guard instead, e.g. `case _ if isinstance(x, Point):`');

    return `(${subj} == (${transformExpression(text)}))`;
  }

  // Does this `def`'s immediate body contain a `yield` statement (making
  // it a generator function)? Skips over any nested def/class's own body
  // (a yield in a nested function doesn't make the outer one a
  // generator). Only bare `yield EXPR` / `yield` as their own statement
  // are recognized - not `x = yield EXPR` (two-way generators, sending
  // values back in via .send(), are out of scope: this engine has no
  // suspend/resume execution at all, so generator functions are instead
  // eagerly run to completion, collecting every yielded value into a
  // list - see the def branch below and the yield/return handling in
  // transformStatement).
  function defBodyContainsYield(fromLine, defIndent) {
    let skipUntilIndent = -1;
    for (let k = fromLine + 1; k < rawLinesRef.length; k++) {
      const stripped = stripComment(rawLinesRef[k]);
      if (stripped.trim() === '') continue;
      const ind = stripped.match(/^(\s*)/)[0].length;
      if (ind <= defIndent) break;
      if (skipUntilIndent !== -1) { if (ind <= skipUntilIndent) skipUntilIndent = -1; else continue; }
      const trimmed = stripped.trim();
      if (/^(def|class)\s+/.test(trimmed)) { skipUntilIndent = ind; continue; }
      if (/^yield\b/.test(trimmed)) return true;
    }
    return false;
  }

  // Searches the live block stack (innermost first) for the nearest
  // enclosing function, returning whether it's a generator. Used by
  // `return`/`yield` compilation, which need to know this regardless of
  // how many if/for/while blocks they're nested inside within that
  // function.
  function nearestEnclosingIsGenerator() {
    for (let i = blockStackRef.length - 1; i >= 0; i--) {
      const b = blockStackRef[i];
      if (b && b.kind === 'function') return !!b.isGenerator;
    }
    return false;
  }

  function compileHeader(header, enclosingBlock) {
    let m;
    if ((m = header.match(/^if\s+([\s\S]+)$/))) return { code: `if (${transformExpression(m[1])}) {`, blockInfo: { kind: 'other' } };
    if ((m = header.match(/^elif\s+([\s\S]+)$/))) return { code: `else if (${transformExpression(m[1])}) {`, blockInfo: { kind: 'other' } };
    if (header.match(/^else\s*$/)) return { code: `else {`, blockInfo: { kind: 'other' } };
    if ((m = header.match(/^while\s+([\s\S]+)$/))) return { code: `while (${transformExpression(m[1])}) {`, blockInfo: { kind: 'other' } };

    // with EXPR [as NAME][, EXPR [as NAME] ...]: → { let NAME = (EXPR); ...
    // This sandbox has no real closeable resources (no file handles,
    // sockets, or threads), so there's nothing meaningful for an
    // __enter__/__exit__ protocol to actually manage - `with` here is
    // just a scoped binding, same as `match`'s wrapper block. If a
    // genuine resource-cleanup use case ever needs `__exit__` to actually
    // run, that would be a deliberate follow-up, not an oversight.
    if ((m = header.match(/^with\s+([\s\S]+)$/))) {
      const lets = splitTopLevel(m[1], ',').map(clause => {
        const asIdx = findTopLevelKeyword(clause, 'as');
        if (asIdx === -1) return `(${transformExpression(clause.trim())});`;
        const exprText = clause.slice(0, asIdx).trim();
        const nameText = clause.slice(asIdx + 2).trim();
        return `let ${nameText} = (${transformExpression(exprText)});`;
      });
      return { code: `{ ${lets.join(' ')}`, blockInfo: { kind: 'other' } };
    }

    // match EXPR: → { let __matchN = (EXPR);   (a plain wrapper block that
    // scopes the subject variable; each `case` below becomes an if/else-if
    // inside it, and the wrapper's own closing `}` falls out for free from
    // the normal indent-based block-closing, exactly like every other
    // block here - no special-casing needed for the extra brace.)
    if ((m = header.match(/^match\s+([\s\S]+)$/))) {
      const subjectVar = `__match${matchCounter++}`;
      const subjectExpr = transformExpression(m[1]);
      return { code: `{ let ${subjectVar} = (${subjectExpr});`, blockInfo: { kind: 'match', subjectVar, caseSeen: false } };
    }

    // case PATTERN [if GUARD]: → if/else-if against the enclosing match's
    // subject variable. Every clause uses the same `case` keyword (unlike
    // if/elif/else, which disambiguate themselves), so "is this the first
    // case" is tracked with a flag on the enclosing match's own blockInfo
    // object - the same object stays on top of the block stack for every
    // sibling `case` at this indent, so mutating it here is visible next
    // time a sibling case is compiled.
    if ((m = header.match(/^case\s+([\s\S]+)$/))) {
      if (!enclosingBlock || enclosingBlock.kind !== 'match') {
        unsupported('`case` outside a `match` block', 'a `case` clause must be directly inside a `match` statement');
      }
      const subjectVar = enclosingBlock.subjectVar;
      const body = m[1].trim();
      const ifIdx = findTopLevelKeyword(body, 'if');
      const patternText = (ifIdx === -1 ? body : body.slice(0, ifIdx)).trim();
      const guardText = ifIdx === -1 ? null : body.slice(ifIdx + 2).trim();
      const patternTest = compileMatchPattern(patternText, subjectVar);
      const guardExpr = guardText ? `(${transformExpression(guardText)})` : 'true';
      const cond = `(${patternTest} && ${guardExpr})`;
      const isFirst = !enclosingBlock.caseSeen;
      enclosingBlock.caseSeen = true;
      return { code: `${isFirst ? 'if' : 'else if'} (${cond}) {`, blockInfo: { kind: 'other' } };
    }

    if ((m = header.match(/^for\s+([\s\S]+?)\s+in\s+([\s\S]+)$/))) {
      const targetRaw = m[1].trim();
      const iterExpr = transformExpression(m[2]);
      if (targetRaw.includes(',')) {
        const names = targetRaw.split(',').map(s => s.trim());
        const preamble = names.map((n, i) => `${n} = __tup[${i}];`).join(' ');
        return { code: `for (__tup in ${iterExpr}) { ${preamble}`, blockInfo: { kind: 'for-unpack' } };
      }
      return { code: `for (${targetRaw} in ${iterExpr}) {`, blockInfo: { kind: 'other' } };
    }

    if (header.match(/^try\s*$/)) return { code: `try {`, blockInfo: { kind: 'try' } };
    if ((m = header.match(/^except\s*([\s\S]*)$/))) {
      const spec = m[1].trim();
      const asMatch = spec.match(/^([\s\S]+?)\s+as\s+([A-Za-z_]\w*)$/);
      const alias = asMatch ? asMatch[2] : null;
      // NOTE: exception *type* is not checked - the engine has no
      // exception-type model, so every except clause here behaves like
      // a bare `except:` that catches anything. Only one except clause
      // per try is supported (checked earlier, at the `try:` line).
      // The exception is always bound to __err internally (in addition
      // to any `as name` alias) so a bare `raise` (re-raise) inside the
      // except block can reliably reference the current exception.
      return { code: `catch (__err) {${alias ? ` ${alias} = __err;` : ''}`, blockInfo: { kind: 'other' } };
    }
    if (header.match(/^finally\s*$/)) return { code: `finally {`, blockInfo: { kind: 'other' } };

    if ((m = header.match(/^class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?$/))) {
      const [, name, basesRaw] = m;
      const bases = basesRaw ? splitTopLevel(basesRaw, ',').map(b => b.trim()).filter(b => b && !b.includes('=')) : [];
      return { code: `class ${name}${bases.length ? '(' + bases.join(', ') + ')' : ''} {`, blockInfo: { kind: 'class', name } };
    }

    if ((m = header.match(/^def\s+([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*(?:->\s*[^:]+)?$/))) {
      const [, name, paramsRaw] = m;
      const { params, preamble } = transformDefParams(paramsRaw);
      const isGenerator = defBodyContainsYield(currentPyLine, currentIndent);
      const genInit = isGenerator ? ' let __gen = [];' : '';
      return { code: `function ${name}(${params}) {${preamble ? ' ' + preamble : ''}${genInit}`, blockInfo: { kind: 'function', name, isGenerator } };
    }

    unsupported(`\`${header.trim()}\``, 'unrecognised statement header');
  }

  function transformStatement(stmt) {
    if (/^return\b/.test(stmt)) {
      const rest = stmt.replace(/^return\s*/, '').trim();
      if (rest) return [`return ${transformExpression(rest)};`];
      return [nearestEnclosingIsGenerator() ? 'return __gen;' : 'return;'];
    }
    // Generator functions here are eagerly run to completion rather than
    // suspended/resumed (this engine has no coroutine machinery at all),
    // collecting every yielded value into the enclosing function's
    // `__gen` array (declared by the def branch in compileHeader, and
    // implicitly returned when the function body ends - see
    // closeBlocksTo). That means a generator produces its full sequence
    // up front the moment it's called, rather than lazily on each
    // `next()` - fine for the overwhelmingly common case of iterating a
    // bounded generator with a for-loop or list()/join(), wrong for an
    // intentionally-infinite generator (which would just hang) or one
    // relying on two-way communication via `x = yield ...` (not
    // recognized at all - only bare `yield expr` / `yield` as their own
    // statement are).
    if (/^yield\b/.test(stmt)) {
      const rest = stmt.replace(/^yield\s*/, '').trim();
      return [`__gen.push(${rest ? transformExpression(rest) : 'null'});`];
    }
    if (/^pass\s*$/.test(stmt)) return [';'];
    if (/^break\s*$/.test(stmt)) return ['break;'];
    if (/^continue\s*$/.test(stmt)) return ['continue;'];
    if (/^assert\s+/.test(stmt)) {
      const rest = stmt.replace(/^assert\s*/, '');
      const parts = splitTopLevel(rest, ',');
      const cond = transformExpression(parts[0]);
      const msg = parts[1] ? transformExpression(parts[1]) : jsQuote('Assertion failed: ' + parts[0]);
      return [`if (not (${cond})) { throw ${msg}; }`];
    }
    if (/^del\s+/.test(stmt)) {
      const rest = stmt.replace(/^del\s*/, '');
      const lines = [];
      for (const target of splitTopLevel(rest, ',')) {
        const m = target.trim().match(/^([\s\S]+)\[([\s\S]+)\]$/);
        if (!m) unsupported('`del`', 'only `del container[key]` is supported (deleting a whole variable is a no-op in this grammar)');
        lines.push(`pydel(${transformExpression(m[1])}, ${transformExpression(m[2])});`);
      }
      return lines;
    }
    if (/^(import|from)\s+/.test(stmt)) {
      const ALLOWED = new Set(['math', 'random', 'json', 'string', 'collections', 'functools', 'base64', 'sys', 'importlib', 'operator', 're', 'ast', 'itertools', 'concurrent', 'numpy', 'pandas', 'io', 'urllib', 'builtins']);
      const m = stmt.match(/^import\s+([\w.]+)/) || stmt.match(/^from\s+([\w.]+)\s+import/);
      const moduleName = m ? m[1].split('.')[0] : null;
      if (moduleName === 'numpy') {
        const aliasMatch = stmt.match(/^import\s+numpy\s+as\s+([A-Za-z_]\w*)\s*$/);
        numpyAlias = aliasMatch ? aliasMatch[1] : 'numpy';
      }
      if (moduleName === 'pandas') {
        const aliasMatch = stmt.match(/^import\s+pandas\s+as\s+([A-Za-z_]\w*)\s*$/);
        pandasAlias = aliasMatch ? aliasMatch[1] : 'pandas';
      }
      if (moduleName === '__hello__') {
        // a real, if silly, CPython easter egg module: importing it prints
        // "Hello world!" - reproduced here since it's genuinely all it does.
        return [`print(pystr(${jsQuote('Hello world!')}));`];
      }
      if (moduleName && !ALLOWED.has(moduleName)) {
        unsupported(
          `\`import ${moduleName}\``,
          `only a small curated set of stdlib helpers is available here (${Array.from(ALLOWED).join(', ')}), each mapped onto engine builtins - there's no real filesystem, network, OS, GUI, or C-extension access in this sandbox, and third-party packages (numpy, pandas, requests, etc.) can't be installed at all`
        );
      }
      return [''];
    }
    if (/^importlib\.import_module\(/.test(stmt)) {
      const m = stmt.match(/^importlib\.import_module\((["'])(.*?)\1\)\s*$/);
      if (m && m[2] === '__hello__') return [`print(pystr(${jsQuote('Hello world!')}));`];
      unsupported('importlib.import_module() for anything other than "__hello__"', 'there are no real importable module objects in this sandbox - only the fixed set of stdlib shims already listed');
    }
    if (/^exec\(/.test(stmt)) {
      const openIdx = stmt.indexOf('(');
      const closeIdx = findMatchingParen(stmt, openIdx);
      if (closeIdx === -1 || stmt.slice(closeIdx + 1).trim() !== '') unsupported('exec() with anything other than a single source-string argument', 'only exec(some_string) is supported');
      const argText = stmt.slice(openIdx + 1, closeIdx);
      const litMatch = argText.match(/^(["'])([\s\S]*)\1$/);
      if (litMatch) {
        const literal = literalStringValue(litMatch[0], null);
        if (literal !== null) {
          const execLines = literal.split('\n').filter(l => l.trim() !== '');
          return execLines.flatMap(l => compileStatement(l.trim(), null, false).lines);
        }
      }
      // Not a plain literal (an f-string, a variable, a concatenation,
      // ...) - the source text isn't known until runtime, so hand it to
      // pyexec(), which transpiles and runs it right then, in the
      // current scope (so e.g. `exec("x = 5")` followed by `print(x)`
      // works, matching Python's own default exec() behavior).
      return [`pyexec(${transformExpression(argText)});`];
    }
    if (/^raise\b/.test(stmt)) {
      const rest = stmt.replace(/^raise\s*/, '').trim();
      if (!rest) return [`throw __err;`]; // bare re-raise (see except-clause note above)
      // raise Exception("msg") / raise ValueError("msg") / raise "msg" -> throw the message
      const callMatch = rest.match(/^[A-Za-z_]\w*\(([\s\S]*)\)$/);
      const msgExpr = callMatch ? (callMatch[1].trim() || jsQuote('Error')) : rest;
      return [`throw ${transformExpression(msgExpr)};`];
    }

    // tuple-unpacking assignment: a, b = b, a  (checked first since the
    // single-target regex below can't match a comma-separated LHS)
    const unpacked = convertUnpacking(stmt);
    if (unpacked) return unpacked;

    // simple assignment: NAME = EXPR  (comprehension-aware)
    const assignMatch = stmt.match(/^([A-Za-z_]\w*(?:\[[^\]]*\])?)\s*=\s*(?!=)([\s\S]+)$/);
    if (assignMatch) {
      const [, target, rhs] = assignMatch;
      const compre = expandComprehension(target, rhs.trim());
      if (compre) return compre;
      return [`${target} = ${transformExpression(rhs)};`];
    }
    // augmented assignment a += b  etc (already valid canonical syntax)
    const augMatch = stmt.match(/^([A-Za-z_]\w*(?:\[[^\]]*\])?)\s*([+\-*\/%]|\*\*)=\s*([\s\S]+)$/);
    if (augMatch) {
      const [, target, op, rhs] = augMatch;
      if (op === '/') return [`${target} = truediv(${target}, ${transformExpression(rhs)});`];
      if (op === '%') return [`${target} = pymod(${target}, ${transformExpression(rhs)});`];
      return [`${target} ${op}= ${transformExpression(rhs)};`];
    }

    return [transformExpression(stmt) + ';'];
  }

  // lambda params: expr  ->  function(params) { return (expr); }
  // Must run BEFORE string masking - it recursively calls transformExpression
  // on the extracted body, which does its own independent masking pass, and
  // feeding it already-masked text would break (the placeholder chars would
  // just get treated as inert operand text with no matching store entry).
  function convertLambdas(content) {
    let out = '', i = 0;
    while (i < content.length) {
      if (content.slice(i, i + 6) === 'lambda' && !/\w/.test(content[i - 1] || '') && !/\w/.test(content[i + 6] || '')) {
        let j = i + 6;
        while (j < content.length && content[j] !== ':') j++;
        const params = content.slice(i + 6, j).trim();
        j++; // skip ':'
        let depth = 0, inStr = null, escape = false, k = j;
        for (; k < content.length; k++) {
          const c = content[k];
          if (inStr) {
            if (escape) { escape = false; continue; }
            if (c === '\\') { escape = true; continue; }
            if (c === inStr) inStr = null;
            continue;
          }
          if (c === '"' || c === "'") { inStr = c; continue; }
          if (c === '(' || c === '[' || c === '{') depth++;
          else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
          else if (c === ',' && depth === 0) break;
        }
        const body = content.slice(j, k).trim();
        const { params: paramsCode, preamble } = transformDefParams(params);
        // Only convertLambdas recurses here (for nested lambdas the outer
        // single left-to-right scan would otherwise skip over) - NOT the
        // full transformExpression. Every other stage (convertTernary,
        // convertDivMod, convertMembership, ...) still gets exactly one
        // pass over this body, via the outer pipeline's own natural
        // continuation once this spliced-in text becomes part of its
        // `content` again. Calling the full pipeline here too would mean
        // e.g. convertTernary runs once now AND once more later on its
        // own already-converted output (which by then contains a real
        // `if (...) { } else { }` block) - mistaking that for another
        // ternary and mangling it, which is exactly what used to happen
        // with any ternary inside a lambda body.
        out += `function(${paramsCode}) {${preamble ? ' ' + preamble : ''} return (${convertLambdas(body)}); }`;
        i = k;
        continue;
      }
      out += content[i];
      i++;
    }
    return out;
  }

  function pushMasked(store, quotedText) {
    store.push(quotedText);
    return MASK_OPEN + (store.length - 1) + MASK_CLOSE;
  }

  // %-string-formatting ("text %s" % args) is now handled inside
  // convertDivMod's `%` operator handling (see buildPercentFormat there) -
  // merged in specifically so it reuses the same properly nested-parens-
  // aware operand scanner as ordinary modulo, instead of duplicating a
  // second, less capable pattern here.

  // "{} and {}".format(a, b) / "{0} {1}".format(a,b) / "{name}".format(name=x)
  // Same compile-time-literal approach.
  function convertFormatMethod(content, store) {
    const re = new RegExp('(' + MASK_OPEN + '(\\d+)' + MASK_CLOSE + ')\\.format\\(', 'g');
    let out = '', last = 0, m;
    while ((m = re.exec(content)) !== null) {
      const fmtTok = m[1];
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = findMatchingParen(content, openIdx);
      if (closeIdx === -1) continue;
      const argsRaw = content.slice(openIdx + 1, closeIdx);
      const literal = literalStringValue(fmtTok, store);
      let replacement;
      if (literal === null) {
        replacement = content.slice(m.index, closeIdx + 1); // leave unchanged
      } else {
      const positional = [];
      const kwargs = {};
      let spreadSource = null, starSpreadSource = null;
      for (const p of splitTopLevel(argsRaw, ',')) {
        const pt = p.trim();
        if (pt.startsWith('**')) { spreadSource = pt.slice(2); continue; }
        if (pt.startsWith('...')) { starSpreadSource = pt.slice(3); continue; }
        if (pt.startsWith('*')) { starSpreadSource = pt.slice(1); continue; }
        const km = p.match(/^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/);
        if (km) kwargs[km[1]] = km[2];
        else positional.push(p);
      }
      const parts = [];
      let i = 0, autoCounter = 0;
      while (i < literal.length) {
        if (literal[i] === '{' && literal[i + 1] === '{') { parts.push(pushMasked(store, jsQuote('{'))); i += 2; continue; }
        if (literal[i] === '}' && literal[i + 1] === '}') { parts.push(pushMasked(store, jsQuote('}'))); i += 2; continue; }
        if (literal[i] === '{') {
          const j = literal.indexOf('}', i);
          if (j === -1) { parts.push(pushMasked(store, jsQuote(literal.slice(i)))); break; }
          const inner = literal.slice(i + 1, j);
          const colonIdx = inner.indexOf(':');
          const keyPart = colonIdx >= 0 ? inner.slice(0, colonIdx) : inner;
          const specPart = colonIdx >= 0 ? inner.slice(colonIdx + 1) : null;
          let exprText;
          if (keyPart === '') {
            exprText = positional[autoCounter] !== undefined ? positional[autoCounter++] : (starSpreadSource ? `${starSpreadSource}[${autoCounter++}]` : null);
          } else if (/^\d+$/.test(keyPart)) {
            const idx = parseInt(keyPart, 10);
            exprText = positional[idx] !== undefined ? positional[idx] : (starSpreadSource ? `${starSpreadSource}[${idx}]` : null);
          } else if (kwargs[keyPart] !== undefined) exprText = kwargs[keyPart];
          else if (spreadSource) exprText = `${spreadSource}[${jsQuote(keyPart)}]`;
          if (exprText === null || exprText === undefined) exprText = 'null';
          parts.push(specPart !== null ? buildFormattedValue(exprText, specPart) : `pystr(${exprText})`);
          i = j + 1;
          continue;
        }
        let j = i;
        while (j < literal.length && literal[j] !== '{' && literal[j] !== '}') j++;
        parts.push(pushMasked(store, jsQuote(literal.slice(i, j))));
        i = j;
      }
      replacement = parts.length ? '(' + parts.join(' + ') + ')' : '""';
      }
      out += content.slice(last, m.index) + replacement;
      last = closeIdx + 1;
      re.lastIndex = closeIdx + 1;
    }
    out += content.slice(last);
    return out;
  }

  // Python's conditional expression: `A if COND else B`. The engine's
  // grammar has no ternary operator at all, but now that real closures
  // exist we can fake one with an immediately-invoked function.
  function findSpacedTokens(content, token) {
    const positions = [];
    let inStr = null, escape = false;
    for (let i = 0; i < content.length; i++) {
      const c = content[i];
      if (inStr) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'") { inStr = c; continue; }
      if (content.slice(i, i + token.length) === token) positions.push(i);
    }
    return positions;
  }

  function convertTernary(content) {
    const ifPositions = findSpacedTokens(content, ' if ');
    for (const ifIdx of ifPositions) {
      // matching ' else ' via a depth scan relative to this specific 'if'
      // (so `f(a if c else b, x)` finds it even though it's nested inside
      // the call's parens)
      let depth = 0, inStr = null, escape = false, elseIdx = -1;
      for (let i = ifIdx + 4; i < content.length; i++) {
        const c = content[i];
        if (inStr) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === inStr) inStr = null; continue; }
        if (c === '"' || c === "'") { inStr = c; continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
        else if (depth === 0 && content.slice(i, i + 6) === ' else ') { elseIdx = i; break; }
      }
      if (elseIdx === -1) continue; // not a real ternary here - try the next candidate

      let exprStart = 0;
      { let d = 0;
        for (let i = ifIdx - 1; i >= 0; i--) {
          const c = content[i];
          if (c === ')' || c === ']' || c === '}') d++;
          else if (c === '(' || c === '[' || c === '{') { if (d === 0) { exprStart = i + 1; break; } d--; }
          else if (d === 0 && c === ',') { exprStart = i + 1; break; }
        }
      }
      let exprEnd = content.length;
      { let d = 0;
        for (let i = elseIdx + 6; i < content.length; i++) {
          const c = content[i];
          if (c === '(' || c === '[' || c === '{') d++;
          else if (c === ')' || c === ']' || c === '}') { if (d === 0) { exprEnd = i; break; } d--; }
          else if (d === 0 && c === ',') { exprEnd = i; break; }
        }
      }

      const trueExpr = content.slice(exprStart, ifIdx).trim();
      const cond = content.slice(ifIdx + 4, elseIdx).trim();
      const falseExpr = content.slice(elseIdx + 6, exprEnd).trim();
      const replacement = `(function() { if (${transformExpression(cond)}) { return (${transformExpression(trueExpr)}); } else { return (${transformExpression(falseExpr)}); } })()`;
      const before = convertTernary(content.slice(0, exprStart));
      const after = convertTernary(content.slice(exprEnd));
      return before + replacement + after;
    }
    return content;
  }

  // Python tuple literals like `("Bob", 25)` or `(x,)` have no canonical
  // equivalent - `(...)` in that grammar can only group ONE expression,
  // never a comma list. Since we already treat tuples as plain arrays
  // everywhere else (zip/enumerate/.items() all produce [a, b] pairs),
  // convert them to array literals too. Must not touch real function
  // calls like `foo(a, b)` - only bare parenthesized groups.
  function convertTupleLiterals(content) {
    let out = '', i = 0;
    while (i < content.length) {
      const c = content[i];
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < content.length && content[j] !== c) { if (content[j] === '\\') j++; j++; }
        out += content.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (c === '(') {
        const prev = i > 0 ? content[i - 1] : '';
        const isCallOrGroup = /[\w\]\)]/.test(prev) || prev === MASK_CLOSE;
        const closeIdx = findMatchingParen(content, i);
        if (closeIdx !== -1) {
          const inner = content.slice(i + 1, closeIdx);
          const parts = splitTopLevel(inner, ',');
          const trailingComma = inner.trim().endsWith(',');
          if (!isCallOrGroup && (parts.length > 1 || (parts.length === 1 && trailingComma && inner.trim() !== ''))) {
            out += '[' + convertTupleLiterals(inner) + ']';
            i = closeIdx + 1;
            continue;
          }
        }
      }
      out += content[i];
      i++;
    }
    return out;
  }

  // eval("some expression") - only when the argument is a literal string
  // known at compile time (by far the common classroom usage). We simply
  // run the literal through our own transformExpression and inline the
  // result - no runtime code generation needed. A dynamically built
  // string (eval(some_variable)) can't work this way and gets a clear
  // error instead of silently failing.
  function convertEval(content, store) {
    const re = /\beval\(/g;
    let out = '', last = 0, m;
    while ((m = re.exec(content)) !== null) {
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = findMatchingParen(content, openIdx);
      if (closeIdx === -1) continue;
      const argsRaw = content.slice(openIdx + 1, closeIdx);
      const literal = literalStringValue(argsRaw.trim(), store);
      if (literal === null) {
        unsupported('eval() with a non-literal argument', 'the engine has no runtime code-generation hook, so eval() only works when the string is known at compile time, e.g. eval("2 + 3")');
      }
      out += content.slice(last, m.index) + `(${transformExpression(literal)})`;
      last = closeIdx + 1;
      re.lastIndex = closeIdx + 1;
    }
    out += content.slice(last);
    return out;
  }

  function parseComprehensionInner(inner) {
    const forIdx = findTopLevelKeyword(inner, 'for');
    if (forIdx === -1) return null;
    const rawExpr = inner.slice(0, forIdx).trim();
    let rest = inner.slice(forIdx + 3);
    const inIdx = findTopLevelKeyword(rest, 'in');
    if (inIdx === -1) return null;
    const loopVarRaw = rest.slice(0, inIdx).trim();
    rest = rest.slice(inIdx + 2);
    const ifIdx = findTopLevelKeyword(rest, 'if');
    let rawIter, rawCond = null;
    if (ifIdx === -1) rawIter = rest.trim();
    else { rawIter = rest.slice(0, ifIdx).trim(); rawCond = rest.slice(ifIdx + 2).trim(); }
    return { rawExpr, loopVarRaw, rawIter, rawCond };
  }

  function comprehensionToIIFE(kind, parsed) {
    const iterExpr = convertBracketComprehensions(parsed.rawIter);
    const cond = parsed.rawCond !== null ? convertBracketComprehensions(parsed.rawCond) : null;
    let loopVar = parsed.loopVarRaw, unpackPreamble = '';
    if (parsed.loopVarRaw.includes(',')) {
      const names = parsed.loopVarRaw.split(',').map(s => s.trim());
      loopVar = '__cval';
      unpackPreamble = names.map((n, i) => `${n} = __cval[${i}];`).join(' ') + ' ';
    }
    if (kind === 'dict') {
      const colonAt = findTopLevelColon(parsed.rawExpr);
      if (colonAt === -1) unsupported('Malformed dict comprehension', 'expected `{key: value for ...}`');
      const key = convertBracketComprehensions(parsed.rawExpr.slice(0, colonAt).trim());
      const val = convertBracketComprehensions(parsed.rawExpr.slice(colonAt + 1).trim());
      const body = `__out[${key}] = ${val};`;
      return `(function() { let __out = {}; for (${loopVar} \u0001FORIN\u0001 ${iterExpr}) { ${unpackPreamble}${cond ? `if (${cond}) { ${body} }` : body} } return __out; })()`;
    }
    const expr = convertBracketComprehensions(parsed.rawExpr);
    const push = `__out.push(${expr});`;
    const iife = `(function() { let __out = []; for (${loopVar} \u0001FORIN\u0001 ${iterExpr}) { ${unpackPreamble}${cond ? `if (${cond}) { ${push} }` : push} } return __out; })()`;
    return kind === 'set' ? `pyset(${iife})` : iife;
  }

  // [EXPR for ... ] / {EXPR for ...} / {K: V for ...} used ANYWHERE in an
  // expression (assignment RHS comprehensions are handled earlier, via the
  // more efficient statement-based expandComprehension - this covers
  // everywhere else, e.g. print([x*x for x in nums])).
  //
  // This is a nesting-aware scan (using findMatchingBracket/Brace, which
  // track depth properly) rather than the old `[^\[\]]*` / `[^{}]*`
  // regexes. Those regexes describe "a bracket with no brackets inside
  // it", so a comprehension whose mapped expression itself contains a
  // subscript - e.g. `[res := res + a[i] for i in range(len(a)-1)]`,
  // where `a[i]` is a nested `[...]` - was never recognised as a
  // comprehension at all: the regex engine matched the innermost `[i]`
  // instead of the outer bracket, found no `for` inside "i", and gave up,
  // silently leaving the real comprehension's `for`/`in` keywords to be
  // mangled by later passes (e.g. convertMembership rewriting `for i in
  // range(...)` as if `in` were a membership test). Any depth of nested
  // calls/indexing/dict-or-set-literals inside a comprehension's mapped
  // expression, iterable, or condition now works correctly.
  function convertBracketComprehensions(content) {
    let out = '', i = 0;
    const n = content.length;
    while (i < n) {
      const c = content[i];
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && content[j] !== c) { if (content[j] === '\\') j++; j++; }
        out += content.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (c === '(') {
        const close = findMatchingParen(content, i);
        if (close === -1) { out += c; i++; continue; }
        const inner = content.slice(i + 1, close);
        const parsed = parseComprehensionInner(inner);
        out += parsed ? comprehensionToIIFE('list', parsed) : ('(' + convertBracketComprehensions(inner) + ')');
        i = close + 1;
        continue;
      }
      if (c === '[') {
        const close = findMatchingBracket(content, i);
        if (close === -1) { out += c; i++; continue; }
        const inner = content.slice(i + 1, close);
        const parsed = parseComprehensionInner(inner);
        out += parsed ? comprehensionToIIFE('list', parsed) : ('[' + convertBracketComprehensions(inner) + ']');
        i = close + 1;
        continue;
      }
      if (c === '{') {
        const close = findMatchingBrace(content, i);
        if (close === -1) { out += c; i++; continue; }
        const inner = content.slice(i + 1, close);
        const forIdxProbe = findTopLevelKeyword(inner, 'for');
        const parsed = forIdxProbe !== -1 ? parseComprehensionInner(inner) : null;
        if (parsed) {
          const kind = findTopLevelColon(inner.slice(0, forIdxProbe)) !== -1 ? 'dict' : 'set';
          out += comprehensionToIIFE(kind, parsed);
        } else {
          out += '{' + convertBracketComprehensions(inner) + '}';
        }
        i = close + 1;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  // A generator expression passed directly as a call's sole argument, with
  // no brackets of its own: foo(EXPR for VAR in ITER [if COND]).
  function convertBareGeneratorArgs(content) {
    let out = '', i = 0;
    while (i < content.length) {
      const c = content[i];
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < content.length && content[j] !== c) { if (content[j] === '\\') j++; j++; }
        out += content.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (content[i] === '(') {
        const prev = i > 0 ? content[i - 1] : '';
        const isCall = /[\w\]\)]/.test(prev) || prev === MASK_CLOSE;
        const closeIdx = findMatchingParen(content, i);
        if (isCall && closeIdx !== -1) {
          const inner = content.slice(i + 1, closeIdx);
          const parsed = parseComprehensionInner(inner);
          if (parsed) {
            out += '(' + comprehensionToIIFE('list', parsed) + ')';
            i = closeIdx + 1;
            continue;
          }
        }
      }
      out += content[i];
      i++;
    }
    return out;
  }

  // Python's f(*mylist, other) spread-call syntax -> canonical's f(...mylist, other)
  function convertSpreadCallArgs(content) {
    let out = '', i = 0;
    while (i < content.length) {
      const c = content[i];
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < content.length && content[j] !== c) { if (content[j] === '\\') j++; j++; }
        out += content.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (content[i] === '(') {
        const prev = i > 0 ? content[i - 1] : '';
        const isCall = /[\w\]\)]/.test(prev) || prev === MASK_CLOSE;
        const closeIdx = findMatchingParen(content, i);
        if (isCall && closeIdx !== -1) {
          const inner = content.slice(i + 1, closeIdx);
          const parts = splitTopLevel(inner, ',').map(p => {
            const t = p.trim();
            if (/^\*(?!\*)/.test(t)) return '...' + convertSpreadCallArgs(t.slice(1).trim());
            return convertSpreadCallArgs(t);
          });
          out += '(' + parts.join(', ') + ')';
          i = closeIdx + 1;
          continue;
        }
      }
      if (content[i] === '[') {
        const prev = i > 0 ? content[i - 1] : '';
        // A `[` preceded by an identifier/`]`/`)` is a subscript (a[i]), not
        // a list literal — leave it alone. Only list literals can contain a
        // Python `*expr` spread element.
        const isSubscript = /[\w\]\)]/.test(prev) || prev === MASK_CLOSE;
        const closeIdx = findMatchingBracket(content, i);
        if (!isSubscript && closeIdx !== -1) {
          const inner = content.slice(i + 1, closeIdx);
          const parts = inner.trim() === '' ? [] : splitTopLevel(inner, ',').map(p => {
            const t = p.trim();
            if (/^\*(?!\*)/.test(t)) return '...' + convertSpreadCallArgs(t.slice(1).trim());
            return convertSpreadCallArgs(t);
          });
          out += '[' + parts.join(', ') + ']';
          i = closeIdx + 1;
          continue;
        }
      }
      out += content[i];
      i++;
    }
    return out;
  }

  function transformExpression(content) {
    content = stripStringPrefixes(content);
    // Must run before convertMethodCalls: `operator.index(x)`, `operator.count`
    // etc. look exactly like `receiver.method(...)` calls to the generic
    // method-call rewriters below, which would otherwise mistake the
    // `operator` namespace object for a real value (e.g. turning
    // `operator.index(3.0)` into `operator.indexOf(3.0)`, then mangling it
    // further). Converting the dot to an underscore first takes it out of
    // that rewriter's pattern entirely.
    content = content.replace(/\boperator\.(add|sub|mul|truediv|floordiv|mod|pow|eq|ne|lt|le|gt|ge|neg|not_|and_|or_|is_|is_not|iadd|isub|imul|abs|pos|contains|concat|countOf|indexOf|length_hint|truth|index|matmul|imatmul|xor|ixor|lshift|rshift|ilshift|irshift|inv|invert)\b/g, 'operator_$1');
    // itemgetter/attrgetter/methodcaller each take a variable number of
    // arguments and need them bundled into one array (this engine's
    // calling convention is fixed-arity, no *args) - a plain rename like
    // the other operator.* functions get above would silently drop every
    // argument after the first. `itemgetter(0, 1)` used to become a
    // single-key getter that just returned item 0 and quietly ignored
    // the `1` - not an error, a wrong answer, which is exactly what
    // happened here.
    content = content.replace(/\boperator\.(itemgetter|attrgetter|methodcaller)\b/g, '$1');
    content = replaceTopLevelCall(content, 'itemgetter', (a) => `operator_itemgetter([${splitTopLevel(a, ',').map(p => p.trim()).join(', ')}])`);
    content = replaceTopLevelCall(content, 'attrgetter', (a) => `operator_attrgetter([${splitTopLevel(a, ',').map(p => p.trim()).join(', ')}])`);
    content = replaceTopLevelCall(content, 'methodcaller', (a) => {
      const parts = splitTopLevel(a, ',').map(p => p.trim());
      return `operator_methodcaller(${parts[0]}, [${parts.slice(1).join(', ')}])`;
    });
    // Same reasoning as the operator.* substitution above: must run before
    // convertMethodCalls, or e.g. `re.match(...)` gets misread as a generic
    // `.match(` method call on some receiver named `re`.
    content = content.replace(/\bre\.(match|search|fullmatch|findall|finditer|subn|sub|split|compile|escape)\b/g, 're_$1');
    content = content.replace(/\bre\.(IGNORECASE|I)\b/g, '2');
    content = content.replace(/\bre\.(MULTILINE|M)\b/g, '8');
    content = content.replace(/\bre\.(DOTALL|S)\b/g, '16');
    content = content.replace(/\bre\.(VERBOSE|X)\b/g, '0');
    content = expandFStrings(content);
    content = convertSpreadCallArgs(content);
    content = convertBareGeneratorArgs(content);
    content = convertBracketComprehensions(content);
    content = convertLambdas(content);
    content = convertTupleLiterals(content);
    content = convertTernary(content);
    const { masked, store } = maskStrings(content);
    content = masked;
    content = convertSetLiterals(content);
    content = convertSlicing(content);
    content = convertFormatMethod(content, store);
    content = convertEval(content, store);
    content = convertMethodCalls(content);
    content = convertSortCalls(content);
    content = convertBuiltinCalls(content);
    content = convertDivMod(content, store);
    content = convertMembership(content);
    content = convertIdentity(content);
    content = convertChainedComparisons(content);
    content = content.replace(/\bTrue\b/g, 'true');
    content = content.replace(/\bFalse\b/g, 'false');
    content = content.replace(/\bNone\b/g, 'null');
    content = content.replace(/\b__name__\b/g, jsQuote('__main__'));
    content = content.replace(/\binput\s*\(\s*\)/g, 'read_line()');
    content = content.replace(/\binput\b(?!\s*\()/g, 'read_line');
    content = content.replace(/\bprint\s*\(([\s\S]*)\)/g, (m, args) => {
      const parts = splitTopLevel(args, ',').map(a => a.trim()).filter(a => a.length > 0);
      let sepExpr = null, endExpr = null;
      const rest = [];
      for (const p of parts) {
        const sepM = p.match(/^sep\s*=\s*([\s\S]+)$/);
        const endM = p.match(/^end\s*=\s*([\s\S]+)$/);
        if (sepM) { sepExpr = sepM[1]; continue; }
        if (endM) { endExpr = endM[1]; continue; }
        rest.push(p);
      }
      if (sepExpr === null && endExpr === null) {
        return `pyprint(${rest.join(', ')})`;
      }
      // sep=/end= accept arbitrary expressions in real Python, not just
      // string literals, so pass them through as-is rather than assuming
      // they're quoted text.
      const sepArg = sepExpr === null ? jsQuote(' ') : sepExpr;
      const endArg = endExpr === null ? jsQuote('\n') : endExpr;
      return `pyprintx(${sepArg}, ${endArg}${rest.length ? ', ' + rest.join(', ') : ''})`;
    });
    content = unmaskStrings(content, store);
    content = content.replace(/\u0001FORIN\u0001/g, 'in');
    return content;
  }

  // maps Python builtin function calls onto canonical builtins / prelude
  // helpers. Runs on masked content, so string args are still placeholders
  // here (fine - we only need argument *shape*, not literal text, except
  // for %/​.format() literal parsing which is handled separately below).
  function convertBuiltinCalls(content) {
    content = replaceTopLevelCall(content, 'str', (a) => `pystr(${a})`);
    content = replaceTopLevelCall(content, 'int', (a) => `pyint(${a})`);
    content = replaceTopLevelCall(content, 'float', (a) => `pyfloat(${a})`);
    content = replaceTopLevelCall(content, 'set', (a) => a.trim() ? `pyset(${a})` : '[]');
    content = replaceTopLevelCall(content, 'bool', (a) => `pybool(${a})`);
    content = replaceTopLevelCall(content, 'reversed', (a) => `pyreversed(${a})`);
    content = replaceTopLevelCall(content, 'sorted', (a) => {
      const p = splitTopLevel(a, ',');
      let reverse = 'false', keyFn = 'null';
      for (const x of p.slice(1)) {
        const mr = x.match(/^reverse\s*=\s*([\s\S]+)$/);
        const mk = x.match(/^key\s*=\s*([\s\S]+)$/);
        if (mr) reverse = mr[1];
        if (mk) keyFn = mk[1];
      }
      return `pysorted(${p[0]}, ${keyFn}, ${reverse})`;
    });
    content = replaceTopLevelCall(content, 'enumerate', (a) => `pyenumerate(${a})`);
    content = replaceTopLevelCall(content, 'zip', (a) => `pyzip(${splitTopLevel(a, ',').join(', ')})`);
    content = replaceTopLevelCall(content, 'sum', (a) => {
      const p = splitTopLevel(a, ',');
      return `pysum(${p[0]}, ${p[1] !== undefined ? p[1] : 'null'})`;
    });
    content = replaceTopLevelCall(content, 'divmod', (a) => `pydivmod(${a})`);
    content = replaceTopLevelCall(content, 'min', (a) => {
      const p = splitTopLevel(a, ',').filter(x => !/^key\s*=/.test(x));
      const keyM = a.match(/\bkey\s*=\s*([\s\S]+?)(?:,|$)/);
      if (p.length > 1) return `min(${p.join(', ')})`;
      return `pymin(${p[0]}, ${keyM ? keyM[1] : 'null'})`;
    });
    content = replaceTopLevelCall(content, 'max', (a) => {
      const p = splitTopLevel(a, ',').filter(x => !/^key\s*=/.test(x));
      const keyM = a.match(/\bkey\s*=\s*([\s\S]+?)(?:,|$)/);
      if (p.length > 1) return `max(${p.join(', ')})`;
      return `pymax(${p[0]}, ${keyM ? keyM[1] : 'null'})`;
    });
    content = replaceTopLevelCall(content, 'any', (a) => `pyany(${a})`);
    content = replaceTopLevelCall(content, 'all', (a) => `pyall(${a})`);
    content = replaceTopLevelCall(content, 'list', (a) => a.trim() ? `pylist(${a})` : '[]');
    content = replaceTopLevelCall(content, 'tuple', (a) => a.trim() ? `pytuple(${a})` : '[]');
    content = content.replace(/\bmath\.(sqrt|floor|ceil|pow)\b/g, '$1');
    content = content.replace(/\bmath\.(factorial|gcd|log|sin|cos|tan|fsum)\b/g, 'math_$1');
    content = content.replace(/\bmath\.pi\b/g, '3.141592653589793');
    content = content.replace(/\bmath\.e\b/g, '2.718281828459045');
    content = content.replace(/\bmath\.inf\b/g, '1e308');
    content = content.replace(/\brandom\.(random|randint|uniform|choice|shuffle)\b/g, 'random_$1');
    content = content.replace(/\bjson\.(dumps|loads)\b/g, 'json_$1');
    content = content.replace(/\bcollections\.Counter\b/g, 'collections_counter');
    content = content.replace(/\bCounter\(/g, 'collections_counter(');
    content = content.replace(/\bcollections\.deque\b/g, 'collections_deque');
    content = content.replace(/\bdeque\(/g, 'collections_deque(');
    content = content.replace(/\bfunctools\.reduce\b/g, 'reduce');
    content = content.replace(/\bfunctools\.partial\b/g, 'partial');
    content = content.replace(/\bast\.literal_eval\b/g, 'ast_literal_eval');
    content = content.replace(/\bitertools\.(accumulate|chain|product|permutations|combinations|islice|repeat|starmap|compress|cycle)\b/g, '$1');
    content = content.replace(/\bio\.StringIO\b/g, 'StringIO');
    content = content.replace(/\burllib\.parse\.urlparse\b/g, 'urlparse');
    {
      const aliasEscaped = numpyAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      content = content.replace(new RegExp('\\b' + aliasEscaped + '\\.(array|arange|zeros|ones|linspace|sum|mean|min|max|std|abs|dot)\\b', 'g'), 'np_$1');
    }
    {
      const aliasEscaped = pandasAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      content = content.replace(new RegExp('\\b' + aliasEscaped + '\\.Series\\b', 'g'), 'pd_series');
    }
    content = convertPandasSeriesCalls(content);
    content = content.replace(/\b(random|randint|uniform|choice|shuffle)\(/g, 'random_$1(');
    content = content.replace(/\b(dumps|loads)\(/g, 'json_$1(');
    content = content.replace(/\bstring\.ascii_lowercase\b/g, jsQuote('abcdefghijklmnopqrstuvwxyz'));
    content = content.replace(/\bstring\.ascii_uppercase\b/g, jsQuote('ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
    content = content.replace(/\bstring\.ascii_letters\b/g, jsQuote('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'));
    content = content.replace(/\bstring\.digits\b/g, jsQuote('0123456789'));
    content = content.replace(/\bstring\.punctuation\b/g, jsQuote('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'));
    content = content.replace(/\bsys\.exit\(/g, 'sys_exit(');
    content = content.replace(/\bsys\.stdout\.write\(/g, 'printraw(');
    content = content.replace(/\bsys\.stdout\.flush\(\)/g, '(0)');
    content = content.replace(/\bsys\.stdin\.readline\(\)/g, 'read_line()');
    content = content.replace(/\bbytes\.fromhex\(/g, 'bytes_fromhex(');
    content = replaceTopLevelCall(content, 'bytes', (a) => `pybytes(${a})`);
    content = replaceTopLevelCall(content, 'type', (a) => `pytype(${a})`);
    content = content.replace(/\bsys\.argv\b/g, '[]');
    content = content.replace(/\bsys\.maxsize\b/g, '9007199254740991');
    content = content.replace(/\bbase64\.b64encode\(/g, 'base64_encode(');
    content = content.replace(/\bbase64\.b64decode\(/g, 'base64_decode(');
    content = replaceTopLevelCall(content, 'isinstance', (a) => `pyisinstance(${a})`);
    content = replaceTopLevelCall(content, 'getattr', (a) => `pygetattr(${a})`);
    content = replaceTopLevelCall(content, 'setattr', (a) => `pysetattr(${a})`);
    content = replaceTopLevelCall(content, 'hasattr', (a) => `pyhasattr(${a})`);
    return content;
  }

  function replaceTopLevelCall(content, name, fn) {
    // Negative lookbehind excludes `obj.sum(...)` etc. - `\bsum\(` alone
    // would also match right after a dot (there's a word boundary
    // between "." and "s"), wrongly treating a method call on some
    // object as if it were the global sum()/min()/max()/... builtin.
    // That was harmless until now because no existing type actually had
    // a method by one of these names; NDArray's real .sum()/.min()/
    // .max() methods are what exposed it.
    // The nested lookbehind refines this: it excludes a single real
    // member-access dot (one not itself preceded by another dot) but
    // deliberately allows a *spread* operator's three dots (`...tuple(`,
    // from `*tuple(...)`) through - a plain "preceded by any dot" check
    // wrongly blocked conversion right after a spread, since the last of
    // those three dots looks identical to a member-access dot locally.
    const re = new RegExp('(?<!(?<!\\.)\\.)\\b' + name + '\\(', 'g');
    let out = '', last = 0, m;
    while ((m = re.exec(content)) !== null) {
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = findMatchingParen(content, openIdx);
      if (closeIdx === -1) continue;
      const args = content.slice(openIdx + 1, closeIdx);
      out += content.slice(last, m.index) + fn(args);
      last = closeIdx + 1;
      re.lastIndex = closeIdx + 1;
    }
    out += content.slice(last);
    return out;
  }

  /* ───────────────────────── canonical-language prelude ─────────────────────────
     Written in the SAME restricted grammar the engine executes - no
     JavaScript tricks, just for/while/if/arrays/functions, so it needs
     no engine changes at all. */

  // Note: this template has no `//` comments in it (only `/* */` would be
  // safe) - it's canonical-language source text, and `//` there is the
  // floor-division operator, not a comment marker (runCanonical is even
  // called with noSlashComments for exactly this reason). One deliberate
  // omission worth documenting here instead: there's no `pyzip` function
  // in this prelude - it's implemented natively in core-engine.js so it
  // can share real iterator object identity for the classic
  // zip(it, it) pairwise-consumption idiom, which a prelude function
  // (operating on plain values with no notion of shared mutable state)
  // has no way to express.
  const PRELUDE = `
function pymod(a, b) { return a - (a // b) * b; }
function pysum(seq, start) { if (start == null) { start = 0; } let total = start; for (item in seq) { total = total + item; } return total; }
function pymin(seq, keyFn) { let best = null; let bestKey = null; let first = true; for (item in seq) { let k = item; if (keyFn != null) { k = keyFn(item); } if (first) { best = item; bestKey = k; first = false; } else if (k < bestKey) { best = item; bestKey = k; } } return best; }
function pymax(seq, keyFn) { let best = null; let bestKey = null; let first = true; for (item in seq) { let k = item; if (keyFn != null) { k = keyFn(item); } if (first) { best = item; bestKey = k; first = false; } else if (bestKey < k) { best = item; bestKey = k; } } return best; }
function pysorted(seq, keyFn, reverse) { let arr = []; for (item in seq) { arr.push(item); } return pysortinplace(arr, keyFn, reverse); }
function pyenumerate(seq) { let out = []; let i = 0; for (item in seq) { out.push([i, item]); i = i + 1; } return out; }
function pyany(seq) { for (item in seq) { if (item) { return true; } } return false; }
function pyall(seq) { for (item in seq) { if (not item) { return false; } } return true; }
function pyinsert(lst, idx, x) { lst.push(null); let i = len(lst) - 1; while (i > idx) { lst[i] = lst[i - 1]; i = i - 1; } lst[idx] = x; return lst; }
function pyremove(lst, x) { let idx = lst.indexOf(x); if (idx >= 0) { let i = idx; while (i < len(lst) - 1) { lst[i] = lst[i + 1]; i = i + 1; } lst.pop(); } return lst; }
function pyextend(lst, other) { for (item in other) { lst.push(item); } return lst; }
function pycount(seq, x) {
  if (pytype(seq) == "<class 'str'>") {
    let sub = pystr(x);
    let n = len(seq);
    let m = len(sub);
    if (m == 0) { return n + 1; }
    let c = 0;
    let i = 0;
    while (i <= n - m) {
      if (seq.slice(i, i + m) == sub) { c = c + 1; i = i + m; } else { i = i + 1; }
    }
    return c;
  }
  let c = 0; for (item in seq) { if (item == x) { c = c + 1; } } return c;
}
function pystartswith(s, prefix) { return s.slice(0, len(prefix)) == prefix; }
function pyendswith(s, suffix) { let n = len(s); let m = len(suffix); if (m > n) { return false; } return s.slice(n - m, n) == suffix; }
function pyremovesuffix(s, suffix) { let n = len(s); let m = len(suffix); if (m == 0) { return s; } if (m > n) { return s; } if (s.slice(n - m, n) == suffix) { return s.slice(0, n - m); } return s; }
function pyremoveprefix(s, prefix) { let m = len(prefix); if (m == 0) { return s; } if (m > len(s)) { return s; } if (s.slice(0, m) == prefix) { return s.slice(m); } return s; }
function pyrsplit(s, sep, maxsplit) {
  if (sep == null) { return pysplitwhitespace(s); }
  if (maxsplit == null) { maxsplit = -1; }
  let parts = [];
  let n = len(s);
  let m = len(sep);
  let end = n;
  let splits = 0;
  while (true) {
    if (maxsplit >= 0 and splits >= maxsplit) { break; }
    let idx = -1;
    let i = end - m;
    while (i >= 0) {
      if (s.slice(i, i + m) == sep) { idx = i; break; }
      i = i - 1;
    }
    if (idx < 0) { break; }
    parts.push(s.slice(idx + m, end));
    end = idx;
    splits = splits + 1;
  }
  parts.push(s.slice(0, end));
  return pyreversed(parts);
}
function pysplitwhitespace(s) {
  let parts = [];
  let cur = '';
  let i = 0;
  while (i < len(s)) {
    let c = s[i];
    if (c == ' ' or c == '\\t' or c == '\\n' or c == '\\r') {
      if (len(cur) > 0) { parts.push(cur); cur = ''; }
    } else {
      cur = cur + c;
    }
    i = i + 1;
  }
  if (len(cur) > 0) { parts.push(cur); }
  return parts;
}
function pycapitalize(s) { if (len(s) == 0) { return s; } return s[0].upper() + s.slice(1).lower(); }
function pyisdigit(s) { if (len(s) == 0) { return false; } let i = 0; while (i < len(s)) { if (not "0123456789".includes(s[i])) { return false; } i = i + 1; } return true; }
function pylist(seq) { let out = []; for (item in seq) { out.push(item); } return out; }
function pytuple(seq) { return pylist(seq); }
function pyset(seq) { let out = []; for (item in seq) { if (not pyin(item, out)) { out.push(item); } } return out; }
function operator_add(a, b) { return a + b; }
function operator_iadd(a, b) { return a + b; }
function operator_sub(a, b) { return a - b; }
function operator_isub(a, b) { return a - b; }
function operator_mul(a, b) { return a * b; }
function operator_imul(a, b) { return a * b; }
function operator_truediv(a, b) { return truediv(a, b); }
function operator_floordiv(a, b) { return a // b; }
function operator_mod(a, b) { return pymod(a, b); }
function operator_pow(a, b) { return a ** b; }
function operator_neg(a) { return 0 - a; }
function operator_pos(a) { return a; }
function operator_abs(a) { return abs(a); }
function operator_eq(a, b) { return a == b; }
function operator_ne(a, b) { return a != b; }
function operator_lt(a, b) { return a < b; }
function operator_le(a, b) { return a <= b; }
function operator_gt(a, b) { return a > b; }
function operator_ge(a, b) { return a >= b; }
function operator_not_(a) { return not a; }
function operator_is_(a, b) { return a == b; }
function operator_is_not(a, b) { return a != b; }
function operator_contains(seq, x) { return pyin(x, seq); }
function operator_concat(a, b) { return a + b; }
function operator_countOf(seq, x) { return pycount(seq, x); }
function operator_indexOf(seq, x) { return seq.indexOf(x); }
function operator_itemgetter(keys) { return function(obj) { if (len(keys) == 1) { return obj[keys[0]]; } let out = []; for (k in keys) { out.push(obj[k]); } return out; }; }
function operator_attrgetter(names) { return function(obj) { if (len(names) == 1) { return pygetattr(obj, names[0]); } let out = []; for (nm in names) { out.push(pygetattr(obj, nm)); } return out; }; }
function operator_methodcaller(name, extraArgs) { return function(obj) { return pycallmethod(obj, name, extraArgs); }; }
function operator_length_hint(obj, default_) {
  if (default_ == null) { default_ = 0; }
  if (pytype(obj) == "<class 'str'>" or pytype(obj) == "<class 'list'>" or pytype(obj) == "<class 'dict'>") { return len(obj); }
  return default_;
}
function operator_truth(a) { return pybool(a); }
function operator_index(a) { return pyint(a); }
function operator_xor(a, b) { return a ^ b; }
function operator_ixor(a, b) { return a ^ b; }
function operator_and_(a, b) { return a & b; }
function operator_or_(a, b) { return a | b; }
function operator_lshift(a, b) { return a << b; }
function operator_rshift(a, b) { return a >> b; }
function operator_ilshift(a, b) { return a << b; }
function operator_irshift(a, b) { return a >> b; }
function operator_inv(a) { return ~a; }
function operator_invert(a) { return ~a; }
function operator_matmul(a, b) { return a * b; }
function operator_imatmul(a, b) { return a * b; }
function pypad(s, width, align) {
  s = pystr(s);
  let n = len(s);
  if (n >= width) { return s; }
  let padlen = width - n;
  let pad = "";
  let i = 0;
  while (i < padlen) { pad = pad + " "; i = i + 1; }
  if (align == "<") { return s + pad; }
  if (align == "^") {
    let half = padlen // 2;
    return pad.slice(0, half) + s + pad.slice(half);
  }
  return pad + s;
}
function pysortinplace(arr, keyFn, reverse) {
  let n = len(arr);
  let keys = [];
  let i = 0;
  while (i < n) { let k = arr[i]; if (keyFn != null) { k = keyFn(arr[i]); } keys.push(k); i = i + 1; }
  i = 1;
  while (i < n) {
    let cur = arr[i];
    let curKey = keys[i];
    let j = i - 1;
    while (j >= 0 and curKey < keys[j]) {
      arr[j + 1] = arr[j];
      keys[j + 1] = keys[j];
      j = j - 1;
    }
    arr[j + 1] = cur;
    keys[j + 1] = curKey;
    i = i + 1;
  }
  if (reverse == true) { arr.reverse(); }
  return arr;
}
`.trim();

  /* ───────────────────────── public API ───────────────────────── */

  function run(code, stdin = '') {
    let canonical;
    try {
      canonical = toCanonical(code);
    } catch (e) {
      return {
        ok: false,
        output: '',
        error: e instanceof UnsupportedError ? e.message : `Transpilation Error: ${e.message}`,
        errorType: 'SyntaxError'
      };
    }

    const res = CoreEngine.runCanonical(canonical, stdin, { noSlashComments: true });

    if (!res.ok && res.error) {
      res.error = `Python: ${res.error}`;
    }

    return {
      ok: res.ok,
      output: res.output || '',
      error: res.error || null,
      errorType: res.errorType || null
    };
  }

  if (typeof CoreEngine !== 'undefined' && CoreEngine.setPythonTranspiler) {
    CoreEngine.setPythonTranspiler(toCanonical);
  }

  return { run, toCanonical };
})();

if (typeof module !== 'undefined') module.exports = PythonCompiler;