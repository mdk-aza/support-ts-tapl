// ====== imports ======
import {error, parseBasic} from "npm:tiny-ts-parser"; // 位置付きエラー用

// ====== 1) 定数群（タグ/エラー文言）=====================================

export const TermTag = {
  True: "true",
  False: "false",
  If: "if",
  Number: "number",
  Add: "add",
  Var: "var",
  Func: "func",
  Call: "call",
  Seq: "seq",
  Const: "const",
} as const;

export const TypeTag = {
  Boolean: "Boolean",
  Number: "Number",
  Func: "Func",
} as const;

export const Messages = {
  IfCondNotBoolean: "boolean expected",
  IfBranchesMismatch: "then and else have different types",
  RuntimeAddType: "number expected",
  UnknownVariable: "unknown variable",
  NotImplemented: "not implemented yet",
} as const;

// ====== 2) AST / Type / Env / Span =====================================

export type Span = { start: number; end: number }; // 必要なら {line,col} も拡張可

export type Param = { name: string; type: Type };

export type Term =
  | { tag: typeof TermTag.True; span: Span }
  | { tag: typeof TermTag.False; span: Span }
  | { tag: typeof TermTag.Number; n: number; span: Span }
  | { tag: typeof TermTag.Add; left: Term; right: Term; span: Span }
  | { tag: typeof TermTag.If; cond: Term; thn: Term; els: Term; span: Span }
  | { tag: typeof TermTag.Var; name: string; span: Span }
  | { tag: typeof TermTag.Func; params: Param[]; body: Term; span: Span }
  | { tag: typeof TermTag.Call; func: Term; args: Term[]; span: Span }
  | { tag: typeof TermTag.Seq; body: Term; rest: Term; span: Span }
  | { tag: typeof TermTag.Const; name: string; init: Term; rest: Term; span: Span };

export type Type =
  | { tag: typeof TypeTag.Boolean }
  | { tag: typeof TypeTag.Number }
  | { tag: typeof TypeTag.Func; params: Param[]; retType: Type };

export type TypeEnv = Readonly<Record<string, Type>>;
export const emptyEnv: TypeEnv = Object.freeze({});

const extendEnv = (env: TypeEnv, entries: ReadonlyArray<readonly [string, Type]>): TypeEnv =>
  entries.reduce((e, [k, v]) => ({ ...e, [k]: v }), env);

// ====== 3) 型等価（引数名は無視、型だけ比較）===========================

export function typeEq(a: Type, b: Type): boolean {
  if (a.tag !== b.tag) return false;
  switch (a.tag) {
    case TypeTag.Boolean:
    case TypeTag.Number:
      return true;
    case TypeTag.Func: {
      const bb = b as Extract<Type, { tag: typeof TypeTag.Func }>;
      if (a.params.length !== bb.params.length) return false;
      for (let i = 0; i < a.params.length; i++) {
        if (!typeEq(a.params[i].type, bb.params[i].type)) return false; // 名前は比較しない
      }
      return typeEq(a.retType, bb.retType);
    }
  }
}

// ====== 4) Reader（環境） & cata 用コンビネータ =========================

type R<A> = (env: TypeEnv) => A;
const pureR = <A>(a: A): R<A> => () => a;
const asks = <A>(f: (env: TypeEnv) => A): R<A> => f;
const local = (f: (env: TypeEnv) => TypeEnv) => <A>(ra: R<A>): R<A> => (env) => ra(f(env));
const mapR = <A, B>(ra: R<A>, f: (a: A) => B): R<B> => (env) => f(ra(env));
const lift2R = <A, B, C>(f: (a: A, b: B) => C) => (ra: R<A>, rb: R<B>): R<C> => (env) => f(ra(env), rb(env));

export type Pos = { line: number; column: number; index?: number };
export type Span = { start: Pos; end: Pos; source?: string };

// 2) tiny-ts-parser に渡すアダプタつき errorAt を定義
const formatSpan = (s: Span) => {
    const src = s.source ?? "unknown";
    const sLine = s.start.line ?? 0;
    const sCol  = s.start.column ?? 0;
    const eLine = s.end.line ?? sLine;
    const eCol  = s.end.column ?? sCol;
    return `${src}:${sLine}:${sCol}-${eLine}:${eCol}`;
};

const errorAt = (msg: string, span: Span): never => {
    // tiny-ts-parser.error は node.loc を期待するので、ラップして渡す
    const nodeLike = { loc: span };
    try {
        // ここで tiny-ts-parser が loc を読んでフォーマットしてくれる
        error(msg, nodeLike as any);
    } catch {
        // もしプラグイン側で更に投げなかった場合の保険
    }
    // フォールバック（何があってもユーザーに位置を見せる）
    throw new Error(`${formatSpan(span)} ${msg}`);
};

