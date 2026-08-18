"use strict";
/* ══════════════════════════════════════════════════════════════════════
   UNIVERSAL COMPILER  —  100% self-written, runs fully offline, no APIs.
   Architecture:
     1. Per-language ADAPTER  — regex/structural transform that rewrites
        real C/Java/Go/Rust/... source into one canonical mini-language
        (strips wrappers like main(), type keywords, normalises print/
        input idioms, converts Ruby's `end` blocks to braces, etc).
     2. Canonical LEXER + PARSER + EVALUATOR — one shared recursive-
        descent parser and tree-walking interpreter that actually
        executes the resulting program (real parsing + real execution,
        not string/pattern matching against expected output).
   Python keeps its own dedicated indentation-based interpreter (already
   in this file) since its grammar is fundamentally different (no braces).
═══════════════════════════════════════════════════════════════════════ */
const CoreEngine = (() => {

  class RuntimeErr extends Error {}
  class ParseErr extends Error {}

  /* ────────────────────────────────────────────────────────────────
     1. CANONICAL LEXER
        Canonical grammar looks like a small JS/C subset:
          let x = 5; x = x + 1;
          if (cond) { ... } else if (cond) { ... } else { ... }
          while (cond) { ... }
          for (i = 0; i < n; i = i + 1) { ... }
          for (x in range(0, n)) { ... }
          function name(a, b) { ... return expr; }
          print(a, b);  printraw(a);  printf(fmt, a, b);
          arrays: [1,2,3]   arr[i]   arr.length   arr.push(x) ...
  ──────────────────────────────────────────────────────────────── */
  const KEYWORDS = new Set([
    'let','var','const','if','else','while','for','in','function','return',
    'break','continue','true','false','null','and','or','not',
    'try','catch','finally','throw','class'
  ]);

  function lex(src, opts) {
    opts = opts || {};
    const toks = []; let i = 0; const n = src.length; let line = 1;
    const push = (t, v) => toks.push({ t, v, line });
    while (i < n) {
      const c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (!opts.noSlashComments && c === '/' && src[i+1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i+1] === '*') { i += 2; while (i < n && !(src[i]==='*'&&src[i+1]==='/')) { if(src[i]==='\n')line++; i++; } i += 2; continue; }
      if (/[0-9]/.test(c)) {
        let j = i; while (j < n && /[0-9]/.test(src[j])) j++;
        if (src[j] === '.' && /[0-9]/.test(src[j+1])) { j++; while (j < n && /[0-9]/.test(src[j])) j++; }
        push('NUM', parseFloat(src.slice(i, j))); i = j; continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        const q = c; let j = i + 1, s = '';
        while (j < n && src[j] !== q) {
          if (src[j] === '\\') {
            const e = src[j+1];
            const map = { n:'\n', t:'\t', r:'\r', '\\':'\\', '"':'"', "'":"'", '`':'`', '0':'\0' };
            s += (map[e] !== undefined ? map[e] : e); j += 2;
          } else { s += src[j]; j++; }
        }
        push('STR', s); i = j + 1; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i; while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
        const w = src.slice(i, j);
        push(KEYWORDS.has(w) ? 'KW' : 'IDENT', w); i = j; continue;
      }
      const three = src.slice(i, i+3);
      if (three === '===' || three === '!==') { push('OP', three.slice(0,2)); i += 3; continue; }
      if (three === '...') { push('OP', '...'); i += 3; continue; }
      const two = src.slice(i, i+2);
      if (['==','!=','<=','>=','&&','||','+=','-=','*=','/=','%=','++','--','**','//','<<','>>',':='].includes(two)) { push('OP', two); i += 2; continue; }
      if ('+-*/%=<>!(){}[],;.:&|@^~'.includes(c)) { push('OP', c); i++; continue; }
      i++; // skip unknown char
    }
    push('EOF', null);
    return toks;
  }

  /* ────────────────────────────────────────────────────────────────
     2. PARSER  (recursive descent -> AST)
  ──────────────────────────────────────────────────────────────── */
  class Parser {
    constructor(toks) { this.toks = toks; this.pos = 0; }
    peek(o=0) { return this.toks[this.pos+o]; }
    at(t, v) { const tk = this.peek(); return tk.t===t && (v===undefined || tk.v===v); }
    atOp(v) { return this.at('OP', v); }
    atKw(v) { return this.at('KW', v); }
    next() { return this.toks[this.pos++]; }
    expectOp(v) { if (!this.atOp(v)) throw new ParseErr(`Expected "${v}" but got "${this.peek().v}" (line ${this.peek().line})`); return this.next(); }
    expectKw(v) { if (!this.atKw(v)) throw new ParseErr(`Expected "${v}" (line ${this.peek().line})`); return this.next(); }
    skipSemis() { while (this.atOp(';')) this.next(); }

    parseProgram() {
      const body = [];
      this.skipSemis();
      while (!this.at('EOF')) { body.push(this.parseStatement()); this.skipSemis(); }
      return { k:'Program', body };
    }

    parseBlock() {
      this.expectOp('{');
      const body = [];
      this.skipSemis();
      while (!this.atOp('}')) { body.push(this.parseStatement()); this.skipSemis(); }
      this.expectOp('}');
      return body;
    }

    parseStatement() {
      if (this.atKw('let') || this.atKw('var') || this.atKw('const')) return this.parseDecl();
      if (this.atKw('if')) return this.parseIf();
      if (this.atKw('while')) return this.parseWhile();
      if (this.atKw('for')) return this.parseFor();
      if (this.atKw('function')) return this.parseFunc();
      if (this.atKw('try')) return this.parseTry();
      if (this.atKw('class')) return this.parseClass();
      if (this.atOp('@')) return this.parseDecorated();
      if (this.atKw('throw')) { this.next(); const e = this.parseExpr(); return { k:'Throw', expr:e }; }
      if (this.atKw('return')) { this.next(); const e = (this.atOp(';')||this.atOp('}'))?null:this.parseExpr(); return { k:'Return', expr:e }; }
      if (this.atKw('break')) { this.next(); return { k:'Break' }; }
      if (this.atKw('continue')) { this.next(); return { k:'Continue' }; }
      if (this.atOp('{')) return { k:'Block', body: this.parseBlock() };
      return this.parseExprOrAssignStatement();
    }

    parseDecl() {
      this.next(); // let/var/const
      const name = this.next().v;
      let expr = { k:'Null' };
      if (this.atOp('=')) { this.next(); expr = this.parseExpr(); }
      return { k:'VarDecl', name, expr };
    }

    parseIf() {
      this.next(); this.expectOp('(');
      const cond = this.parseExpr(); this.expectOp(')');
      const then = this.atOp('{') ? this.parseBlock() : [this.parseStatement()];
      let elseBody = null;
      this.skipSemis();
      if (this.atKw('else')) {
        this.next();
        if (this.atKw('if')) { elseBody = [this.parseIf()]; }
        else { elseBody = this.atOp('{') ? this.parseBlock() : [this.parseStatement()]; }
      }
      return { k:'If', cond, then, elseBody };
    }

    parseWhile() {
      this.next(); this.expectOp('(');
      const cond = this.parseExpr(); this.expectOp(')');
      const body = this.atOp('{') ? this.parseBlock() : [this.parseStatement()];
      return { k:'While', cond, body };
    }

    parseFor() {
      this.next(); this.expectOp('(');
      // for (x in expr)
      if (this.at('IDENT') && this.peek(1).t==='KW' && this.peek(1).v==='in') {
        const varName = this.next().v; this.next(); // in
        const iter = this.parseExpr();
        this.expectOp(')');
        const body = this.atOp('{') ? this.parseBlock() : [this.parseStatement()];
        return { k:'ForIn', varName, iter, body };
      }
      // C-style: init; cond; update
      let init = null;
      if (!this.atOp(';')) init = (this.atKw('let')||this.atKw('var')||this.atKw('const')) ? this.parseDecl() : this.parseExprOrAssignStatement(true);
      this.expectOp(';');
      let cond = null;
      if (!this.atOp(';')) cond = this.parseExpr();
      this.expectOp(';');
      let update = null;
      if (!this.atOp(')')) update = this.parseExprOrAssignStatement(true);
      this.expectOp(')');
      const body = this.atOp('{') ? this.parseBlock() : [this.parseStatement()];
      return { k:'ForC', init, cond, update, body };
    }

    parseParamList() {
      const params = [];
      while (!this.atOp(')')) {
        const name = this.next().v;
        let def = null;
        if (this.atOp('=')) { this.next(); def = this.parseExpr(); }
        params.push({ name, def });
        if (this.atOp(',')) this.next();
      }
      return params;
    }

    parseFunc() {
      this.next();
      const name = this.next().v;
      this.expectOp('(');
      const params = this.parseParamList();
      this.expectOp(')');
      const body = this.parseBlock();
      return { k:'FuncDef', name, params, body };
    }

    parseClass() {
      this.next(); // 'class'
      const name = this.next().v;
      let bases = [];
      if (this.atOp('(')) {
        this.next();
        while (!this.atOp(')')) { bases.push(this.parseExpr()); if (this.atOp(',')) this.next(); }
        this.expectOp(')');
      }
      this.expectOp('{');
      const methods = [];
      const classVarStmts = [];
      while (!this.atOp('}')) {
        let decorators = [];
        while (this.atOp('@')) {
          this.next();
          let dname = this.next().v;
          while (this.atOp('.')) { this.next(); dname += '.' + this.next().v; }
          decorators.push(dname);
        }
        if (this.atKw('function')) {
          const fn = this.parseFunc();
          methods.push({ name: fn.name, decorators, params: fn.params, body: fn.body });
          continue;
        }
        classVarStmts.push(this.parseStatement());
        this.skipSemis();
      }
      this.expectOp('}');
      return { k:'ClassDef', name, bases, methods, classVarStmts };
    }

    parseDecorated() {
      while (this.atOp('@')) {
        this.next();
        this.next(); // decorator name
        while (this.atOp('.')) { this.next(); this.next(); }
        if (this.atOp('(')) {
          let depth = 0;
          do {
            if (this.atOp('(')) depth++;
            else if (this.atOp(')')) depth--;
            this.next();
          } while (depth > 0);
        }
      }
      if (this.atKw('function')) return this.parseFunc();
      if (this.atKw('class')) return this.parseClass();
      return this.parseStatement();
    }

    parseTry() {
      this.next(); // try
      const block = this.parseBlock();
      let catchVar = null, catchBody = null, finallyBody = null;
      if (this.atKw('catch')) {
        this.next();
        if (this.atOp('(')) { this.next(); catchVar = this.next().v; this.expectOp(')'); }
        catchBody = this.parseBlock();
      }
      if (this.atKw('finally')) { this.next(); finallyBody = this.parseBlock(); }
      return { k:'Try', block, catchVar, catchBody, finallyBody };
    }

    // handles: ident = expr ;  |  ident[expr] = expr ;  |  ident OP= expr ;  |  bare expr ;
    parseExprOrAssignStatement(noSemi) {
      const expr = this.parseExpr();
      const compoundOps = ['+=','-=','*=','/=','%='];
      if (this.atOp('=') || compoundOps.some(o=>this.atOp(o))) {
        const opTok = this.next();
        const rhs = this.parseExpr();
        if (!noSemi) {} // caller handles semicolon via skipSemis loop
        if (opTok.v !== '=') {
          const binOp = opTok.v[0];
          return { k:'Assign', target: expr, op:'=', expr: { k:'Binary', op:binOp, left:expr, right:rhs } };
        }
        return { k:'Assign', target: expr, op:'=', expr: rhs };
      }
      if ((this.atOp('++') || this.atOp('--'))) {
        const op = this.next().v;
        return { k:'Assign', target: expr, op:'=', expr: { k:'Binary', op: op==='++'?'+':'-', left: expr, right: { k:'Num', value:1 } } };
      }
      return { k:'ExprStmt', expr };
    }

    // ── expression grammar (precedence climbing) ──
    // `:=` (assignment expression / "walrus") sits above everything else,
    // exactly like real Python's namedexpr_test: it's only recognised as
    // `IDENT := expr` and is right-associative so `x := y := 5` and
    // `x := (y := 5)` both nest the way you'd expect. Because it's checked
    // via a two-token lookahead (IDENT then the literal `:=` op) before
    // falling through to the existing parseOr() chain, every other
    // operator's parsing and precedence is completely untouched when the
    // lookahead doesn't match.
    parseExpr() { return this.parseNamedExpr(); }
    parseNamedExpr() {
      if (this.at('IDENT') && this.peek(1).t === 'OP' && this.peek(1).v === ':=') {
        const name = this.next().v;
        this.next(); // consume ':='
        const expr = this.parseNamedExpr();
        return { k:'NamedExpr', name, expr };
      }
      return this.parseOr();
    }
    parseOr() {
      let l = this.parseAnd();
      while (this.atOp('||') || this.atKw('or')) { this.next(); l = { k:'Logical', op:'||', left:l, right:this.parseAnd() }; }
      return l;
    }
    parseAnd() {
      let l = this.parseEquality();
      while (this.atOp('&&') || this.atKw('and')) { this.next(); l = { k:'Logical', op:'&&', left:l, right:this.parseEquality() }; }
      return l;
    }
    parseEquality() {
      let l = this.parseCompare();
      while (this.atOp('==') || this.atOp('!=')) { const op = this.next().v; l = { k:'Binary', op, left:l, right:this.parseCompare() }; }
      return l;
    }
    parseCompare() {
      let l = this.parseBitOr();
      while (this.atOp('<') || this.atOp('>') || this.atOp('<=') || this.atOp('>=')) { const op = this.next().v; l = { k:'Binary', op, left:l, right:this.parseBitOr() }; }
      return l;
    }
    parseBitOr() {
      let l = this.parseBitXor();
      while (this.atOp('|')) { this.next(); l = { k:'Binary', op:'|', left:l, right:this.parseBitXor() }; }
      return l;
    }
    parseBitXor() {
      let l = this.parseBitAnd();
      while (this.atOp('^')) { this.next(); l = { k:'Binary', op:'^', left:l, right:this.parseBitAnd() }; }
      return l;
    }
    parseBitAnd() {
      let l = this.parseShift();
      while (this.atOp('&')) { this.next(); l = { k:'Binary', op:'&', left:l, right:this.parseShift() }; }
      return l;
    }
    parseShift() {
      let l = this.parseAdd();
      while (this.atOp('<<') || this.atOp('>>')) { const op = this.next().v; l = { k:'Binary', op, left:l, right:this.parseAdd() }; }
      return l;
    }
    parseAdd() {
      let l = this.parseMul();
      while (this.atOp('+') || this.atOp('-')) { const op = this.next().v; l = { k:'Binary', op, left:l, right:this.parseMul() }; }
      return l;
    }
    parseMul() {
      let l = this.parseUnary();
      while (this.atOp('*') || this.atOp('/') || this.atOp('%') || this.atOp('//')) { const op = this.next().v; l = { k:'Binary', op, left:l, right:this.parseUnary() }; }
      return l;
    }
    parseUnary() {
      if (this.atOp('!') || this.atKw('not')) { this.next(); return { k:'Unary', op:'!', expr:this.parseUnary() }; }
      if (this.atOp('-')) { this.next(); return { k:'Unary', op:'-', expr:this.parseUnary() }; }
      if (this.atOp('+')) { this.next(); return { k:'Unary', op:'+', expr:this.parseUnary() }; }
      if (this.atOp('~')) { this.next(); return { k:'Unary', op:'~', expr:this.parseUnary() }; }
      if (this.atOp('++') || this.atOp('--')) { const op = this.next().v; const target = this.parseUnary();
        return { k:'PreIncDec', op, target }; }
      return this.parsePow();
    }
    parsePow() {
      const base = this.parsePostfix();
      if (this.atOp('**')) { this.next(); const exp = this.parseUnary(); return { k:'Binary', op:'**', left:base, right:exp }; }
      return base;
    }
    parsePostfix() {
      let e = this.parsePrimary();
      for (;;) {
        if (this.atOp('.')) {
          this.next();
          const name = this.next().v;
          if (this.atOp('(')) {
            this.next();
            const args = this.parseArgs();
            e = { k:'MethodCall', obj:e, name, args };
          } else {
            e = { k:'Member', obj:e, name };
          }
        } else if (this.atOp('[')) {
          this.next();
          const idx = this.parseExpr();
          this.expectOp(']');
          e = { k:'Index', obj:e, index: idx };
        } else if (this.atOp('(')) {
          this.next();
          const args = this.parseArgs();
          e = { k:'Call', callee:e, args };
        } else if (this.atOp('++') || this.atOp('--')) {
          const op = this.next().v;
          e = { k:'PostIncDec', op, target:e };
        } else break;
      }
      return e;
    }
    parseArgs() {
      const args = [];
      while (!this.atOp(')')) {
        if (this.atOp('...')) { this.next(); args.push({ k:'Spread', expr: this.parseExpr() }); }
        else args.push(this.parseExpr());
        if (this.atOp(',')) this.next();
      }
      this.expectOp(')');
      return args;
    }
    parsePrimary() {
      const tk = this.peek();
      if (tk.t === 'NUM') { this.next(); return { k:'Num', value: tk.v }; }
      if (tk.t === 'STR') { this.next(); return { k:'Str', value: tk.v }; }
      if (this.atKw('true')) { this.next(); return { k:'Bool', value:true }; }
      if (this.atKw('false')) { this.next(); return { k:'Bool', value:false }; }
      if (this.atKw('null')) { this.next(); return { k:'Null' }; }
      if (this.atOp('(')) { this.next(); const e = this.parseExpr(); this.expectOp(')'); return e; }
      if (this.atOp('[')) {
        this.next();
        const items = [];
        while (!this.atOp(']')) {
          if (this.atOp('...')) { this.next(); items.push({ k:'Spread', expr: this.parseExpr() }); }
          else items.push(this.parseExpr());
          if (this.atOp(',')) this.next();
        }
        this.expectOp(']');
        return { k:'ArrayLit', items };
      }
      if (this.atOp('{')) {
        this.next();
        const pairs = [];
        while (!this.atOp('}')) {
          if (this.atOp('**')) {
            this.next();
            const spreadExpr = this.parseExpr();
            pairs.push({ spread: spreadExpr });
          } else {
            const key = this.parseExpr();
            this.expectOp(':');
            const val = this.parseExpr();
            pairs.push({ key, val });
          }
          if (this.atOp(',')) this.next();
        }
        this.expectOp('}');
        return { k:'DictLit', pairs };
      }
      if (this.atKw('function')) {
        this.next();
        this.expectOp('(');
        const params = this.parseParamList();
        this.expectOp(')');
        const body = this.parseBlock();
        return { k:'FuncExpr', params, body };
      }
      if (tk.t === 'IDENT') { this.next(); return { k:'Ident', name: tk.v }; }
      throw new ParseErr(`Unexpected token "${tk.v}" (line ${tk.line})`);
    }
  }

  /* ────────────────────────────────────────────────────────────────
     3. RUNTIME VALUES + BUILTINS
  ──────────────────────────────────────────────────────────────── */
  class BreakSig {}
  class ContinueSig {}
  class ReturnSig { constructor(v){ this.value = v; } }
  class ThrowSig { constructor(v){ this.value = v; } }
  class ExitSig { constructor(code){ this.code = code; } }
  const BUILTIN_NAMES = new Set([
    'Number','abs','array','ast_literal_eval','base64_encode','base64_decode','bin','bool','bytearray','bytes','ceil','chr','collections_counter','dict','filter','float',
    'floor','format_rs','hex','int','join','json_dumps','json_loads','len','list','lower','map',
    'math_cos','math_factorial','math_fsum','math_gcd','math_log','math_sin','math_tan','max','min','oct',
    'ord','parseFloat','parseInt','pop','pow','print','printf','println_rs','printraw','push',
    'accumulate','chain','product','permutations','combinations','islice','repeat','starmap','cycle','compress','ThreadPoolExecutor',
    'np_array','np_arange','np_zeros','np_ones','np_linspace','np_sum','np_mean','np_min','np_max','np_std','np_abs','np_dot','pd_series','StringIO','urlparse','collections_deque','partial','repr',
    'pydecode','pydel','pydivmod','pyencode','pyfixed','pyfloat','pygetattr','pyhasattr','pyin','pyint',
    'pyisinstance','pyreversed','pysetattr',
    'pystr','pyslicestep','pytype','type','bytes_fromhex','pybytes','pybool','random_choice','random_randint','random_random','random_shuffle','random_uniform',
    'range','read_float','read_int','read_line','read_token','read_token_auto','reduce','round',
    'pyprint','pyprintraw','pyprintx','iter','next','tuple',
    're_match','re_search','re_fullmatch','re_findall','re_finditer','re_sub','re_subn','re_split','re_compile','re_escape',
    'slice','split','sprintf','sqrt','str','substr','sys_exit','trim','truediv','upper'
  ]);

  class Closure {
    constructor(params, body, scopes, defaultValues) { this.params = params; this.body = body; this.scopes = scopes; this.defaultValues = defaultValues || []; }
  }
  class BuiltinRef {
    constructor(name) { this.name = name; }
  }
  // Represents a bare, uninvoked instance-method reference like
  // `str.isdigit` (used e.g. as `filter(str.isdigit, s)`) - `str` alone
  // resolves to a BuiltinRef, and `.isdigit` on that has no instance to
  // dispatch against yet. invoke() calls it by treating the first
  // argument it's given as that missing instance and routing to the
  // ordinary callMethod dispatch, exactly like Python's own
  // unbound-method-as-first-class-value behavior.
  class UnboundMethodRef {
    constructor(typeName, methodName) { this.typeName = typeName; this.methodName = methodName; }
  }
  // functools.partial(fn, *bound_args) - a callable that, when invoked
  // with further arguments, calls fn(bound_args..., further_args...).
  class PartialRef {
    constructor(fn, boundArgs) { this.fn = fn; this.boundArgs = boundArgs; }
  }
  class PyClass {
    constructor(name, bases) {
      this.name = name;
      this.bases = bases; // array of PyClass
      this.methods = new Map(); // name -> { closure, kind: 'instance'|'static'|'classmethod'|'property'|'setter' }
      this.classVars = new Map();
    }
    // depth-first left-to-right lookup (simple MRO approximation - fine for
    // the common single/simple-multiple-inheritance cases; does not
    // implement full C3 linearization)
    findMethod(name, skipSelf) {
      if (!skipSelf && this.methods.has(name)) return { method: this.methods.get(name), owner: this };
      for (const b of this.bases) { const found = b.findMethod(name, false); if (found) return found; }
      return null;
    }
    findClassVar(name) {
      if (this.classVars.has(name)) return this.classVars.get(name);
      for (const b of this.bases) { const v = b.findClassVar(name); if (v !== undefined) return v; }
      return undefined;
    }
    isSubclassOf(other) {
      if (this === other) return true;
      return this.bases.some(b => b.isSubclassOf(other));
    }
  }
  class PyInstance {
    constructor(cls) { this.cls = cls; this.attrs = new Map(); }
  }
  // Backs iter()/next(). Deliberately simple: the whole source is eagerly
  // materialized into an array up front (via toIterableArr, which already
  // handles lists/strings/dicts/ranges/custom __iter__ objects), and next()
  // just walks a cursor over it. That's not lazy like a real Python
  // generator, but it's the same eager-list approach the rest of this
  // engine already uses for `for` loops, so it stays consistent and doesn't
  // add a second, divergent iteration model.
  class PyIterator {
    constructor(items) { this.items = items; this.i = 0; }
  }
  // Backs the `re` module. `raw` is the JS RegExpExecArray from a match
  // built with the 'd' (hasIndices) flag, so raw.indices[i] gives each
  // group's [start,end] and raw.indices.groups gives the same for named
  // groups - that's what group()/start()/end()/span() read from.
  class PyMatch {
    constructor(raw, input) { this.raw = raw; this.input = input; }
  }
  class PyRegex {
    constructor(pattern, flags) { this.pattern = pattern; this.flags = flags || 0; }
  }
  // concurrent.futures.ThreadPoolExecutor shim: this sandbox is single-
  // threaded JS with no worker-thread access (exposing that would be its
  // own security surface), so real concurrency isn't on offer - .map()
  // instead runs sequentially. For pure functions over independent inputs
  // (the overwhelmingly common use of executor.map, including str/int/etc.
  // over a range) the *result* is identical either way; only wall-clock
  // parallelism is not simulated. .submit()/.shutdown() aren't provided,
  // to avoid implying futures/async semantics this shim doesn't have.
  class PyExecutor {}
  // itertools.cycle() is genuinely infinite, which has no materialized
  // form this eager-array engine could return. Rather than skip it
  // entirely (like count(), which really has no bounded use), this marks
  // the base pattern so the two things that commonly consume a cycle()
  // in bounded ways - compress() (bounded by the other argument) and
  // islice() (bounded by an explicit count) - can repeat through it
  // without ever materializing an infinite array. Using a bare cycle()
  // anywhere else (a for-loop, list(), ...) raises a clear error instead
  // of hanging.
  class CycleMarker {
    constructor(base) { this.base = base; }
  }
  // io.StringIO - a plain in-memory string buffer. Zero security surface
  // (no real file descriptor, no filesystem/OS access whatsoever - just
  // an array of appended strings joined on demand), so this is safe to
  // support fully rather than declining it the way real file I/O would
  // need to be declined.
  class PyStringIO {
    constructor(initial) { this.parts = initial ? [initial] : []; }
  }
  // urllib.parse.urlparse - pure string splitting, no DNS lookups, no
  // sockets, no network access of any kind, so (like StringIO) this has
  // zero security surface and is safe to implement fully rather than
  // declining it.
  class PyUrlParseResult {
    constructor(scheme, netloc, path, params, query, fragment) {
      this.scheme = scheme; this.netloc = netloc; this.path = path;
      this.params = params; this.query = query; this.fragment = fragment;
    }
  }
  function pyUrlParse(url) {
    let rest = url, scheme = '';
    const schemeMatch = rest.match(/^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s);
    if (schemeMatch) { scheme = schemeMatch[1].toLowerCase(); rest = schemeMatch[2]; }
    let netloc = '';
    if (rest.startsWith('//')) {
      rest = rest.slice(2);
      const end = rest.search(/[/?#]/);
      netloc = end === -1 ? rest : rest.slice(0, end);
      rest = end === -1 ? '' : rest.slice(end);
    }
    let fragment = '';
    const hashIdx = rest.indexOf('#');
    if (hashIdx !== -1) { fragment = rest.slice(hashIdx + 1); rest = rest.slice(0, hashIdx); }
    let query = '';
    const qIdx = rest.indexOf('?');
    if (qIdx !== -1) { query = rest.slice(qIdx + 1); rest = rest.slice(0, qIdx); }
    let params = '';
    const semiIdx = rest.lastIndexOf(';');
    if (semiIdx !== -1 && rest.indexOf('/', semiIdx) === -1) { params = rest.slice(semiIdx + 1); rest = rest.slice(0, semiIdx); }
    return new PyUrlParseResult(scheme, netloc, rest, params, query, fragment);
  }
  // numpy-lite: a deliberately small, explicitly-scoped shim, not a real
  // NumPy port. 1-D arrays of plain numbers only - no N-D shapes, no
  // broadcasting beyond "array op scalar" and "array op same-length
  // array", no dtypes, no linear algebra, no real vectorized/SIMD
  // performance (it's just JS array methods under the hood, run
  // element-by-element). Wrapped in its own class specifically so
  // `+`/`-`/`*`/`/` can mean elementwise math here while meaning
  // concatenation/repetition for plain Python lists elsewhere - the two
  // can't share a representation.
  class NDArray {
    constructor(data) { this.data = data; }
  }
  // pandas-lite: Series only, no DataFrame - a Series is just NDArray's
  // data plus a parallel index array. Boolean-mask indexing (s[mask]) and
  // label-based scalar indexing are supported; no automatic index
  // alignment between two Series in arithmetic (real pandas' signature
  // behavior - matching it exactly would need real join semantics this
  // shim doesn't have), no groupby/merge/DataFrame. Arithmetic between a
  // Series and a scalar, or two equal-length Series, reuses NDArray's
  // elementwise logic positionally.
  class Series {
    constructor(data, index) { this.data = data; this.index = index; }
  }
  class BoundMethod {
    constructor(closure, self) { this.closure = closure; this.self = self; }
  }
  class SuperProxy {
    constructor(instance, fromClass) { this.instance = instance; this.fromClass = fromClass; }
  }

  class RangeObj {
    constructor(a,b,step){ this.a=a; this.b=b; this.step=step||1; }
    toArray() {
      const out = []; const cap = 2000000;
      if (this.step > 0) for (let i=this.a; i<this.b && out.length<cap; i+=this.step) out.push(i);
      else for (let i=this.a; i>this.b && out.length<cap; i+=this.step) out.push(i);
      return out;
    }
  }

  function truthy(v) {
    if (v === null || v === undefined) return false;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map) return v.size > 0;
    return !!v;
  }

  function toStr(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v instanceof Closure) return '<function>';
    if (v instanceof PyIterator) return '<iterator object>';
    if (v instanceof PyMatch) { const s = v.raw.index, e = s + (v.raw[0] ? v.raw[0].length : 0); return `<re.Match object; span=(${s}, ${e}), match='${v.raw[0]}'>`; }
    if (v instanceof PyRegex) return `re.compile('${v.pattern}')`;
    if (v instanceof PyUrlParseResult) return `ParseResult(scheme='${v.scheme}', netloc='${v.netloc}', path='${v.path}', params='${v.params}', query='${v.query}', fragment='${v.fragment}')`;
    if (v instanceof NDArray) return 'array([' + v.data.map(x => typeof x === 'string' ? x : toStr(x)).join(', ') + '])';
    if (v instanceof Series) {
      const lines = v.data.map((val, i) => `${v.index[i]}    ${typeof val === 'string' ? val : toStr(val)}`);
      let dtype = 'object';
      if (v.data.length && v.data.every(x => typeof x === 'number' && Number.isInteger(x))) dtype = 'int64';
      else if (v.data.length && v.data.every(x => typeof x === 'number')) dtype = 'float64';
      else if (v.data.length && v.data.every(x => typeof x === 'boolean')) dtype = 'bool';
      return lines.join('\n') + (lines.length ? '\n' : '') + `dtype: ${dtype}`;
    }
    if (Array.isArray(v)) return '[' + v.map(x => typeof x==='string' ? x : toStr(x)).join(', ') + ']';
    if (v instanceof Map) return '{' + Array.from(v.entries()).map(([k, val]) => toStr(k) + ': ' + (typeof val === 'string' ? val : toStr(val))).join(', ') + '}';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
    return String(v);
  }

  // Runtime counterpart of python-compiler.js's compile-time .format()
  // handling: that one only works when the format string is a literal
  // (it has to parse out the {} placeholders at compile time), so a
  // format string built at runtime - a variable, a function return value,
  // etc. - fell straight through unconverted before this existed. Only
  // positional fields ({}, {0}, {1}, ...) are supported here, matching
  // what this engine's calling convention can express at runtime - there
  // is no keyword-argument mechanism to look up {name} against (kwargs
  // are handled at compile time per call site, not as a runtime dict).
  function runtimeFormat(template, args) {
    let out = '', i = 0, autoIdx = 0;
    const n = template.length;
    while (i < n) {
      const c = template[i];
      if (c === '{' && template[i + 1] === '{') { out += '{'; i += 2; continue; }
      if (c === '}' && template[i + 1] === '}') { out += '}'; i += 2; continue; }
      if (c === '{') {
        const close = template.indexOf('}', i);
        if (close === -1) { out += template.slice(i); break; }
        const inner = template.slice(i + 1, close);
        const colonIdx = inner.indexOf(':');
        const keyPart = colonIdx >= 0 ? inner.slice(0, colonIdx) : inner;
        const specPart = colonIdx >= 0 ? inner.slice(colonIdx + 1) : null;
        let value;
        if (keyPart === '') value = args[autoIdx++];
        else if (/^\d+$/.test(keyPart)) value = args[parseInt(keyPart, 10)];
        else throw new RuntimeErr(`str.format(): named/keyword fields like "{${keyPart}}" aren't supported when the format string isn't a literal - use positional "{}"/"{0}" fields, or call .format() directly on a string literal.`);
        out += specPart ? runtimeFormatSpec(value, specPart) : toStr(value);
        i = close + 1;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  function runtimeFormatSpec(value, spec) {
    const m = spec.match(/^([<>^]?)(\d*)(?:\.(\d+))?([fdxXob%]?)$/);
    if (!m) return toStr(value);
    const [, align, width, prec, type] = m;
    const p = prec !== undefined ? parseInt(prec, 10) : 6;
    let s;
    if (type === 'f') s = toNum(value).toFixed(p);
    else if (type === 'd') s = String(Math.trunc(toNum(value)));
    else if (type === '%') s = (toNum(value) * 100).toFixed(p) + '%';
    else if (type === 'x') s = Math.trunc(toNum(value)).toString(16);
    else if (type === 'X') s = Math.trunc(toNum(value)).toString(16).toUpperCase();
    else if (type === 'o') s = Math.trunc(toNum(value)).toString(8);
    else if (type === 'b') s = Math.trunc(toNum(value)).toString(2);
    else s = toStr(value);
    if (width) {
      const w = parseInt(width, 10);
      const padlen = w - s.length;
      if (padlen > 0) {
        const pad = ' '.repeat(padlen);
        if (align === '<') s = s + pad;
        else if (align === '^') { const half = Math.floor(padlen / 2); s = ' '.repeat(half) + s + ' '.repeat(padlen - half); }
        else s = pad + s;
      }
    }
    return s;
  }

  // Fully recursive Python-style repr, used by the pystr() builtin so
  // Python programs get correctly-quoted/capitalised nested output
  // (e.g. print([True, "a", {"x": None}]) -> [True, 'a', {'x': None}]).
  // Only used for Python; other languages keep using toStr() above.
  function pyReprInner(v, execRef) {
    if (v === true) return 'True';
    if (v === false) return 'False';
    if (v === null || v === undefined) return 'None';
    if (typeof v === 'string') return "'" + v + "'";
    if (Array.isArray(v)) return '[' + v.map(x => pyReprInner(x, execRef)).join(', ') + ']';
    if (v instanceof Map) return '{' + Array.from(v.entries()).map(([k, val]) => pyReprInner(k, execRef) + ': ' + pyReprInner(val, execRef)).join(', ') + '}';
    if (v instanceof PyInstance && execRef) {
      const f = v.cls.findMethod('__repr__') || v.cls.findMethod('__str__');
      if (f) return toStr(execRef.callMethodEntry(f.method, f.owner, v, []));
      return `<${v.cls.name} object>`;
    }
    return toStr(v);
  }

  function pystrValue(v, execRef) {
    if (v === true) return 'True';
    if (v === false) return 'False';
    if (v === null || v === undefined) return 'None';
    if (v instanceof PyInstance && execRef) {
      const f = v.cls.findMethod('__str__') || v.cls.findMethod('__repr__');
      if (f) return toStr(execRef.callMethodEntry(f.method, f.owner, v, []));
      return `<${v.cls.name} object>`;
    }
    if (Array.isArray(v) || v instanceof Map) return pyReprInner(v, execRef);
    return toStr(v);
  }

  function toNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string') { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
    return 0;
  }

  // very small printf/format engine — used by C printf(), Go Printf, etc.
  function formatPrintf(fmt, args) {
    let ai = 0, out = '';
    for (let i = 0; i < fmt.length; i++) {
      if (fmt[i] === '%' && i+1 < fmt.length) {
        let j = i+1;
        while (j < fmt.length && /[-+0-9.]/.test(fmt[j])) j++;
        const spec = fmt[j];
        const arg = args[ai++];
        if (spec === 'd' || spec === 'i') out += String(Math.trunc(toNum(arg)));
        else if (spec === 'f') {
          const m = fmt.slice(i+1,j).match(/\.(\d+)/);
          const prec = m ? parseInt(m[1]) : 6;
          out += toNum(arg).toFixed(prec);
        }
        else if (spec === 's') out += toStr(arg);
        else if (spec === 'c') out += String.fromCharCode(toNum(arg));
        else if (spec === 'x') out += Math.trunc(toNum(arg)).toString(16);
        else if (spec === '%') { out += '%'; ai--; }
        else out += fmt.slice(i, j+1);
        i = j; continue;
      }
      out += fmt[i];
    }
    return out;
  }
  // Rust/Kotlin-style "{}" placeholder formatting
  function formatBraces(fmt, args) {
    let ai = 0;
    return fmt.replace(/\{\}/g, () => toStr(args[ai++]));
  }

  /* ────────────────────────────────────────────────────────────────
     4. EVALUATOR
  ──────────────────────────────────────────────────────────────── */
  // Translates the common, practical subset of Python regex syntax to JS
  // RegExp syntax. The two are already very close (character classes,
  // quantifiers, groups, anchors, backreferences by number all match), so
  // this only needs to handle the handful of spots they diverge:
  //   (?P<name>...)  ->  (?<name>...)   named group definition
  //   (?P=name)      ->  \k<name>       named backreference
  //   \A / \Z        ->  ^ / $          Python's always-string-edge anchors
  //                                     (an approximation: JS ^/$ shift
  //                                     meaning under the multiline flag,
  //                                     while \A/\Z never do in Python)
  // Anything else is passed through untouched.
  function pyRegexToJs(pattern) {
    return String(pattern)
      .replace(/\(\?P<([^>]+)>/g, '(?<$1>')
      .replace(/\(\?P=([A-Za-z_]\w*)\)/g, '\\k<$1>')
      .replace(/\\A/g, '^')
      .replace(/\\Z/g, '$');
  }
  function pyRegexFlagsToJs(flags, extra) {
    let f = extra || '';
    const n = Math.trunc(toNum(flags || 0));
    if (n & 2) f += 'i';   // re.IGNORECASE
    if (n & 8) f += 'm';   // re.MULTILINE
    if (n & 16) f += 's';  // re.DOTALL
    return f;
  }
  function buildJsRegex(pattern, flags, extra) {
    try {
      return new RegExp(pyRegexToJs(pattern), pyRegexFlagsToJs(flags, extra));
    } catch (e) {
      throw new RuntimeErr(`Invalid regular expression: ${e.message}`);
    }
  }

  function toIterableArr(v, execRef) {
    if (v instanceof PyInstance && execRef) {
      const f = v.cls.findMethod('__iter__');
      if (f) v = execRef.callMethodEntry(f.method, f.owner, v, []);
    }
    if (v instanceof PyIterator) return v.items.slice(v.i);
    if (v instanceof RangeObj) return v.toArray();
    if (v instanceof NDArray) return v.data;
    if (v instanceof Series) return v.data;
    if (v instanceof CycleMarker) throw new RuntimeErr('itertools.cycle() is infinite and can only be used inside compress() or islice() in this sandbox (nothing here supports lazy/infinite iteration) - wrap it, e.g. islice(cycle(x), n).');
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v.split('');
    if (v instanceof Map) return Array.from(v.keys());
    return [];
  }

  function pyToPlain(v) {
    if (v instanceof Map) { const o = {}; for (const [k, val] of v) o[k] = pyToPlain(val); return o; }
    if (Array.isArray(v)) return v.map(pyToPlain);
    return v;
  }
  function plainToPy(v) {
    if (Array.isArray(v)) return v.map(plainToPy);
    if (v !== null && typeof v === 'object') { const m = new Map(); for (const k of Object.keys(v)) m.set(k, plainToPy(v[k])); return m; }
    return v;
  }

  class Exec {
    // ast.literal_eval(s): parses `s` with this engine's own lexer/parser
    // (never JS eval - no arbitrary code can run) and evaluates the result
    // ONLY if every node is one of the literal forms real Python's
    // ast.literal_eval accepts: numbers, strings, True/False/None, unary
    // +/- of a number, +/- between two such literals (this is what lets
    // Python's own literal_eval read complex-number-looking sums like
    // `1+2j`, and incidentally plain sums like `3 + 4`), lists, and
    // dicts. Anything else - names, calls, comparisons, comprehensions -
    // is rejected with a ValueError-style message, matching CPython's
    // "malformed node or string" behavior, rather than silently running.
    astLiteralEval(src) {
      const fail = () => { throw new RuntimeErr(`malformed node or string: ${src}`); };
      let toks;
      try { toks = lex(src, {}); } catch (e) { fail(); }
      // Python spells these True/False/None; this canonical grammar
      // spells them true/false/null. Retag just those specific IDENT
      // tokens to the engine's own keyword spelling - this never touches
      // STR tokens, so it can't reach inside an actual quoted string.
      for (const t of toks) {
        if (t.t === 'IDENT' && t.v === 'True') { t.t = 'KW'; t.v = 'true'; }
        else if (t.t === 'IDENT' && t.v === 'False') { t.t = 'KW'; t.v = 'false'; }
        else if (t.t === 'IDENT' && t.v === 'None') { t.t = 'KW'; t.v = 'null'; }
      }
      let node, parser;
      try {
        parser = new Parser(toks);
        node = parser.parseExpr();
        if (parser.peek().t !== 'EOF') fail();
      } catch (e) { fail(); }
      const walk = (n) => {
        switch (n.k) {
          case 'Num': return n.value;
          case 'Str': return n.value;
          case 'Bool': return n.value;
          case 'Null': return null;
          case 'Unary':
            if (n.op === '-' || n.op === '+') {
              const v = walk(n.expr);
              if (typeof v !== 'number') fail();
              return n.op === '-' ? -v : v;
            }
            return fail();
          case 'Binary':
            if (n.op === '+' || n.op === '-') {
              const l = walk(n.left), r = walk(n.right);
              if (typeof l !== 'number' || typeof r !== 'number') fail();
              return n.op === '+' ? l + r : l - r;
            }
            return fail();
          case 'ArrayLit':
            return n.items.map(it => it.k === 'Spread' ? fail() : walk(it));
          case 'DictLit': {
            const m = new Map();
            for (const p of n.pairs) { if (p.spread) fail(); m.set(walk(p.key), walk(p.val)); }
            return m;
          }
          default: return fail();
        }
      };
      return walk(node);
    }
    constructor(stdin) {
      this.src = stdin || '';
      this.pos = 0;
      this.out = '';
      this.globals = new Map();
    }

    // ── stdin cursor helpers ──
    readLine() {
      if (this.pos >= this.src.length) return '';
      let j = this.src.indexOf('\n', this.pos);
      if (j === -1) j = this.src.length;
      const line = this.src.slice(this.pos, j).replace(/\r$/, '');
      this.pos = j + 1;
      return line;
    }
    readToken() {
      while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
      let j = this.pos;
      while (j < this.src.length && !/\s/.test(this.src[j])) j++;
      const tok = this.src.slice(this.pos, j);
      this.pos = j;
      return tok;
    }
    readInt()   { return parseInt(this.readToken(), 10) || 0; }
    readFloat() { return parseFloat(this.readToken()) || 0; }

    write(s) {
      this.out += s;
      if (this.out.length > 2_000_000) throw new RuntimeErr('Output limit exceeded (2,000,000 characters) - likely a runaway print loop.');
    }
    writeln(s) { this.write(s + '\n'); }

    run(ast) {
      // hoist function defs first (so calls work regardless of source order)
      for (const st of ast.body) if (st.k === 'FuncDef') {
        this.globals.set(st.name, new Closure(st.params, st.body, [this.globals], this.evalDefaults(st.params, [this.globals])));
      }
      const scope = this.globals;
      try {
        for (const st of ast.body) {
          if (st.k === 'FuncDef') continue;
          this.execStmt(st, [scope]);
        }
      } catch (e) {
        if (e instanceof ExitSig) return;
        throw e;
      }
    }

    lookup(scopes, name) {
      for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i];
      return scopes[scopes.length - 1];
    }

    execBlock(body, scopes, stepLimit) {
      for (const st of body) this.execStmt(st, scopes);
    }

    execStmt(st, scopes) {
      this._steps = (this._steps || 0) + 1;
      if (this._steps > 3000000) throw new RuntimeErr('Execution limit exceeded (possible infinite loop).');
      switch (st.k) {
        case 'ExprStmt': this.evalExpr(st.expr, scopes); return;
        case 'Assign': {
          const val = this.evalExpr(st.expr, scopes);
          this.assignTo(st.target, val, scopes);
          return;
        }
        case 'VarDecl': {
          // Always binds in the CURRENT (innermost) scope - never walks
          // up to reuse/mutate an outer scope's variable of the same
          // name, unlike plain Assign (see assignTo/lookup). That's what
          // makes `let x = ...` actually shadow an outer `x` instead of
          // silently aliasing it - critical for e.g. two nested function
          // scopes that each declare their own same-named helper
          // variable (a real bug this fixed: two nested comprehension
          // IIFEs both naming their accumulator `__out` - the inner one
          // was reassigning the outer's __out instead of shadowing it,
          // so the outer loop ended up iterating the very array it was
          // also pushing into, growing forever).
          scopes[scopes.length - 1].set(st.name, this.evalExpr(st.expr, scopes));
          return;
        }
        case 'If': {
          if (this.pyTruthy(this.evalExpr(st.cond, scopes))) this.execBlock(st.then, scopes);
          else if (st.elseBody) this.execBlock(st.elseBody, scopes);
          return;
        }
        case 'While': {
          while (this.pyTruthy(this.evalExpr(st.cond, scopes))) {
            try { this.execBlock(st.body, scopes); }
            catch (e) { if (e instanceof BreakSig) break; if (e instanceof ContinueSig) continue; throw e; }
          }
          return;
        }
        case 'ForC': {
          if (st.init) this.execStmt(st.init, scopes);
          while (st.cond === null || this.pyTruthy(this.evalExpr(st.cond, scopes))) {
            try { this.execBlock(st.body, scopes); }
            catch (e) { if (e instanceof BreakSig) break; if (!(e instanceof ContinueSig)) throw e; }
            if (st.update) this.execStmt(st.update, scopes);
          }
          return;
        }
        case 'ForIn': {
          const iterVal = this.evalExpr(st.iter, scopes);
          const items = toIterableArr(iterVal, this);
          const local = new Map(scopes[scopes.length-1] === this.globals ? [] : []);
          const innerScopes = scopes;
          for (const item of items) {
            innerScopes[innerScopes.length-1].set(st.varName, item);
            try { this.execBlock(st.body, innerScopes); }
            catch (e) { if (e instanceof BreakSig) break; if (e instanceof ContinueSig) continue; throw e; }
          }
          return;
        }
        case 'FuncDef': {
          scopes[scopes.length - 1].set(st.name, new Closure(st.params, st.body, scopes.slice(), this.evalDefaults(st.params, scopes)));
          return;
        }
        case 'ClassDef': {
          const bases = st.bases.map(b => this.evalExpr(b, scopes));
          const cls = new PyClass(st.name, bases.filter(b => b instanceof PyClass));
          const capturedScopes = scopes.slice();
          for (const m of st.methods) {
            const closure = new Closure(m.params, m.body, capturedScopes, this.evalDefaults(m.params, capturedScopes));
            let kind = 'instance';
            if (m.decorators.includes('staticmethod')) kind = 'static';
            else if (m.decorators.includes('classmethod')) kind = 'classmethod';
            else if (m.decorators.includes('property')) kind = 'property';
            else if (m.decorators.some(d => d.endsWith('.setter'))) kind = 'setter';
            cls.methods.set(m.name, { closure, kind });
          }
          const classScope = new Map();
          for (const cst of st.classVarStmts) {
            if (cst.k === 'Assign') {
              this.execStmt(cst, [...capturedScopes, classScope]);
            }
          }
          for (const [k, v] of classScope) cls.classVars.set(k, v);
          scopes[scopes.length - 1].set(st.name, cls);
          return;
        }
        case 'Return': throw new ReturnSig(st.expr ? this.evalExpr(st.expr, scopes) : null);
        case 'Throw': throw new ThrowSig(this.evalExpr(st.expr, scopes));
        case 'Try': {
          try {
            try {
              this.execBlock(st.block, scopes);
            } catch (e) {
              if (e instanceof BreakSig || e instanceof ContinueSig || e instanceof ReturnSig || e instanceof ExitSig) throw e;
              if (st.catchBody) {
                const errVal = (e instanceof ThrowSig) ? e.value : (e && e.message !== undefined ? e.message : String(e));
                if (st.catchVar) scopes[scopes.length - 1].set(st.catchVar, errVal);
                this.execBlock(st.catchBody, scopes);
                return;
              }
              throw e;
            }
          } finally {
            if (st.finallyBody) this.execBlock(st.finallyBody, scopes);
          }
          return;
        }
        case 'Break': throw new BreakSig();
        case 'Continue': throw new ContinueSig();
        case 'Block': this.execBlock(st.body, scopes); return;
        default: throw new RuntimeErr('Unknown statement: ' + st.k);
      }
    }

    assignTo(target, val, scopes) {
      if (target.k === 'Ident') {
        const scope = this.lookup(scopes, target.name);
        scope.set(target.name, val);
        return;
      }
      if (target.k === 'Member') {
        const obj = this.evalExpr(target.obj, scopes);
        if (obj instanceof PyInstance) {
          const found = obj.cls.findMethod(target.name);
          if (found && found.method.kind === 'setter') { this.callClosure(found.method.closure, [obj, val], found.owner); return; }
          obj.attrs.set(target.name, val);
          return;
        }
        if (obj instanceof PyClass) { obj.classVars.set(target.name, val); return; }
        throw new RuntimeErr(`Cannot set attribute ".${target.name}" on this value.`);
      }
      if (target.k === 'Index') {
        const obj = this.evalExpr(target.obj, scopes);
        const idx = this.evalExpr(target.index, scopes);
        if (obj instanceof PyInstance) {
          const found = obj.cls.findMethod('__setitem__');
          if (found) { this.callMethodEntry(found.method, found.owner, obj, [idx, val]); return; }
          throw new RuntimeErr(`'${obj.cls.name}' object does not support item assignment`);
        }
        if (obj instanceof Map) { obj.set(idx, val); return; }
        if (Array.isArray(obj)) {
          const i = Math.trunc(toNum(idx));
          while (obj.length <= i) obj.push(0);
          obj[i] = val;
          return;
        }
        throw new RuntimeErr('Cannot index-assign a non-array value.');
      }
      throw new RuntimeErr('Invalid assignment target.');
    }

    getInstanceAttr(inst, name) {
      if (inst.attrs.has(name)) return inst.attrs.get(name);
      const found = inst.cls.findMethod(name);
      if (found) {
        if (found.method.kind === 'property') return this.callClosure(found.method.closure, [inst], found.owner);
        return new BoundMethod(found.method.closure, inst);
      }
      const cv = inst.cls.findClassVar(name);
      if (cv !== undefined) return cv;
      throw new RuntimeErr(`'${inst.cls.name}' object has no attribute '${name}'`);
    }

    findMethodFrom(classes, name) {
      for (const c of classes) { const found = c.findMethod(name); if (found) return found; }
      return null;
    }

    callMethodEntry(methodEntry, owner, instanceOrClass, args) {
      if (methodEntry.kind === 'static') return this.callClosure(methodEntry.closure, args, owner);
      if (methodEntry.kind === 'classmethod') {
        const cls = instanceOrClass instanceof PyClass ? instanceOrClass : instanceOrClass.cls;
        return this.callClosure(methodEntry.closure, [cls, ...args], owner);
      }
      return this.callClosure(methodEntry.closure, [instanceOrClass, ...args], owner);
    }

    evalDefaults(params, scopes) {
      return params.map(p => p.def !== null ? this.evalExpr(p.def, scopes) : undefined);
    }

    pyTruthy(v) {
      if (v instanceof PyInstance) {
        const boolFound = v.cls.findMethod('__bool__');
        if (boolFound) return truthy(this.callMethodEntry(boolFound.method, boolFound.owner, v, []));
        const lenFound = v.cls.findMethod('__len__');
        if (lenFound) return toNum(this.callMethodEntry(lenFound.method, lenFound.owner, v, [])) !== 0;
        return true;
      }
      return truthy(v);
    }

    invoke(val, args) {
      if (val instanceof Closure) return this.callClosure(val, args);
      if (val instanceof BuiltinRef) return this.callBuiltin(val.name, args);
      if (val instanceof UnboundMethodRef) return this.callMethod(args[0], val.methodName, args.slice(1));
      if (val instanceof PartialRef) return this.invoke(val.fn, [...val.boundArgs, ...args]);
      if (val instanceof PyClass) {
        const inst = new PyInstance(val);
        const found = val.findMethod('__init__');
        if (found) this.callClosure(found.method.closure, [inst, ...args], found.owner);
        return inst;
      }
      if (val instanceof BoundMethod) return this.callClosure(val.closure, [val.self, ...args]);
      throw new RuntimeErr('Value is not callable.');
    }

    callClosure(closure, args, definedInClass) {
      this._depth = (this._depth || 0) + 1;
      if (this._depth > 350) { this._depth--; throw new RuntimeErr('RecursionError: maximum recursion depth exceeded'); }
      try {
        const scope = new Map();
        closure.params.forEach((p, i) => scope.set(p.name, args[i] !== undefined ? args[i] : (closure.defaultValues[i] !== undefined ? closure.defaultValues[i] : null)));
        if (definedInClass) scope.set('__class__', definedInClass);
        const callScopes = [...closure.scopes, scope];
        try { this.execBlock(closure.body, callScopes); }
        catch (e) { if (e instanceof ReturnSig) return e.value; throw e; }
        return null;
      } finally {
        this._depth--;
      }
    }

    evalExpr(node, scopes) {
      switch (node.k) {
        case 'Num': return node.value;
        case 'Str': return node.value;
        case 'Bool': return node.value;
        case 'Null': return null;
        case 'Ident': {
          const scope = this.lookup(scopes, node.name);
          if (scope.has(node.name)) return scope.get(node.name);
          if (BUILTIN_NAMES.has(node.name)) return new BuiltinRef(node.name);
          throw new RuntimeErr(`Undefined variable "${node.name}".`);
        }
        case 'ArrayLit': {
          const out = [];
          for (const it of node.items) {
            if (it.k === 'Spread') { for (const x of toIterableArr(this.evalExpr(it.expr, scopes), this)) out.push(x); }
            else out.push(this.evalExpr(it, scopes));
          }
          return out;
        }
        case 'FuncExpr': return new Closure(node.params, node.body, scopes.slice(), this.evalDefaults(node.params, scopes));
        case 'DictLit': {
          const m = new Map();
          for (const p of node.pairs) {
            if (p.spread) {
              const src = this.evalExpr(p.spread, scopes);
              if (src instanceof Map) for (const [k, v] of src) m.set(k, v);
            } else {
              m.set(this.evalExpr(p.key, scopes), this.evalExpr(p.val, scopes));
            }
          }
          return m;
        }
        case 'Index': {
          const obj = this.evalExpr(node.obj, scopes);
          if (obj instanceof PyInstance) {
            const found = obj.cls.findMethod('__getitem__');
            if (found) return this.callMethodEntry(found.method, found.owner, obj, [this.evalExpr(node.index, scopes)]);
            throw new RuntimeErr(`'${obj.cls.name}' object is not subscriptable`);
          }
          if (obj instanceof Map) {
            const key = this.evalExpr(node.index, scopes);
            if (!obj.has(key)) throw new RuntimeErr(`Key ${toStr(key)} not found.`);
            return obj.get(key);
          }
          if (obj instanceof NDArray) {
            const idx = Math.trunc(toNum(this.evalExpr(node.index, scopes)));
            const i = idx < 0 ? obj.data.length + idx : idx;
            const v = obj.data[i];
            if (v === undefined) throw new RuntimeErr('index out of range');
            return v;
          }
          if (obj instanceof Series) {
            const key = this.evalExpr(node.index, scopes);
            const maskArr = key instanceof NDArray ? key.data : (key instanceof Series ? key.data : (Array.isArray(key) ? key : null));
            if (maskArr && maskArr.every(x => typeof x === 'boolean')) {
              const newData = [], newIndex = [];
              for (let i = 0; i < obj.data.length; i++) if (maskArr[i]) { newData.push(obj.data[i]); newIndex.push(obj.index[i]); }
              return new Series(newData, newIndex);
            }
            const pos = obj.index.findIndex(x => looseEq(x, key));
            if (pos === -1) throw new RuntimeErr(`${toStr(key)} not in index`);
            return obj.data[pos];
          }
          const idx = Math.trunc(toNum(this.evalExpr(node.index, scopes)));
          if (Array.isArray(obj) || typeof obj === 'string') {
            const i = idx < 0 ? obj.length + idx : idx;
            const v = obj[i];
            return v === undefined ? (typeof obj === 'string' ? '' : null) : v;
          }
          throw new RuntimeErr('Cannot index this value.');
        }
        case 'Member': {
          const obj = this.evalExpr(node.obj, scopes);
          if (obj instanceof PyInstance) return this.getInstanceAttr(obj, node.name);
          if (obj instanceof PyClass) {
            if (obj.classVars.has(node.name)) return obj.classVars.get(node.name);
            const found = obj.findMethod(node.name);
            if (found) return new BoundMethod(found.method.closure, obj);
            throw new RuntimeErr(`type object '${obj.name}' has no attribute '${node.name}'`);
          }
          if (obj instanceof SuperProxy) {
            const m = this.findMethodFrom(obj.fromClass.bases, node.name);
            if (m) return new BoundMethod(m.method.closure, obj.instance);
            throw new RuntimeErr(`'super' object has no attribute '${node.name}'`);
          }
          if (node.name === 'length') {
            if (Array.isArray(obj) || typeof obj === 'string') return obj.length;
          }
          if (obj instanceof Series) {
            if (node.name === 'index') return new NDArray(obj.index.slice());
            if (node.name === 'values') return new NDArray(obj.data.slice());
            throw new RuntimeErr(`'Series' object has no attribute '${node.name}'`);
          }
          if (obj instanceof PyUrlParseResult) {
            if (['scheme', 'netloc', 'path', 'params', 'query', 'fragment'].includes(node.name)) return obj[node.name];
            throw new RuntimeErr(`'ParseResult' object has no attribute '${node.name}'`);
          }
          if (obj instanceof BuiltinRef) return new UnboundMethodRef(obj.name, node.name);
          throw new RuntimeErr(`Unknown property ".${node.name}".`);
        }
        case 'MethodCall': {
          const obj = this.evalExpr(node.obj, scopes);
          const args = [];
          for (const a of node.args) {
            if (a.k === 'Spread') { for (const x of toIterableArr(this.evalExpr(a.expr, scopes), this)) args.push(x); }
            else args.push(this.evalExpr(a, scopes));
          }
          if (obj instanceof PyInstance) {
            const found = obj.cls.findMethod(node.name);
            if (found) return this.callMethodEntry(found.method, found.owner, obj, args);
            // fall through to dunder-less builtin method dispatch (e.g. list/dict methods
            // are never reached here since obj is a PyInstance, but keep a clear error)
            throw new RuntimeErr(`'${obj.cls.name}' object has no attribute '${node.name}'`);
          }
          if (obj instanceof PyClass) {
            const found = obj.findMethod(node.name);
            if (found) return this.callMethodEntry(found.method, found.owner, obj, args);
            throw new RuntimeErr(`type object '${obj.name}' has no attribute '${node.name}'`);
          }
          if (obj instanceof SuperProxy) {
            const m = this.findMethodFrom(obj.fromClass.bases, node.name);
            if (m) return this.callMethodEntry(m.method, m.owner, obj.instance, args);
            throw new RuntimeErr(`'super' object has no attribute '${node.name}'`);
          }
          return this.callMethod(obj, node.name, args);
        }
        case 'Unary': {
          const v = this.evalExpr(node.expr, scopes);
          if (v instanceof PyInstance) {
            const UNARY_DUNDER = { '-':'__neg__', '+':'__pos__', '~':'__invert__' };
            const dname = UNARY_DUNDER[node.op];
            if (dname) {
              const found = v.cls.findMethod(dname);
              if (found) return this.callMethodEntry(found.method, found.owner, v, []);
            }
          }
          if (node.op === '-') return -toNum(v);
          if (node.op === '+') return toNum(v);
          if (node.op === '~') return ~Math.trunc(toNum(v));
          if (node.op === '!') return !this.pyTruthy(v);
          break;
        }
        case 'PreIncDec': case 'PostIncDec': {
          const old = this.evalExpr(node.target, scopes);
          const nv = toNum(old) + (node.op === '++' ? 1 : -1);
          this.assignTo(node.target, nv, scopes);
          return node.k === 'PreIncDec' ? nv : old;
        }
        case 'Logical': {
          const l = this.evalExpr(node.left, scopes);
          if (node.op === '&&') return this.pyTruthy(l) ? this.evalExpr(node.right, scopes) : l;
          return this.pyTruthy(l) ? l : this.evalExpr(node.right, scopes);
        }
        case 'NamedExpr': {
          // Same scope-resolution as a plain `Assign` statement (see
          // assignTo/lookup above): if `name` already exists anywhere up
          // the scope chain (e.g. a variable from an enclosing scope that
          // a comprehension's IIFE closes over), that existing binding is
          // updated in place rather than shadowed - this is what makes
          // `[res := res + a[i] for i in ...]` correctly update the outer
          // `res` instead of a throwaway local one, matching Python's own
          // walrus-leaks-to-enclosing-scope behavior.
          const val = this.evalExpr(node.expr, scopes);
          this.assignTo({ k:'Ident', name: node.name }, val, scopes);
          return val;
        }
        case 'Binary': return this.evalBinary(node, scopes);
        case 'Call': {
          if (node.callee.k === 'Ident' && node.callee.name === 'super' && node.args.length === 0) {
            const selfScope = this.lookup(scopes, 'self');
            const classScope = this.lookup(scopes, '__class__');
            if (!selfScope.has('self') || !classScope.has('__class__')) throw new RuntimeErr('super() can only be used inside an instance method');
            return new SuperProxy(selfScope.get('self'), classScope.get('__class__'));
          }
          // locals()/globals() return the LIVE scope Map (not a snapshot
          // copy), so `locals()["x"] = v` / `globals()["x"] = v` actually
          // create a real variable afterward visible as bare `x` - this
          // matches real CPython's actual behavior for globals() (and for
          // locals() specifically at module/top level, where locals() and
          // globals() are literally the same dict - CPython does NOT
          // reliably support this trick for locals() *inside a function*,
          // an implementation detail of its own; this engine is a bit
          // more permissive there, which can only make more code work,
          // never less).
          if (node.callee.k === 'Ident' && node.callee.name === 'locals' && node.args.length === 0) return scopes[scopes.length - 1];
          if (node.callee.k === 'Ident' && node.callee.name === 'globals' && node.args.length === 0) return scopes[0];
          // exec() with a source string that wasn't known at compile
          // time (an f-string, a variable, ...) - python-compiler.js
          // routes those here instead of inlining them at compile time.
          // Transpiles and runs the code right now, in the CURRENT
          // scope, so e.g. a variable it assigns is visible to code
          // after the exec() call - matching Python's own default
          // exec() behavior. This runs the string through the exact
          // same restricted pipeline as any other code in this sandbox -
          // there's no additional capability exposed by the source
          // having been computed at runtime rather than written
          // directly, since the sandboxed language has no dangerous
          // primitives (no real file/network/OS access) either way.
          if (node.callee.k === 'Ident' && node.callee.name === 'pyexec' && node.args.length === 1) {
            const src = toStr(this.evalExpr(node.args[0], scopes));
            if (!pythonTranspile) throw new RuntimeErr('exec() is not available in this context.');
            let canonical;
            try { canonical = pythonTranspile(src); } catch (e) { throw new RuntimeErr(`exec(): ${e.message}`); }
            const toks = lex(canonical, { noSlashComments: true });
            const ast = new Parser(toks).parseProgram();
            this.execBlock(ast.body, scopes);
            return null;
          }
          const args = [];
          for (const a of node.args) {
            if (a.k === 'Spread') { for (const x of toIterableArr(this.evalExpr(a.expr, scopes), this)) args.push(x); }
            else args.push(this.evalExpr(a, scopes));
          }
          if (node.callee.k === 'Ident') {
            const name = node.callee.name;
            const scope = this.lookup(scopes, name);
            if (scope.has(name)) return this.invoke(scope.get(name), args);
            return this.callBuiltin(name, args);
          }
          return this.invoke(this.evalExpr(node.callee, scopes), args);
        }
        default: throw new RuntimeErr('Unknown expression: ' + node.k);
      }
    }

    evalBinary(node, scopes) {
      const op = node.op;
      const l = this.evalExpr(node.left, scopes);
      const r = this.evalExpr(node.right, scopes);
      const DUNDER_OP = {
        '+':'__add__', '-':'__sub__', '*':'__mul__', '/':'__truediv__', '//':'__floordiv__', '%':'__mod__', '**':'__pow__',
        '&':'__and__', '|':'__or__', '^':'__xor__', '<<':'__lshift__', '>>':'__rshift__',
        '==':'__eq__', '<':'__lt__', '<=':'__le__', '>':'__gt__', '>=':'__ge__'
      };
      const DUNDER_ROP = {
        '+':'__radd__', '-':'__rsub__', '*':'__rmul__', '/':'__rtruediv__', '//':'__rfloordiv__', '%':'__rmod__', '**':'__rpow__',
        '&':'__rand__', '|':'__ror__', '^':'__rxor__', '<<':'__rlshift__', '>>':'__rrshift__'
      };
      if (l instanceof PyInstance) {
        if (DUNDER_OP[op]) {
          const found = l.cls.findMethod(DUNDER_OP[op]);
          if (found) return this.callMethodEntry(found.method, found.owner, l, [r]);
        }
        if (op === '!=') {
          const eqFound = l.cls.findMethod('__eq__');
          if (eqFound) return !this.pyTruthy(this.callMethodEntry(eqFound.method, eqFound.owner, l, [r]));
        }
      }
      // Reflected operators: `primitive + instance` (or an instance whose
      // own dunder above was missing) falls back to the right operand's
      // __r*__ method, matching Python's operator dispatch order.
      if (r instanceof PyInstance && !(l instanceof PyInstance) && DUNDER_ROP[op]) {
        const rfound = r.cls.findMethod(DUNDER_ROP[op]);
        if (rfound) return this.callMethodEntry(rfound.method, rfound.owner, r, [l]);
      }
      if (l instanceof NDArray || r instanceof NDArray) return this.ndarrayBinary(op, l, r);
      if (l instanceof Series || r instanceof Series) {
        const lIsSeries = l instanceof Series, rIsSeries = r instanceof Series;
        const lArr = lIsSeries ? new NDArray(l.data) : l;
        const rArr = rIsSeries ? new NDArray(r.data) : r;
        const result = this.ndarrayBinary(op, lArr, rArr);
        const idx = lIsSeries ? l.index : r.index;
        return new Series(result.data, idx);
      }
      if (op === '&' || op === '|' || op === '^' || op === '<<' || op === '>>') {
        // Bitwise ops on plain numbers. Like the rest of this engine these
        // run on JS doubles, so operands are coerced through a 32-bit
        // signed integer (JS bitwise-op semantics) rather than Python's
        // arbitrary-precision ints — fine for typical values, but very
        // large integers won't match CPython bit-for-bit.
        const li = Math.trunc(toNum(l)), ri = Math.trunc(toNum(r));
        if (op === '&') return li & ri;
        if (op === '|') return li | ri;
        if (op === '^') return li ^ ri;
        if (op === '<<') return li << ri;
        return li >> ri;
      }
      if (op === '+') {
        if (typeof l === 'string' || typeof r === 'string') return toStr(l) + toStr(r);
        if (Array.isArray(l)) return l.concat(r);
        return toNum(l) + toNum(r);
      }
      if (op === '-') return toNum(l) - toNum(r);
      if (op === '*') {
        if (typeof l === 'string') return l.repeat(Math.max(0, Math.trunc(toNum(r))));
        if (typeof r === 'string') return r.repeat(Math.max(0, Math.trunc(toNum(l))));
        if (Array.isArray(l) || Array.isArray(r)) {
          const arr = Array.isArray(l) ? l : r;
          const n = Math.max(0, Math.trunc(toNum(Array.isArray(l) ? r : l)));
          let out = [];
          for (let i = 0; i < n; i++) out = out.concat(arr);
          return out;
        }
        return toNum(l) * toNum(r);
      }
      if (op === '/') { const rv = toNum(r); if (rv === 0) throw new RuntimeErr('Division by zero.'); return Number.isInteger(toNum(l)) && Number.isInteger(rv) ? Math.trunc(toNum(l)/rv) : toNum(l)/rv; }
      if (op === '%') { const rv = toNum(r); if (rv === 0) throw new RuntimeErr('Modulo by zero.'); return toNum(l) % rv; }
      if (op === '//') { const rv = toNum(r); if (rv === 0) throw new RuntimeErr('Division by zero.'); return Math.floor(toNum(l) / rv); }
      if (op === '**') return Math.pow(toNum(l), toNum(r));
      if (op === '==') return looseEq(l, r);
      if (op === '!=') return !looseEq(l, r);
      if (op === '<')  return typeof l==='string'||typeof r==='string' ? toStr(l) < toStr(r) : toNum(l) < toNum(r);
      if (op === '>')  return typeof l==='string'||typeof r==='string' ? toStr(l) > toStr(r) : toNum(l) > toNum(r);
      if (op === '<=') return typeof l==='string'||typeof r==='string' ? toStr(l) <= toStr(r) : toNum(l) <= toNum(r);
      if (op === '>=') return typeof l==='string'||typeof r==='string' ? toStr(l) >= toStr(r) : toNum(l) >= toNum(r);
      throw new RuntimeErr('Unknown operator ' + op);
    }

    // Elementwise arithmetic for the numpy-lite NDArray shim: array-array
    // (same length only - no real broadcasting of mismatched shapes) and
    // array-scalar in either order. Anything other than +,-,*,/,//,%,**
    // (bitwise ops, comparisons) is deliberately rejected rather than
    // silently doing something that looks plausible but isn't real
    // NumPy's actual (broadcasting, dtype-aware) behavior.
    ndarrayBinary(op, l, r) {
      const ARITH = {
        '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b,
        '/': (a, b) => a / b, '//': (a, b) => Math.floor(a / b), '%': (a, b) => a % b, '**': (a, b) => Math.pow(a, b)
      };
      const COMPARE = {
        '==': (a, b) => looseEq(a, b), '!=': (a, b) => !looseEq(a, b),
        '<': (a, b) => (typeof a === 'string' || typeof b === 'string') ? toStr(a) < toStr(b) : toNum(a) < toNum(b),
        '>': (a, b) => (typeof a === 'string' || typeof b === 'string') ? toStr(a) > toStr(b) : toNum(a) > toNum(b),
        '<=': (a, b) => (typeof a === 'string' || typeof b === 'string') ? toStr(a) <= toStr(b) : toNum(a) <= toNum(b),
        '>=': (a, b) => (typeof a === 'string' || typeof b === 'string') ? toStr(a) >= toStr(b) : toNum(a) >= toNum(b)
      };
      const isCompare = !!COMPARE[op];
      const fn = isCompare ? COMPARE[op] : ARITH[op];
      if (!fn) throw new RuntimeErr(`numpy-lite arrays only support elementwise +, -, *, /, //, %, **, ==, !=, <, >, <=, >= (not '${op}') - this is a small shim, not real NumPy.`);
      const ld = l instanceof NDArray ? l.data : null;
      const rd = r instanceof NDArray ? r.data : null;
      const num = isCompare ? (x => x) : toNum; // comparisons may legitimately compare strings; arithmetic always coerces to number
      if (ld && rd) {
        if (ld.length !== rd.length) throw new RuntimeErr(`operands could not be broadcast together with shapes (${ld.length},) (${rd.length},) - this shim only supports equal-length 1-D arrays or a scalar, not real NumPy broadcasting.`);
        return new NDArray(ld.map((x, i) => fn(num(x), num(rd[i]))));
      }
      if (ld) { const s = num(r); return new NDArray(ld.map(x => fn(num(x), s))); }
      const s = num(l); return new NDArray(rd.map(x => fn(s, num(x))));
    }

    // Implements the match-object methods returned by re.match()/re.search()
    // etc: group(), groups(), groupdict(), start(), end(), span().
    matchMethod(pm, name, args) {
      const raw = pm.raw;
      switch (name) {
        case 'group': {
          if (args.length === 0) return raw[0] === undefined ? null : raw[0];
          if (args.length === 1) {
            const key = args[0];
            if (typeof key === 'string') {
              const groups = raw.groups || {};
              return groups[key] === undefined ? null : groups[key];
            }
            const i = Math.trunc(toNum(key));
            const v = raw[i];
            return v === undefined ? null : v;
          }
          return args.map(key => {
            if (typeof key === 'string') { const g = raw.groups || {}; return g[key] === undefined ? null : g[key]; }
            const v = raw[Math.trunc(toNum(key))]; return v === undefined ? null : v;
          });
        }
        case 'groups': {
          const def = args.length ? args[0] : null;
          return raw.slice(1).map(v => v === undefined ? def : v);
        }
        case 'groupdict': {
          const def = args.length ? args[0] : null;
          const out = new Map();
          const groups = raw.groups || {};
          for (const k of Object.keys(groups)) out.set(k, groups[k] === undefined ? def : groups[k]);
          return out;
        }
        case 'start': case 'end': case 'span': {
          const key = args.length ? args[0] : 0;
          let i;
          if (typeof key === 'string') {
            if (!raw.indices || !raw.indices.groups || !(key in raw.indices.groups)) throw new RuntimeErr(`No such group: '${key}'`);
            const span = raw.indices.groups[key];
            if (!span) return name === 'span' ? [-1, -1] : -1;
            return name === 'span' ? span.slice() : (name === 'start' ? span[0] : span[1]);
          }
          i = Math.trunc(toNum(key));
          if (raw.indices && raw.indices[i]) {
            const span = raw.indices[i];
            return name === 'span' ? span.slice() : (name === 'start' ? span[0] : span[1]);
          }
          if (i === 0 && typeof raw.index === 'number') {
            const span = [raw.index, raw.index + (raw[0] ? raw[0].length : 0)];
            return name === 'span' ? span : (name === 'start' ? span[0] : span[1]);
          }
          return name === 'span' ? [-1, -1] : -1;
        }
        case 'string': return pm.input;
      }
      throw new RuntimeErr(`Unknown method ".${name}()" on match object.`);
    }

    callMethod(obj, name, args) {
      if (obj instanceof PyMatch) return this.matchMethod(obj, name, args);
      if (obj instanceof PyExecutor) {
        if (name === 'map') { const fn = args[0]; return toIterableArr(args[1], this).map(x => this.invoke(fn, [x])); }
        throw new RuntimeErr(`'ThreadPoolExecutor' object has no attribute '${name}' (this sandbox only implements .map(), run sequentially - see PyExecutor above)`);
      }
      if (obj instanceof PyStringIO) {
        switch (name) {
          case 'write': { const s = toStr(args[0]); obj.parts.push(s); return s.length; }
          case 'getvalue': return obj.parts.join('');
          case 'close': return null;
          default: throw new RuntimeErr(`'StringIO' object has no attribute '${name}' (this is a plain in-memory buffer - only .write()/.getvalue()/.close() are supported)`);
        }
      }
      if (obj instanceof NDArray) {
        switch (name) {
          case 'sum': return obj.data.reduce((a, b) => a + b, 0);
          case 'mean': if (obj.data.length === 0) throw new RuntimeErr('mean of empty array'); return obj.data.reduce((a, b) => a + b, 0) / obj.data.length;
          case 'min': if (obj.data.length === 0) throw new RuntimeErr('min of empty array'); return Math.min(...obj.data);
          case 'max': if (obj.data.length === 0) throw new RuntimeErr('max of empty array'); return Math.max(...obj.data);
          case 'std': {
            if (obj.data.length === 0) throw new RuntimeErr('std of empty array');
            const m = obj.data.reduce((a, b) => a + b, 0) / obj.data.length;
            return Math.sqrt(obj.data.reduce((a, x) => a + (x - m) * (x - m), 0) / obj.data.length);
          }
          case 'tolist': return obj.data.slice();
          case 'join': return obj.data.map(x => toStr(x)).join(toStr(args[0]));
          case 'astype': {
            const t = args[0];
            const typeName = t instanceof BuiltinRef ? t.name : toStr(t);
            if (typeName === 'str') return obj.data.map(x => toStr(x)); // plain array - see note above
            if (typeName === 'int') return new NDArray(obj.data.map(x => Math.trunc(toNum(x))));
            if (typeName === 'float') return new NDArray(obj.data.map(x => toNum(x)));
            throw new RuntimeErr(`astype('${typeName}') isn't supported by this numpy-lite shim (only str/int/float).`);
          }
          case 'reshape': throw new RuntimeErr('reshape()/multi-dimensional arrays are not supported - this numpy-lite shim is 1-D only.');
          default: throw new RuntimeErr(`'numpy.ndarray' object has no attribute '${name}' (this is a small 1-D arithmetic-only shim, not real NumPy)`);
        }
      }
      if (obj instanceof Series) {
        switch (name) {
          case 'sum': return obj.data.reduce((a, b) => a + b, 0);
          case 'mean': if (obj.data.length === 0) throw new RuntimeErr('mean of empty series'); return obj.data.reduce((a, b) => a + b, 0) / obj.data.length;
          case 'min': if (obj.data.length === 0) throw new RuntimeErr('min of empty series'); return obj.data.reduce((a, b) => b < a ? b : a);
          case 'max': if (obj.data.length === 0) throw new RuntimeErr('max of empty series'); return obj.data.reduce((a, b) => b > a ? b : a);
          case 'std': {
            if (obj.data.length === 0) throw new RuntimeErr('std of empty series');
            const m = obj.data.reduce((a, b) => a + b, 0) / obj.data.length;
            return Math.sqrt(obj.data.reduce((a, x) => a + (x - m) * (x - m), 0) / obj.data.length);
          }
          case 'tolist': return obj.data.slice();
          case 'map': case 'apply': { const fn = args[0]; return new Series(obj.data.map(x => this.invoke(fn, [x])), obj.index.slice()); }
          case 'join': return obj.data.map(x => toStr(x)).join(toStr(args[0]));
          default: throw new RuntimeErr(`'Series' object has no attribute '${name}' (this is a small Series-only shim, not real pandas - no DataFrame, groupby, or index alignment)`);
        }
      }
      if (obj instanceof PyRegex) {
        const fwd = { match: 're_match', search: 're_search', fullmatch: 're_fullmatch', findall: 're_findall', finditer: 're_finditer', sub: 're_sub', subn: 're_subn', split: 're_split' };
        if (fwd[name]) {
          // Compiled-pattern methods take the subject string first, then
          // the pattern's own flags; sub()/subn()/split() also thread
          // their extra positional args (repl/count etc.) through in the
          // same order the top-level re.sub()/re.split() expect.
          if (name === 'sub' || name === 'subn') return this.callBuiltin(fwd[name], [obj.pattern, args[0], args[1], args[2], obj.flags]);
          if (name === 'split') return this.callBuiltin(fwd[name], [obj.pattern, args[0], args[1], obj.flags]);
          return this.callBuiltin(fwd[name], [obj.pattern, args[0], obj.flags]);
        }
        throw new RuntimeErr(`Unknown method ".${name}()" on compiled pattern.`);
      }
      // Dunder ("magic") methods invoked directly by name, e.g. a.__add__(b),
      // on JS-native values standing in for Python's built-in types. Operator
      // syntax (a + b) already dispatches through evalBinary()/Unary above;
      // this covers explicit dunder calls, which Python allows on every
      // built-in type too, not just user-defined classes.
      if (name.length > 4 && name.startsWith('__') && name.endsWith('__')) {
        const handled = this.builtinDunder(obj, name, args);
        if (handled.ok) return handled.value;
      }
      // Static/"classmethod"-style calls directly on a builtin type name,
      // e.g. dict.fromkeys(...) - `dict` on its own resolves to a
      // BuiltinRef (see the Ident case above), not a dict instance, so it
      // needs its own dispatch here rather than falling into the
      // instance-method switches below.
      if (obj instanceof BuiltinRef) {
        if (obj.name === 'dict' && name === 'fromkeys') {
          const value = args[1] !== undefined ? args[1] : null;
          const m = new Map();
          for (const k of toIterableArr(args[0], this)) m.set(k, value);
          return m;
        }
        if (obj.name === 'str' && name === 'maketrans') {
          // Represented as a plain Map (char -> replacement string, or
          // null to delete) - the same representation dicts already use,
          // so it needs no new type and .translate() below can consume
          // it directly.
          const table = new Map();
          if (args.length === 1) {
            const d = args[0];
            if (!(d instanceof Map)) throw new RuntimeErr('str.maketrans() with a single argument requires a dict mapping ordinals or characters to their replacement.');
            for (const [k, v] of d) {
              const key = typeof k === 'number' ? String.fromCharCode(k) : toStr(k);
              table.set(key, v === null ? null : (typeof v === 'number' ? String.fromCharCode(v) : toStr(v)));
            }
          } else {
            const x = toStr(args[0]), y = toStr(args[1]);
            if (x.length !== y.length) throw new RuntimeErr('str.maketrans() first two arguments must have equal length.');
            for (let i = 0; i < x.length; i++) table.set(x[i], y[i]);
            if (args[2] !== undefined) for (const ch of toStr(args[2])) table.set(ch, null);
          }
          return table;
        }
        if (obj.name === 'str') return this.callMethod(args[0], name, args.slice(1));
        throw new RuntimeErr(`type object '${obj.name}' has no attribute '${name}'`);
      }
      // string methods
      if (typeof obj === 'string') {
        switch (name) {
          case 'length': return obj.length;
          case 'upper': case 'toUpperCase': return obj.toUpperCase();
          case 'lower': case 'toLowerCase': return obj.toLowerCase();
          // Python's is*() predicates are all "non-empty AND every
          // character satisfies X" - isdecimal/isnumeric/isdigit are true
          // synonyms here (real Python distinguishes them only for
          // Unicode numeral forms outside plain ASCII 0-9, which is out
          // of scope for this sandbox).
          case 'isdigit': case 'isdecimal': case 'isnumeric': return obj.length > 0 && /^[0-9]+$/.test(obj);
          case 'isalpha': return obj.length > 0 && /^[A-Za-z]+$/.test(obj);
          case 'isalnum': return obj.length > 0 && /^[A-Za-z0-9]+$/.test(obj);
          case 'isspace': return obj.length > 0 && /^\s+$/.test(obj);
          case 'isupper': return /[A-Za-z]/.test(obj) && obj === obj.toUpperCase();
          case 'islower': return /[A-Za-z]/.test(obj) && obj === obj.toLowerCase();
          case 'isascii': return /^[\x00-\x7F]*$/.test(obj);
          case 'trim': case 'strip': return obj.trim();
          case 'split': return obj.split(args[0] !== undefined ? toStr(args[0]) : /\s+/);
          case 'startswith': return obj.startsWith(toStr(args[0]));
          case 'endswith': return obj.endsWith(toStr(args[0]));
          case 'includes': case 'contains': return obj.includes(toStr(args[0]));
          case 'indexOf': case 'find': return obj.indexOf(toStr(args[0]));
          case 'rfind': return obj.lastIndexOf(toStr(args[0]));
          case 'replace': return obj.split(toStr(args[0])).join(toStr(args[1]));
          case 'substring': case 'substr': case 'slice': return obj.slice(Math.trunc(toNum(args[0])), args[1]!==undefined?Math.trunc(toNum(args[1])):undefined);
          case 'charAt': return obj[Math.trunc(toNum(args[0]))] || '';
          case 'repeat': return obj.repeat(Math.max(0,Math.trunc(toNum(args[0]))));
          case 'toString': return obj;
          case 'toInt': case 'parseInt': return Math.trunc(toNum(obj));
          case 'toFloat': case 'parseFloat': return toNum(obj);
          case 'reversed': case 'reverse': return obj.split('').reverse().join('');
          case 'encode': return Array.from(new TextEncoder().encode(obj));
          case 'translate': {
            const table = args[0];
            if (!(table instanceof Map)) throw new RuntimeErr('translate() argument must be a translation table from str.maketrans()');
            let out = '';
            for (const ch of obj) {
              if (table.has(ch)) { const r = table.get(ch); if (r !== null) out += r; }
              else out += ch;
            }
            return out;
          }
          case 'partition': {
            const sep = toStr(args[0]);
            if (sep === '') throw new RuntimeErr('empty separator');
            const idx = obj.indexOf(sep);
            if (idx === -1) return [obj, '', ''];
            return [obj.slice(0, idx), sep, obj.slice(idx + sep.length)];
          }
          case 'rpartition': {
            const sep = toStr(args[0]);
            if (sep === '') throw new RuntimeErr('empty separator');
            const idx = obj.lastIndexOf(sep);
            if (idx === -1) return ['', '', obj];
            return [obj.slice(0, idx), sep, obj.slice(idx + sep.length)];
          }
          case 'format': return runtimeFormat(obj, args);
        }
      }
      // array methods
      if (Array.isArray(obj)) {
        switch (name) {
          case 'length': case 'size': return obj.length;
          case 'push': case 'append': case 'add': case 'push_back': obj.push(args[0]); return obj.length;
          case 'extend': for (const x of toIterableArr(args[0], this)) obj.push(x); return null;
          // Set operations - sets are plain deduplicated arrays here (see
          // pyset() in the prelude), so these are just array methods.
          // looseEq matches the equality pyset() itself already uses.
          case 'issubset': { const other = toIterableArr(args[0], this); return obj.every(x => other.some(y => looseEq(x, y))); }
          case 'issuperset': { const other = toIterableArr(args[0], this); return other.every(x => obj.some(y => looseEq(x, y))); }
          case 'union': {
            const other = toIterableArr(args[0], this);
            const out = obj.slice();
            for (const x of other) if (!out.some(y => looseEq(x, y))) out.push(x);
            return out;
          }
          case 'intersection': { const other = toIterableArr(args[0], this); return obj.filter(x => other.some(y => looseEq(x, y))); }
          case 'difference': { const other = toIterableArr(args[0], this); return obj.filter(x => !other.some(y => looseEq(x, y))); }
          case 'symmetric_difference': {
            const other = toIterableArr(args[0], this);
            const out = obj.filter(x => !other.some(y => looseEq(x, y)));
            for (const x of other) if (!obj.some(y => looseEq(x, y))) out.push(x);
            return out;
          }
          case 'decode': return new TextDecoder().decode(Uint8Array.from(obj.map(x => Math.trunc(toNum(x)) & 0xFF)));
          case 'pop': {
            if (obj.length === 0) throw new RuntimeErr('pop from empty list');
            if (args[0] === undefined) return obj.pop();
            let idx = Math.trunc(toNum(args[0]));
            if (idx < 0) idx += obj.length;
            if (idx < 0 || idx >= obj.length) throw new RuntimeErr('pop index out of range');
            return obj.splice(idx, 1)[0];
          }
          case 'popleft': if (obj.length === 0) throw new RuntimeErr('pop from an empty deque'); return obj.shift();
          case 'appendleft': obj.unshift(args[0]); return null;
          case 'shift': return obj.shift();
          case 'unshift': obj.unshift(args[0]); return obj.length;
          case 'sort': obj.sort((a,b)=> typeof a==='string' ? (a<b?-1:a>b?1:0) : toNum(a)-toNum(b)); return obj;
          case 'reverse': case 'reversed': obj.reverse(); return obj;
          case 'includes': case 'contains': return obj.some(x=>looseEq(x,args[0]));
          case 'indexOf': case 'find': return obj.findIndex(x=>looseEq(x,args[0]));
          case 'join': return obj.map(toStr).join(args[0]!==undefined?toStr(args[0]):',');
          case 'slice': return obj.slice(Math.trunc(toNum(args[0])), args[1]!==undefined?Math.trunc(toNum(args[1])):undefined);
          case 'toString': return toStr(obj);
        }
      }
      // dict methods
      if (obj instanceof Map) {
        switch (name) {
          case 'get': return obj.has(args[0]) ? obj.get(args[0]) : (args[1] !== undefined ? args[1] : null);
          case 'keys': return Array.from(obj.keys());
          case 'values': return Array.from(obj.values());
          case 'items': return Array.from(obj.entries()).map(([k, v]) => [k, v]);
          case 'pop': {
            const has = obj.has(args[0]);
            const v = has ? obj.get(args[0]) : (args[1] !== undefined ? args[1] : null);
            if (has) obj.delete(args[0]);
            else if (args[1] === undefined) throw new RuntimeErr(`Key ${toStr(args[0])} not found.`);
            return v;
          }
          case 'update': {
            const other = args[0];
            if (other instanceof Map) for (const [k, v] of other) obj.set(k, v);
            return null;
          }
          case 'setdefault': {
            if (!obj.has(args[0])) obj.set(args[0], args[1] !== undefined ? args[1] : null);
            return obj.get(args[0]);
          }
          case 'copy': return new Map(obj);
        }
      }
      { const typeName = Array.isArray(obj) ? 'list' : (obj instanceof Map ? 'dict' : typeof obj === 'string' ? 'str' : typeof obj === 'boolean' ? 'bool' : typeof obj === 'number' ? (Number.isInteger(obj) ? 'int' : 'float') : typeof obj);
        throw new RuntimeErr(`'${typeName}' object has no attribute '${name}'`); }
    }

    // Implements Python dunder methods directly (a.__add__(b) etc.) for
    // built-in types. Returns { ok:false } for anything not covered here so
    // callMethod() can fall through to its normal per-type method table or
    // its "unknown method" error. `a` is always the receiver; `b` is the
    // first argument, when the dunder needs one.
    builtinDunder(a, name, args) {
      const b = args[0];
      const strOrCmp = (fn) => (typeof a === 'string' || typeof b === 'string') ? fn(toStr(a), toStr(b)) : fn(toNum(a), toNum(b));
      switch (name) {
        case '__add__': {
          if (typeof a === 'string' || typeof b === 'string') return { ok:true, value: toStr(a) + toStr(b) };
          if (Array.isArray(a)) return { ok:true, value: a.concat(b) };
          return { ok:true, value: toNum(a) + toNum(b) };
        }
        case '__sub__': return { ok:true, value: toNum(a) - toNum(b) };
        case '__mul__': {
          if (typeof a === 'string') return { ok:true, value: a.repeat(Math.max(0, Math.trunc(toNum(b)))) };
          if (Array.isArray(a)) { const n = Math.max(0, Math.trunc(toNum(b))); let out = []; for (let i = 0; i < n; i++) out = out.concat(a); return { ok:true, value: out }; }
          return { ok:true, value: toNum(a) * toNum(b) };
        }
        case '__truediv__': { const rv = toNum(b); if (rv === 0) throw new RuntimeErr('division by zero'); return { ok:true, value: toNum(a) / rv }; }
        case '__floordiv__': { const rv = toNum(b); if (rv === 0) throw new RuntimeErr('division by zero'); return { ok:true, value: Math.floor(toNum(a) / rv) }; }
        case '__mod__': {
          // Python's `%` is floor-based (result carries the sign of the
          // divisor), unlike JS's truncating `%` — matches pymod() in the
          // Python adapter's prelude.
          const av = toNum(a), bv = toNum(b);
          if (bv === 0) throw new RuntimeErr('modulo by zero');
          return { ok:true, value: ((av % bv) + bv) % bv };
        }
        case '__pow__': return { ok:true, value: Math.pow(toNum(a), toNum(b)) };
        // Reflected ("right-hand") dunders: `a.__radd__(b)` means "what is
        // b + a from a's perspective", i.e. exactly the forward dunder
        // with operands swapped. Delegating like this automatically
        // inherits the forward version's type-specific behavior (string
        // concat, list repeat, etc.) instead of duplicating it.
        case '__radd__': return this.builtinDunder(b, '__add__', [a]);
        case '__rsub__': return this.builtinDunder(b, '__sub__', [a]);
        case '__rmul__': return this.builtinDunder(b, '__mul__', [a]);
        case '__rtruediv__': return this.builtinDunder(b, '__truediv__', [a]);
        case '__rfloordiv__': return this.builtinDunder(b, '__floordiv__', [a]);
        case '__rmod__': return this.builtinDunder(b, '__mod__', [a]);
        case '__rpow__': return this.builtinDunder(b, '__pow__', [a]);
        case '__rand__': return this.builtinDunder(b, '__and__', [a]);
        case '__ror__': return this.builtinDunder(b, '__or__', [a]);
        case '__rxor__': return this.builtinDunder(b, '__xor__', [a]);
        case '__rlshift__': return this.builtinDunder(b, '__lshift__', [a]);
        case '__rrshift__': return this.builtinDunder(b, '__rshift__', [a]);
        case '__and__': return { ok:true, value: Math.trunc(toNum(a)) & Math.trunc(toNum(b)) };
        case '__or__': return { ok:true, value: Math.trunc(toNum(a)) | Math.trunc(toNum(b)) };
        case '__xor__': return { ok:true, value: Math.trunc(toNum(a)) ^ Math.trunc(toNum(b)) };
        case '__lshift__': return { ok:true, value: Math.trunc(toNum(a)) << Math.trunc(toNum(b)) };
        case '__rshift__': return { ok:true, value: Math.trunc(toNum(a)) >> Math.trunc(toNum(b)) };
        case '__eq__': return { ok:true, value: looseEq(a, b) };
        case '__ne__': return { ok:true, value: !looseEq(a, b) };
        case '__lt__': return { ok:true, value: strOrCmp((x, y) => x < y) };
        case '__le__': return { ok:true, value: strOrCmp((x, y) => x <= y) };
        case '__gt__': return { ok:true, value: strOrCmp((x, y) => x > y) };
        case '__ge__': return { ok:true, value: strOrCmp((x, y) => x >= y) };
        case '__neg__': return { ok:true, value: -toNum(a) };
        case '__pos__': return { ok:true, value: toNum(a) };
        case '__invert__': return { ok:true, value: ~Math.trunc(toNum(a)) };
        case '__abs__': return { ok:true, value: Math.abs(toNum(a)) };
        case '__len__': return { ok:true, value: Array.isArray(a) || typeof a === 'string' ? a.length : (a instanceof Map ? a.size : 0) };
        case '__str__': return { ok:true, value: pystrValue(a, this) };
        case '__repr__': return { ok:true, value: pyReprInner(a, this) };
        case '__bool__': return { ok:true, value: this.pyTruthy(a) };
        case '__contains__': {
          if (typeof a === 'string') return { ok:true, value: a.includes(toStr(b)) };
          if (Array.isArray(a)) return { ok:true, value: a.some(x => looseEq(x, b)) };
          if (a instanceof Map) return { ok:true, value: a.has(b) };
          return { ok:true, value: false };
        }
        case '__getitem__': {
          if (a instanceof Map) { if (!a.has(b)) throw new RuntimeErr(`Key ${toStr(b)} not found.`); return { ok:true, value: a.get(b) }; }
          if (Array.isArray(a) || typeof a === 'string') {
            const idx = Math.trunc(toNum(b)); const i = idx < 0 ? a.length + idx : idx;
            const v = a[i]; return { ok:true, value: v === undefined ? (typeof a === 'string' ? '' : null) : v };
          }
          return { ok:false };
        }
        case '__setitem__': {
          const val = args[1];
          if (a instanceof Map) { a.set(b, val); return { ok:true, value: null }; }
          if (Array.isArray(a)) {
            const idx = Math.trunc(toNum(b)); const i = idx < 0 ? a.length + idx : idx;
            a[i] = val; return { ok:true, value: null };
          }
          return { ok:false };
        }
        case '__delitem__': {
          if (a instanceof Map) { a.delete(b); return { ok:true, value: null }; }
          if (Array.isArray(a)) {
            const idx = Math.trunc(toNum(b)); const i = idx < 0 ? a.length + idx : idx;
            a.splice(i, 1); return { ok:true, value: null };
          }
          return { ok:false };
        }
        case '__len__': {
          if (a instanceof Map) return { ok:true, value: a.size };
          if (Array.isArray(a) || typeof a === 'string') return { ok:true, value: a.length };
          return { ok:false };
        }
      }
      return { ok:false };
    }

    callBuiltin(name, args) {
      switch (name) {
        case 'print': this.writeln(args.map(toStr).join(' ')); return null;
        case 'printraw': this.write(args.map(toStr).join(' ')); return null;
        case 'printf': this.write(formatPrintf(toStr(args[0]), args.slice(1))); return null;
        case 'sprintf': return formatPrintf(toStr(args[0]), args.slice(1));
        case 'format_rs': return formatBraces(toStr(args[0]), args.slice(1));
        case 'println_rs': this.writeln(formatBraces(toStr(args[0]), args.slice(1))); return null;
        case 'read_line': return this.readLine();
        case 'read_token': return this.readToken();
        case 'read_token_auto': { const tok = this.readToken(); return /^-?\d+(\.\d+)?$/.test(tok) ? parseFloat(tok) : tok; }
        case 'read_int': return this.readInt();
        case 'read_float': return this.readFloat();
        case 'len': { const v = args[0]; if (v instanceof PyInstance) { const f = v.cls.findMethod('__len__'); if (f) return this.callMethodEntry(f.method, f.owner, v, []); throw new RuntimeErr(`object of type '${v.cls.name}' has no len()`); } if (v instanceof Map) return v.size; if (v instanceof NDArray) return v.data.length; if (v instanceof Series) return v.data.length; return (Array.isArray(v)||typeof v==='string') ? v.length : 0; }
        case 'str': return toStr(args[0]);
        case 'int': case 'parseInt': return Math.trunc(toNum(args[0]));
        case 'float': case 'parseFloat': case 'Number': return toNum(args[0]);
        case 'abs': return Math.abs(toNum(args[0]));
        case 'min': return Math.min(...args.map(toNum));
        case 'max': return Math.max(...args.map(toNum));
        case 'pow': return Math.pow(toNum(args[0]), toNum(args[1]));
        case 'sqrt': return Math.sqrt(toNum(args[0]));
        case 'floor': return Math.floor(toNum(args[0]));
        case 'ceil': return Math.ceil(toNum(args[0]));
        case 'round': return Math.round(toNum(args[0]));
        case 'array': { const size = Math.trunc(toNum(args[0])); const fill = args[1]!==undefined?args[1]:0; return new Array(size).fill(fill); }
        case 'push': args[0].push(args[1]); return args[0];
        case 'pop': return args[0].pop();
        case 'range': {
          const a = args.length>1?toNum(args[0]):0;
          const b = args.length>1?toNum(args[1]):toNum(args[0]);
          const step = args[2]!==undefined?toNum(args[2]):1;
          return new RangeObj(a,b,step);
        }
        case 'upper': return toStr(args[0]).toUpperCase();
        case 'lower': return toStr(args[0]).toLowerCase();
        case 'trim': return toStr(args[0]).trim();
        case 'split': return toStr(args[0]).split(args[1]!==undefined?toStr(args[1]):/\s+/);
        case 'join': return (args[0]||[]).map(toStr).join(args[1]!==undefined?toStr(args[1]):'');
        case 'substr': case 'slice': return toStr(args[0]).slice(Math.trunc(toNum(args[1])), args[2]!==undefined?Math.trunc(toNum(args[2])):undefined);
        // ── Python-only additions (namespaced so other language adapters
        //    never call them; each covers something the canonical grammar
        //    genuinely can't express on its own) ──
        case 'truediv': { // Python's `/` is always float division, unlike
          // the shared `/` operator above which intentionally truncates
          // for two integer operands (that's correct for C/Java/Go/etc,
          // just not for Python).
          if (args[0] instanceof NDArray || args[1] instanceof NDArray) return this.ndarrayBinary('/', args[0], args[1]);
          const rv = toNum(args[1]); if (rv === 0) throw new RuntimeErr('Division by zero.'); return toNum(args[0]) / rv;
        }
        case 'pystr': return pystrValue(args[0], this);
        case 'pyprint': { this.writeln(args.map(v => pystrValue(v, this)).join(' ')); return null; }
        case 'iter': {
          const v = args[0];
          if (v instanceof PyIterator) return v;
          return new PyIterator(toIterableArr(v, this));
        }
        case 'next': {
          const it = args[0];
          if (!(it instanceof PyIterator)) throw new RuntimeErr(`'${typeof it}' object is not an iterator`);
          if (it.i < it.items.length) return it.items[it.i++];
          if (args.length > 1) return args[1];
          throw new RuntimeErr('StopIteration');
        }
        // Native (not prelude) so it can share real object identity: the
        // classic `zip(it, it)` idiom (consume two values at a time from
        // one shared iterator, e.g. to pair up a sequence) needs each
        // slot's `next()` to advance the *same* underlying position when
        // both arguments are literally the same PyIterator object. A
        // prelude implementation only ever sees plain values, with no
        // notion of object identity or shared mutable position to hook
        // into. Also generalizes to any number of iterables, not just 2.
        case 'pyzip': {
          const cursors = args.map(a => a instanceof PyIterator ? a : { items: toIterableArr(a, this), i: 0 });
          const out = [];
          outer:
          while (true) {
            const row = [];
            for (const c of cursors) {
              if (c.i >= c.items.length) break outer;
              row.push(c.items[c.i]);
              c.i++;
            }
            out.push(row);
          }
          return out;
        }
        case 're_match': case 're_fullmatch': {
          const [pattern, str, flags] = args;
          const re = buildJsRegex(pattern, flags, 'd');
          const m = re.exec(toStr(str));
          if (!m || m.index !== 0) return null;
          if (name === 're_fullmatch' && m[0].length !== toStr(str).length) return null;
          return new PyMatch(m, toStr(str));
        }
        case 're_search': {
          const [pattern, str, flags] = args;
          const re = buildJsRegex(pattern, flags, 'd');
          const m = re.exec(toStr(str));
          return m ? new PyMatch(m, toStr(str)) : null;
        }
        case 're_findall': {
          const [pattern, str, flags] = args;
          const re = buildJsRegex(pattern, flags, 'gd');
          const s = toStr(str);
          const out = [];
          let m;
          while ((m = re.exec(s)) !== null) {
            if (m[0] === '' && m.index === re.lastIndex) re.lastIndex++; // avoid infinite loop on empty matches
            out.push(m.length > 1 ? (m.length === 2 ? (m[1] === undefined ? '' : m[1]) : m.slice(1).map(g => g === undefined ? '' : g)) : m[0]);
          }
          return out;
        }
        case 're_finditer': {
          const [pattern, str, flags] = args;
          const re = buildJsRegex(pattern, flags, 'gd');
          const s = toStr(str);
          const out = [];
          let m;
          while ((m = re.exec(s)) !== null) {
            out.push(new PyMatch(m, s));
            if (m[0] === '' ) re.lastIndex++;
          }
          return new PyIterator(out);
        }
        case 're_sub': case 're_subn': {
          const [pattern, repl, str, countArg, flags] = args;
          const re = buildJsRegex(pattern, flags, 'gd');
          const s = toStr(str);
          const maxCount = (countArg === undefined || countArg === null || countArg === 0) ? Infinity : Math.trunc(toNum(countArg));
          let n = 0;
          const isFn = (repl instanceof Closure || repl instanceof BuiltinRef || typeof repl === 'function');
          const out = s.replace(re, (...a) => {
            if (n >= maxCount) return a[0];
            n++;
            const m = a.slice(0, -2); // [full, ...groups] (drop offset, string; named-group object handled separately if present)
            let groupsObj = null;
            if (typeof a[a.length - 1] === 'object' && a[a.length - 1] !== null) groupsObj = a.pop();
            const full = m[0];
            if (isFn) {
              const pm = new PyMatch(Object.assign([full, ...m.slice(1)], { index: a[a.length - 2], input: s, groups: groupsObj }), s);
              return toStr(this.invoke(repl, [pm]));
            }
            // string replacement template: \1, \2, ... and \g<name>
            return toStr(repl).replace(/\\g<([A-Za-z_]\w*)>/g, (_, nm) => (groupsObj && groupsObj[nm] !== undefined) ? groupsObj[nm] : '')
              .replace(/\\(\d{1,2})/g, (_, d) => { const gi = parseInt(d, 10); return m[gi] !== undefined ? m[gi] : ''; });
          });
          return name === 're_subn' ? [out, n] : out;
        }
        case 're_split': {
          const [pattern, str, maxsplitArg, flags] = args;
          const re = buildJsRegex(pattern, flags, 'g');
          const s = toStr(str);
          const maxsplit = (maxsplitArg === undefined || maxsplitArg === null || maxsplitArg === 0) ? Infinity : Math.trunc(toNum(maxsplitArg));
          const out = [];
          let last = 0, n = 0, m;
          while (n < maxsplit && (m = re.exec(s)) !== null) {
            if (m[0] === '' && m.index === re.lastIndex) { re.lastIndex++; if (re.lastIndex > s.length) break; continue; }
            out.push(s.slice(last, m.index));
            for (let gi = 1; gi < m.length; gi++) out.push(m[gi] === undefined ? null : m[gi]);
            last = m.index + m[0].length;
            n++;
          }
          out.push(s.slice(last));
          return out;
        }
        case 're_compile': return new PyRegex(args[0], args[1]);
        case 're_escape': return toStr(args[0]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        case 'pyprintraw': { this.write(args.map(v => pystrValue(v, this)).join(' ')); return null; }
        case 'pyprintx': {
          // Backs print(..., sep=..., end=...). args[0]/args[1] are the
          // resolved sep/end values (already defaulted to ' ' / '\n' by the
          // Python adapter if the user didn't specify them); the rest are
          // the values being printed.
          const sep = toStr(args[0]);
          const end = toStr(args[1]);
          this.write(args.slice(2).map(v => pystrValue(v, this)).join(sep) + end);
          return null;
        }
        case 'pyreversed': { // Python's reversed() must return the same
          // shape it was given (string in -> string out, list in -> list
          // out); again needs real typeof.
          const v = args[0];
          if (typeof v === 'string') return v.split('').reverse().join('');
          if (Array.isArray(v)) return v.slice().reverse();
          return v;
        }
        case 'pyslicestep': { // full Python slice semantics (seq[start:stop:step])
          const seqRaw = args[0];
          const isStr = typeof seqRaw === 'string';
          const isND = seqRaw instanceof NDArray;
          const seq = isStr ? seqRaw.split('') : (isND ? seqRaw.data : seqRaw);
          const n = seq.length;
          let step = (args[3] !== undefined && args[3] !== null) ? Math.trunc(toNum(args[3])) : 1;
          if (step === 0) throw new RuntimeErr('slice step cannot be zero');
          let start = (args[1] !== undefined && args[1] !== null) ? Math.trunc(toNum(args[1])) : (step > 0 ? 0 : n - 1);
          let stop = (args[2] !== undefined && args[2] !== null) ? Math.trunc(toNum(args[2])) : (step > 0 ? n : -n - 1);
          start = start < 0 ? Math.max(n + start, step > 0 ? 0 : -1) : (step > 0 ? Math.min(start, n) : Math.min(start, n - 1));
          stop = stop < 0 ? Math.max(n + stop, step > 0 ? 0 : -1) : (step > 0 ? Math.min(stop, n) : Math.min(stop, n - 1));
          const out = [];
          if (step > 0) { for (let i = start; i < stop; i += step) out.push(seq[i]); }
          else { for (let i = start; i > stop; i += step) out.push(seq[i]); }
          return isStr ? out.join('') : (isND ? new NDArray(out) : out);
        }
        case 'pyin': { // Python's `in` membership test - dispatches on
          // type (string substring / array element / dict key), which
          // again needs real typeof.
          const seq = args[1];
          if (seq instanceof PyInstance) { const f = seq.cls.findMethod('__contains__'); if (f) return truthy(this.callMethodEntry(f.method, f.owner, seq, [args[0]])); return false; }
          if (typeof seq === 'string') return seq.includes(toStr(args[0]));
          if (Array.isArray(seq)) return seq.some(v => looseEq(v, args[0]));
          if (seq instanceof Map) return seq.has(args[0]);
          return false;
        }
        case 'pydel': { // Python's `del container[key]` - dict delete or
          // array splice depending on real type.
          const container = args[0], key = args[1];
          if (container instanceof Map) { container.delete(key); return null; }
          if (Array.isArray(container)) {
            const i = Math.trunc(toNum(key));
            const idx = i < 0 ? container.length + i : i;
            if (idx >= 0 && idx < container.length) container.splice(idx, 1);
          }
          return null;
        }
        case 'dict': { // dict() / dict(other_dict) / dict([[k,v],...])
          const src = args[0];
          if (src instanceof Map) return new Map(src);
          if (Array.isArray(src)) return new Map(src.map(pair => [pair[0], pair[1]]));
          return new Map();
        }
        // bytes/bytearray - modeled as a plain array of ints 0-255 rather
        // than a distinct type, so every existing array operation (extend,
        // indexing, +, len, slicing, ==) already works on them for free.
        // This sandbox doesn't distinguish immutable bytes from mutable
        // bytearray (or model text-encoding errors) - a deliberate scope
        // trade-off, not an oversight.
        case 'bytearray': case 'bytes': {
          const src = args[0];
          if (src === undefined) return [];
          if (typeof src === 'number') return new Array(Math.max(0, Math.trunc(src))).fill(0);
          if (typeof src === 'string') return Array.from(new TextEncoder().encode(src));
          return toIterableArr(src, this).map(x => Math.trunc(toNum(x)) & 0xFF);
        }
        // Runtime target for compiled `b'...'` literals (see
        // stripStringPrefixes in python-compiler.js) - UTF-8 encodes the
        // literal's text into a byte array, same as calling .encode() on
        // an equivalent plain string.
        case 'pybytes': return Array.from(new TextEncoder().encode(toStr(args[0])));
        case 'pycallmethod': return this.callMethod(args[0], toStr(args[1]), toIterableArr(args[2], this));
        case 'ThreadPoolExecutor': return new PyExecutor();
        case 'partial': return new PartialRef(args[0], args.slice(1));
        case 'repr': return pyReprInner(args[0], this);
        case 'StringIO': return new PyStringIO(args[0] !== undefined ? toStr(args[0]) : '');
        case 'urlparse': return pyUrlParse(toStr(args[0]));
        // ── functional (need real closures, see Closure/callClosure above) ──
        case 'map': {
          const fn = args[0];
          const iters = args.slice(1).map(a => toIterableArr(a, this));
          const len = Math.min(...iters.map(it => it.length));
          const out = [];
          for (let i = 0; i < len; i++) out.push(this.invoke(fn, iters.map(it => it[i])));
          return out;
        }
        case 'filter': { const fn = args[0]; return toIterableArr(args[1], this).filter(x => this.pyTruthy(fn ? this.invoke(fn, [x]) : x)); }
        case 'reduce': {
          const fn = args[0], it = toIterableArr(args[1], this);
          if (it.length === 0 && args[2] === undefined) throw new RuntimeErr('reduce() of empty sequence with no initial value');
          let acc = args[2] !== undefined ? args[2] : it[0];
          for (let i = (args[2] !== undefined ? 0 : 1); i < it.length; i++) acc = this.invoke(fn, [acc, it[i]]);
          return acc;
        }
        // ── itertools (curated, eager subset - see note above callBuiltin
        // about this engine only ever working with fully-materialized
        // sequences, never lazy/infinite ones; itertools.count() is left
        // out entirely for exactly that reason, since it has no finite
        // result to materialize - range(start, stop, step) is the direct
        // substitute) ──
        case 'accumulate': {
          const it = toIterableArr(args[0], this), fn = args[1];
          const addDefault = (a, b) => (typeof a === 'string' || typeof b === 'string') ? toStr(a) + toStr(b) : (Array.isArray(a) ? a.concat(b) : toNum(a) + toNum(b));
          const out = [];
          let acc;
          for (let i = 0; i < it.length; i++) {
            acc = i === 0 ? it[0] : (fn ? this.invoke(fn, [acc, it[i]]) : addDefault(acc, it[i]));
            out.push(acc);
          }
          return out;
        }
        case 'chain': { const out = []; for (const it of args) for (const x of toIterableArr(it, this)) out.push(x); return out; }
        case 'product': {
          const lists = args.map(a => toIterableArr(a, this));
          let result = [[]];
          for (const lst of lists) {
            const next = [];
            for (const prefix of result) for (const x of lst) next.push([...prefix, x]);
            result = next;
          }
          return result;
        }
        case 'permutations': {
          const arr = toIterableArr(args[0], this);
          const r = args[1] !== undefined && args[1] !== null ? Math.trunc(toNum(args[1])) : arr.length;
          const out = [], used = new Array(arr.length).fill(false), cur = [];
          const backtrack = () => {
            if (cur.length === r) { out.push(cur.slice()); return; }
            for (let i = 0; i < arr.length; i++) {
              if (used[i]) continue;
              used[i] = true; cur.push(arr[i]);
              backtrack();
              cur.pop(); used[i] = false;
            }
          };
          backtrack();
          return out;
        }
        case 'combinations': {
          const arr = toIterableArr(args[0], this);
          const r = Math.trunc(toNum(args[1]));
          const out = [];
          const backtrack = (start, cur) => {
            if (cur.length === r) { out.push(cur.slice()); return; }
            for (let i = start; i < arr.length; i++) { cur.push(arr[i]); backtrack(i + 1, cur); cur.pop(); }
          };
          backtrack(0, []);
          return out;
        }
        case 'cycle': {
          const base = toIterableArr(args[0], this);
          if (base.length === 0) throw new RuntimeErr('itertools.cycle() of an empty sequence would never produce anything.');
          return new CycleMarker(base);
        }
        case 'compress': {
          const data = toIterableArr(args[0], this);
          const sel = args[1];
          const out = [];
          if (sel instanceof CycleMarker) {
            for (let i = 0; i < data.length; i++) if (this.pyTruthy(sel.base[i % sel.base.length])) out.push(data[i]);
          } else {
            const selArr = toIterableArr(sel, this);
            const lim = Math.min(data.length, selArr.length);
            for (let i = 0; i < lim; i++) if (this.pyTruthy(selArr[i])) out.push(data[i]);
          }
          return out;
        }
        case 'islice': {
          if (args[0] instanceof CycleMarker) {
            const base = args[0].base;
            const count = Math.trunc(toNum(args[1]));
            const out = [];
            for (let i = 0; i < count; i++) out.push(base[i % base.length]);
            return out;
          }
          const arr = toIterableArr(args[0], this);
          let start, stop, step;
          if (args.length <= 2) { start = 0; stop = (args[1] === undefined || args[1] === null) ? arr.length : Math.trunc(toNum(args[1])); step = 1; }
          else {
            start = Math.trunc(toNum(args[1]));
            stop = (args[2] === undefined || args[2] === null) ? arr.length : Math.trunc(toNum(args[2]));
            step = args[3] !== undefined ? Math.trunc(toNum(args[3])) : 1;
          }
          const out = [];
          for (let i = start; i < stop && i < arr.length; i += step) out.push(arr[i]);
          return out;
        }
        case 'repeat': {
          if (args[1] === undefined) throw new RuntimeErr('itertools.repeat() with no explicit count is infinite, which this sandbox cannot materialize - call it with a count, e.g. repeat(x, 5).');
          return new Array(Math.max(0, Math.trunc(toNum(args[1])))).fill(args[0]);
        }
        case 'starmap': { const fn = args[0]; return toIterableArr(args[1], this).map(tup => this.invoke(fn, toIterableArr(tup, this))); }
        // ── numpy-lite (see the NDArray class above for scope notes) ──
        case 'np_array': return new NDArray(toIterableArr(args[0], this).slice());
        case 'np_arange': {
          let start, stop, step;
          if (args.length === 1) { start = 0; stop = toNum(args[0]); step = 1; }
          else { start = toNum(args[0]); stop = toNum(args[1]); step = args[2] !== undefined ? toNum(args[2]) : 1; }
          if (step === 0) throw new RuntimeErr('arange() step must not be zero');
          const out = [];
          if (step > 0) for (let x = start; x < stop; x += step) out.push(x);
          else for (let x = start; x > stop; x += step) out.push(x);
          return new NDArray(out);
        }
        case 'np_zeros': return new NDArray(new Array(Math.max(0, Math.trunc(toNum(args[0])))).fill(0));
        case 'np_ones': return new NDArray(new Array(Math.max(0, Math.trunc(toNum(args[0])))).fill(1));
        case 'np_linspace': {
          const start = toNum(args[0]), stop = toNum(args[1]), num = args[2] !== undefined ? Math.trunc(toNum(args[2])) : 50;
          if (num <= 0) return new NDArray([]);
          if (num === 1) return new NDArray([start]);
          const step = (stop - start) / (num - 1);
          const out = [];
          for (let i = 0; i < num; i++) out.push(start + step * i);
          return new NDArray(out);
        }
        case 'np_sum': { const d = args[0] instanceof NDArray ? args[0].data : toIterableArr(args[0], this).map(toNum); return d.reduce((a, b) => a + b, 0); }
        case 'np_mean': { const d = args[0] instanceof NDArray ? args[0].data : toIterableArr(args[0], this).map(toNum); if (d.length === 0) throw new RuntimeErr('mean of empty array'); return d.reduce((a, b) => a + b, 0) / d.length; }
        case 'np_min': { const d = args[0] instanceof NDArray ? args[0].data : toIterableArr(args[0], this).map(toNum); if (d.length === 0) throw new RuntimeErr('min of empty array'); return Math.min(...d); }
        case 'np_max': { const d = args[0] instanceof NDArray ? args[0].data : toIterableArr(args[0], this).map(toNum); if (d.length === 0) throw new RuntimeErr('max of empty array'); return Math.max(...d); }
        case 'np_std': {
          const d = args[0] instanceof NDArray ? args[0].data : toIterableArr(args[0], this).map(toNum);
          if (d.length === 0) throw new RuntimeErr('std of empty array');
          const m = d.reduce((a, b) => a + b, 0) / d.length;
          return Math.sqrt(d.reduce((a, x) => a + (x - m) * (x - m), 0) / d.length);
        }
        case 'np_abs': {
          const v = args[0];
          if (v instanceof NDArray) return new NDArray(v.data.map(x => Math.abs(toNum(x))));
          return Math.abs(toNum(v));
        }
        case 'np_dot': {
          const a = toIterableArr(args[0], this).map(toNum), b = toIterableArr(args[1], this).map(toNum);
          if (a.length !== b.length) throw new RuntimeErr(`shapes (${a.length},) and (${b.length},) not aligned`);
          return a.reduce((acc, x, i) => acc + x * b[i], 0);
        }
        // ── pandas-lite (Series only - see the Series class above) ──
        case 'pd_series': {
          const data = toIterableArr(args[0], this).slice();
          const index = args[1] !== undefined ? toIterableArr(args[1], this).slice() : data.map((_, i) => i);
          if (index.length !== data.length) throw new RuntimeErr(`Length of values (${data.length}) does not match length of index (${index.length})`);
          return new Series(data, index);
        }
        // ── character codes / encoding ──
        case 'ord': { const s = toStr(args[0]); if (s.length !== 1) throw new RuntimeErr(`ord() expected a character, but a string of length ${s.length} found`); return s.charCodeAt(0); }
        case 'chr': return String.fromCharCode(Math.trunc(toNum(args[0])));
        case 'bin': { const n = Math.trunc(toNum(args[0])); return (n < 0 ? '-' : '') + '0b' + Math.abs(n).toString(2); }
        case 'hex': { const n = Math.trunc(toNum(args[0])); return (n < 0 ? '-' : '') + '0x' + Math.abs(n).toString(16); }
        case 'oct': { const n = Math.trunc(toNum(args[0])); return (n < 0 ? '-' : '') + '0o' + Math.abs(n).toString(8); }
        case 'pyencode': { const s = toStr(args[0]); const arr = []; for (let i = 0; i < s.length; i++) arr.push(s.charCodeAt(i)); return arr; } // ASCII-range approximation only, not true multi-byte UTF-8
        case 'pydecode': { const arr = args[0]; return Array.isArray(arr) ? arr.map(n => String.fromCharCode(Math.trunc(toNum(n)))).join('') : toStr(arr); }
        case 'pydivmod': { const a = toNum(args[0]), b = toNum(args[1]); if (b === 0) throw new RuntimeErr('integer division or modulo by zero'); const q = Math.floor(a / b); return [q, a - q * b]; }
        case 'pyfixed': return Number(toNum(args[0])).toFixed(Math.trunc(toNum(args[1])));
        // ── curated stdlib shims (see python-compiler.js's import handling) ──
        case 'random_random': return Math.random();
        case 'random_randint': { const a = Math.trunc(toNum(args[0])), b = Math.trunc(toNum(args[1])); return a + Math.floor(Math.random() * (b - a + 1)); }
        case 'random_uniform': { const a = toNum(args[0]), b = toNum(args[1]); return a + Math.random() * (b - a); }
        case 'random_choice': { const arr = toIterableArr(args[0], this); return arr[Math.floor(Math.random() * arr.length)]; }
        case 'random_shuffle': { const arr = args[0]; for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return null; }
        case 'math_factorial': { const n = Math.trunc(toNum(args[0])); if (n < 0) throw new RuntimeErr('factorial() not defined for negative values'); let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
        case 'math_gcd': { let a = Math.abs(Math.trunc(toNum(args[0]))), b = Math.abs(Math.trunc(toNum(args[1]))); while (b) { const t = b; b = a % b; a = t; } return a; }
        case 'math_log': { const x = toNum(args[0]); const base = args[1] !== undefined ? toNum(args[1]) : Math.E; return Math.log(x) / Math.log(base); }
        case 'math_sin': return Math.sin(toNum(args[0]));
        case 'math_cos': return Math.cos(toNum(args[0]));
        case 'math_tan': return Math.tan(toNum(args[0]));
        case 'math_fsum': {
          // Neumaier (improved Kahan) compensated summation - the whole
          // point of math.fsum over sum() is to avoid float rounding
          // error accumulating, so a plain reduce here would defeat the
          // purpose.
          let total = 0, comp = 0;
          for (const x of toIterableArr(args[0], this)) {
            const v = toNum(x);
            const t = total + v;
            comp += Math.abs(total) >= Math.abs(v) ? (total - t) + v : (v - t) + total;
            total = t;
          }
          return total + comp;
        }
        case 'ast_literal_eval': return this.astLiteralEval(toStr(args[0]));
        case 'json_dumps': return JSON.stringify(pyToPlain(args[0]));
        case 'json_loads': return plainToPy(JSON.parse(toStr(args[0])));
        case 'collections_counter': { const m = new Map(); for (const x of toIterableArr(args[0], this)) m.set(x, (m.get(x) || 0) + 1); return m; }
        case 'collections_deque': return args[0] !== undefined ? toIterableArr(args[0], this).slice() : [];
        case 'bytes_fromhex': { const hex = toStr(args[0]).replace(/\s+/g, ''); const out = []; for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16)); return out; }
        case 'pybytes': { // bytes(x): list of ints -> itself; string -> char codes; number n -> n zero bytes
          const v = args[0];
          if (v === undefined) return [];
          if (typeof v === 'number') { const out = []; for (let i = 0; i < Math.trunc(v); i++) out.push(0); return out; }
          if (typeof v === 'string') { const out = []; for (let i = 0; i < v.length; i++) out.push(v.charCodeAt(i)); return out; }
          if (Array.isArray(v)) return v.map(x => Math.trunc(toNum(x)));
          return [];
        }
        case 'pytype': { // minimal type() - returns a Python-style class-repr string
          const v = args[0];
          if (v === null || v === undefined) return "<class 'NoneType'>";
          if (typeof v === 'boolean') return "<class 'bool'>";
          if (typeof v === 'number') return Number.isInteger(v) ? "<class 'int'>" : "<class 'float'>";
          if (typeof v === 'string') return "<class 'str'>";
          if (Array.isArray(v)) return "<class 'list'>";
          if (v instanceof Map) return "<class 'dict'>";
          if (v instanceof NDArray) return "<class 'numpy.ndarray'>";
          if (v instanceof Series) return "<class 'pandas.core.series.Series'>";
          if (v instanceof PyInstance) return `<class '${v.cls.name}'>`;
          if (v instanceof PyClass) return "<class 'type'>";
          if (v instanceof Closure || v instanceof BuiltinRef) return "<class 'function'>";
          return "<class 'object'>";
        }
        case 'pyisinstance': {
          const v = args[0];
          const checkOne = (t) => {
            if (t instanceof PyClass) return v instanceof PyInstance && v.cls.isSubclassOf(t);
            if (t instanceof BuiltinRef) {
              switch (t.name) {
                case 'int': return typeof v === 'number' && Number.isInteger(v);
                case 'float': return typeof v === 'number' && !Number.isInteger(v);
                case 'str': return typeof v === 'string';
                case 'bool': return typeof v === 'boolean';
                case 'list': return Array.isArray(v);
                case 'dict': return v instanceof Map;
              }
            }
            return false;
          };
          const targets = Array.isArray(args[1]) ? args[1] : [args[1]];
          return targets.some(checkOne);
        }
        case 'pygetattr': {
          const [obj, name, def] = args;
          try {
            if (obj instanceof PyInstance) return this.getInstanceAttr(obj, name);
            if (obj instanceof Map) return obj.has(name) ? obj.get(name) : (def !== undefined ? def : (() => { throw new RuntimeErr(`'dict' object has no attribute '${name}'`); })());
          } catch (e) {
            if (def !== undefined) return def;
            throw e;
          }
          if (def !== undefined) return def;
          throw new RuntimeErr(`object has no attribute '${name}'`);
        }
        case 'pysetattr': {
          const [obj, name, val] = args;
          if (obj instanceof PyInstance) { obj.attrs.set(name, val); return null; }
          throw new RuntimeErr('setattr() target must be an instance.');
        }
        case 'pyhasattr': {
          try { this.callBuiltin('pygetattr', [args[0], args[1]]); return true; }
          catch (e) { return false; }
        }
        case 'sys_exit': throw new ExitSig(args[0] !== undefined ? args[0] : 0);
        case 'base64_encode': { // ASCII-range approximation, same caveat as pyencode/pydecode above
          const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
          const raw = args[0];
          const s = Array.isArray(raw) ? raw.map(c => String.fromCharCode(Math.trunc(toNum(c)))).join('') : toStr(raw);
          const bytes = []; for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
          let out = '';
          for (let i = 0; i < bytes.length; i += 3) {
            const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
            out += B64[b0 >> 2];
            out += B64[((b0 & 3) << 4) | (b1 !== undefined ? (b1 >> 4) : 0)];
            out += b1 !== undefined ? B64[((b1 & 15) << 2) | (b2 !== undefined ? (b2 >> 6) : 0)] : '=';
            out += b2 !== undefined ? B64[b2 & 63] : '=';
          }
          return out;
        }
        case 'base64_decode': {
          const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
          const raw = args[0];
          const s = (Array.isArray(raw) ? raw.map(c => String.fromCharCode(Math.trunc(toNum(c)))).join('') : toStr(raw)).replace(/[^A-Za-z0-9+/=]/g, '');
          let out = '';
          for (let i = 0; i < s.length; i += 4) {
            const c0 = B64.indexOf(s[i]), c1 = B64.indexOf(s[i + 1]);
            const c2 = s[i + 2] === '=' || s[i + 2] === undefined ? -1 : B64.indexOf(s[i + 2]);
            const c3 = s[i + 3] === '=' || s[i + 3] === undefined ? -1 : B64.indexOf(s[i + 3]);
            out += String.fromCharCode((c0 << 2) | (c1 >> 4));
            if (c2 !== -1) out += String.fromCharCode(((c1 & 15) << 4) | (c2 >> 2));
            if (c3 !== -1) out += String.fromCharCode(((c2 & 3) << 6) | c3);
          }
          return out;
        }
        case 'pyint': { // Python's int() raises ValueError on bad input;
          // the shared int()/toNum() above silently returns 0 instead
          // (fine for other languages, wrong for Python).
          const v = args[0];
          const base = args[1] !== undefined && args[1] !== null ? Math.trunc(toNum(args[1])) : 10;
          if (typeof v === 'number') return Math.trunc(v);
          if (typeof v === 'boolean') return v ? 1 : 0;
          if (typeof v === 'string') {
            let t = v.trim();
            let neg = false;
            if (t.startsWith('+') || t.startsWith('-')) { neg = t[0] === '-'; t = t.slice(1); }
            if (base === 16 && /^0[xX]/.test(t)) t = t.slice(2);
            else if (base === 2 && /^0[bB]/.test(t)) t = t.slice(2);
            else if (base === 8 && /^0[oO]/.test(t)) t = t.slice(2);
            const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base);
            const re = new RegExp(`^[${digits}]+$`, 'i');
            if (t === '' || !re.test(t)) throw new RuntimeErr(`invalid literal for int() with base ${base}: '${v}'`);
            const n = parseInt(t, base);
            return neg ? -n : n;
          }
          throw new RuntimeErr('int() argument must be a string or a number.');
        }
        case 'pyfloat': { // same idea as pyint() above, for float()
          const v = args[0];
          if (typeof v === 'number') return v;
          if (typeof v === 'boolean') return v ? 1 : 0;
          if (typeof v === 'string') {
            const t = v.trim();
            if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) throw new RuntimeErr(`could not convert string to float: '${v}'`);
            return parseFloat(t);
          }
          throw new RuntimeErr('float() argument must be a string or a number.');
        }
        case 'pybool': return this.pyTruthy(args[0]);
      }
      throw new RuntimeErr(`Unknown function "${name}()".`);
    }
  }

  function looseEq(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) return a.length===b.length && a.every((v,i)=>looseEq(v,b[i]));
    if (a instanceof Map && b instanceof Map) {
      if (a.size !== b.size) return false;
      for (const [k, v] of a) { if (!b.has(k) || !looseEq(v, b.get(k))) return false; }
      return true;
    }
    if (a === b) return true;
    if (typeof a === 'number' || typeof b === 'number') return toNum(a) === toNum(b) && !(a===null&&b===undefined);
    return toStr(a) === toStr(b);
  }

  /* ────────────────────────────────────────────────────────────────
     5. PUBLIC ENTRY — parse + run canonical source
  ──────────────────────────────────────────────────────────────── */
  function runCanonical(canonicalSrc, stdin, opts) {
    try {
      const toks = lex(canonicalSrc, opts);
      const ast = new Parser(toks).parseProgram();
      const exec = new Exec(stdin);
      exec.run(ast);
      return { ok:true, output: exec.out };
    } catch (err) {
      if (err instanceof ThrowSig) {
        return { ok:false, error: 'Uncaught exception: ' + toStr(err.value), errorType: 'RuntimeError' };
      }
      const type = err instanceof ParseErr ? 'SyntaxError' : (err instanceof RuntimeErr ? 'RuntimeError' : 'RuntimeError');
      return { ok:false, error: err.message, errorType: type };
    }
  }

  // Set by python-compiler.js (if loaded) so exec()/eval() with a
  // dynamically-computed source string can transpile it at runtime - see
  // the 'pyexec'/'pyeval_src' cases in callBuiltin. Deliberately a soft
  // link (a plain function reference set after the fact) rather than a
  // hard dependency, since core-engine.js is the lower-level module and
  // python-compiler.js is the one that depends on it, not the reverse.
  let pythonTranspile = null;
  function setPythonTranspiler(fn) { pythonTranspile = fn; }

  return { lex, Parser, Exec, runCanonical, RuntimeErr, ParseErr, ThrowSig, setPythonTranspiler };
})();
if (typeof module !== 'undefined') module.exports = CoreEngine;