// 例: リテラル number
function makeNumber(node: any, n: number): Term {
    return { tag: TermTag.Number, n, span: node.loc };
}

// 例: 加算
function makeAdd(node: any, left: Term, right: Term): Term {
    return { tag: TermTag.Add, left, right, span: node.loc };
}

// 例: if
function makeIf(node: any, cond: Term, thn: Term, els: Term): Term {
    return { tag: TermTag.If, cond, thn, els, span: node.loc };
}

// 例: 変数
function makeVar(node: any, name: string): Term {
    return { tag: TermTag.Var, name, span: node.loc };
}

// 例: 関数
function makeFunc(node: any, params: Param[], body: Term): Term {
    return { tag: TermTag.Func, params, body, span: node.loc };
}

// ====== 5) 環境付き catamorphism（foldTermR） ===========================

type TermAlgR<A> = {
  True: (span: Span) => R<A>;
  False: (span: Span) => R<A>;
  Number: (n: number, span: Span) => R<A>;
  Add: (l: R<A>, r: R<A>, span: Span) => R<A>;
  If: (c: R<A>, t: R<A>, e: R<A>, span: Span) => R<A>;
  Var: (name: string, span: Span) => R<A>;
  Func: (params: Param[], body: R<A>, span: Span) => R<A>;
  // Call / Seq / Const は必要に応じて追加
};

export function foldTermR<A>(alg: TermAlgR<A>, t: Term): R<A> {
  switch (t.tag) {
    case TermTag.True:
      return alg.True(t.span);
    case TermTag.False:
      return alg.False(t.span);
    case TermTag.Number:
      return alg.Number(t.n, t.span);
    case TermTag.Var:
      return alg.Var(t.name, t.span);
    case TermTag.Add:
      return alg.Add(
        foldTermR(alg, t.left),
        foldTermR(alg, t.right),
        t.span,
      );
    case TermTag.If:
      return alg.If(
        foldTermR(alg, t.cond),
        foldTermR(alg, t.thn),
        foldTermR(alg, t.els),
        t.span,
      );
    case TermTag.Func:
      return alg.Func(t.params, foldTermR(alg, t.body), t.span);
    case TermTag.Call:
    case TermTag.Seq:
    case TermTag.Const:
      return (_env) => errorAt(Messages.NotImplemented, t.span);
  }
}

// ====== 6) 型検査用の代数（位置付きエラー対応） =========================

const algType: TermAlgR<Type> = {
  True: (_s) => pureR({ tag: TypeTag.Boolean }),
  False: (_s) => pureR({ tag: TypeTag.Boolean }),
  Number: (_n, _s) => pureR({ tag: TypeTag.Number }),

  Var: (name, s) =>
    asks((env) => {
      const ty = env[name];
      if (!ty) errorAt(`${Messages.UnknownVariable}: ${name}`, s);
      return ty!;
    }),

  Add: (l, r, s) => (env) => {
    const lt = l(env), rt = r(env);
    if (lt.tag !== TypeTag.Number || rt.tag !== TypeTag.Number) {
      errorAt(Messages.RuntimeAddType, s);
    }
    return { tag: TypeTag.Number };
  },

  If: (c, t, e, s) => (env) => {
    const ct = c(env);
    if (ct.tag !== TypeTag.Boolean) errorAt(Messages.IfCondNotBoolean, s);
    const tt = t(env), ee = e(env);
    if (!typeEq(tt, ee)) errorAt(Messages.IfBranchesMismatch, s);
    return tt;
  },
  Func: (params, body, _s) => {
    const withArgs = (env: TypeEnv) => extendEnv(env, params.map((p) => [p.name, p.type] as const));
    // 本体は拡張環境で型付け
    const retR: R<Type> = local(withArgs)(body);
    // 関数型を構築
    return mapR(retR, (retTy) => ({ tag: TypeTag.Func, params, retType: retTy } as Type));
  },
};

// ====== 7) 公開 API =====================================================

export function typecheck(t: Term, env: TypeEnv = emptyEnv): Type {
  return foldTermR(algType, t)(env);
}

console.log(typecheck(parseBasic("(x: boolean) => 42"), {}));
console.log(typecheck(parseBasic("(x: number) => x"), {}));

const examples = [
  "true",
  "false",
  "true ? 1 : 2",
  "1",
  "1 + 2",
  "true ? 1 : true", // ← then and else have different types
  "true + 1", // ← number expected
  "1 + true", // ← number expected
];

for (const code of examples) {
  const term = parseBasic(code) as Term;
  try {
    const ty = typecheck(term);
    console.log(`${code} :: ${ty.tag}`);
  } catch (e) {
    console.error(`${code} => ${(e as Error).message}`);
  }
}
