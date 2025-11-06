// ====== imports ======
import {error as parseError, parseBasic} from "npm:tiny-ts-parser"; // 位置付きエラーをそのまま利用

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
  FuncExpected: "function expected",
  ArgCountMismatch: "number of arguments mismatch",
  ArgTypeMismatch: "argument type mismatch",
} as const;

// ====== 2) AST / Type / Env / Location =================================

export type Position = { line: number; column: number };
export type Location = { start: Position; end: Position };

export type Param = { name: string; type: Type };

// パーサのノードは loc を必ず持つ前提（span ではなく loc）
export type Term =
  | { tag: typeof TermTag.True; loc: Location }
  | { tag: typeof TermTag.False; loc: Location }
  | { tag: typeof TermTag.Number; n: number; loc: Location }
  | { tag: typeof TermTag.Add; left: Term; right: Term; loc: Location }
  | { tag: typeof TermTag.If; cond: Term; thn: Term; els: Term; loc: Location }
  | { tag: typeof TermTag.Var; name: string; loc: Location }
  | { tag: typeof TermTag.Func; params: Param[]; body: Term; loc: Location }
  | { tag: typeof TermTag.Call; func: Term; args: Term[]; loc: Location }
  | { tag: typeof TermTag.Seq; body: Term; rest: Term; loc: Location }
  | { tag: typeof TermTag.Const; name: string; init: Term; rest: Term; loc: Location };

export type Type =
  | { tag: typeof TypeTag.Boolean }
  | { tag: typeof TypeTag.Number }
  | { tag: typeof TypeTag.Func; params: Param[]; retType: Type };

export type TypeEnv = Readonly<Record<string, Type>>;
export const emptyEnv: TypeEnv = Object.freeze({});

// const extendEnv = (env: TypeEnv, entries: ReadonlyArray<readonly [string, Type]>): TypeEnv =>
//   entries.reduce((e, [k, v]) => ({ ...e, [k]: v }), env);
// 1. パフォーマンスの問題（O(n²)）
// 2. 不変性の保証がない
const extendEnv = (
  env: TypeEnv,
  entries: ReadonlyArray<readonly [string, Type]>,
): TypeEnv =>
  Object.freeze({
    ...env,
    ...Object.fromEntries(entries),
  });

// レキシカル環境っぽく、親を env にした空オブジェクトに新バインディングだけ載せます。
// これだと コピーを一切しないので、作成は実質 O(n)（新規バインディング分のみ）で、
// 既存環境サイズ |env| に依存するコピーが消えます。
// 参照は env[name] のプロトタイプ探索で解決（スコープが深くても通常は浅い）
// メモリも親のプロパティを再コピーしないぶん小さくなる
// 注意点：Object.keys(child) は自分のキーのみ返し、親のキーは返しません（それでOKなら最高）
// const extendEnv = (
//   env: TypeEnv,
//   entries: ReadonlyArray<readonly [string, Type]>,
// ): TypeEnv => {
//   const child = Object.create(env) as TypeEnv;
//   for (const [k, v] of entries) {
//     Object.defineProperty(child, k, { value: v, enumerable: true, configurable: false, writable: false });
//   }
//   return Object.freeze(child);
// };
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
        if (!typeEq(a.params[i].type, bb.params[i].type)) return false; // 引数名は比較しない
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

// ====== 4.5) 位置付きエラー（パーサの error に {loc} を渡す） ============

function errorAt(msg: string, loc: Location): never {
  try {
    // npm:tiny-ts-parser の error は node.loc を読む前提なのでラップ
    parseError(msg, { loc } as any);
  } catch {
    // parseError が throw しなかった場合の保険（通常ここに来ない）
  }
  // 念のためフォールバック
  const s = loc.start, e = loc.end;
  throw new Error(`test.ts:${s.line}:${s.column + 1}-${e.line}:${e.column + 1} ${msg}`);
}

// ====== 5) 環境付き catamorphism（foldTermR） ===========================

type TermAlgR<A> = {
  True: (loc: Location) => R<A>;
  False: (loc: Location) => R<A>;
  Number: (n: number, loc: Location) => R<A>;
  Add: (l: R<A>, r: R<A>, loc: Location) => R<A>;
  If: (c: R<A>, t: R<A>, e: R<A>, loc: Location) => R<A>;
  Var: (name: string, loc: Location) => R<A>;
  Func: (params: Param[], body: R<A>, loc: Location) => R<A>;
  Call: (f: R<A>, args: ReadonlyArray<R<A>>, loc: Location) => R<A>;
};

export function foldTermR<A>(alg: TermAlgR<A>, t: Term): R<A> {
  switch (t.tag) {
    case TermTag.True:
      return alg.True(t.loc);
    case TermTag.False:
      return alg.False(t.loc);
    case TermTag.Number:
      return alg.Number(t.n, t.loc);
    case TermTag.Var:
      return alg.Var(t.name, t.loc);
    case TermTag.Add:
      return alg.Add(
        foldTermR(alg, t.left),
        foldTermR(alg, t.right),
        t.loc,
      );
    case TermTag.If:
      return alg.If(
        foldTermR(alg, t.cond),
        foldTermR(alg, t.thn),
        foldTermR(alg, t.els),
        t.loc,
      );
    case TermTag.Func:
      return alg.Func(t.params, foldTermR(alg, t.body), t.loc);
    case TermTag.Call:
      const f = foldTermR(alg, t.func);
      const args = t.args.map((a) => foldTermR(alg, a));
      return alg.Call(f, args, t.loc);
    case TermTag.Seq:
    case TermTag.Const:
      return (_env) => errorAt(Messages.NotImplemented, t.loc);
  }
}

// ====== 6) 型検査用の代数（位置付きエラー対応） =========================

const algType: TermAlgR<Type> = {
  True: (_loc) => pureR({ tag: TypeTag.Boolean }),
  False: (_loc) => pureR({ tag: TypeTag.Boolean }),
  Number: (_n, _loc) => pureR({ tag: TypeTag.Number }),

  Var: (name, loc) =>
    asks((env) => {
      const ty = env[name];
      if (!ty) errorAt(`${Messages.UnknownVariable}: ${name}`, loc);
      return ty!;
    }),

  Add: (l, r, loc) => (env) => {
    const lt = l(env), rt = r(env);
    if (lt.tag !== TypeTag.Number || rt.tag !== TypeTag.Number) {
      errorAt(Messages.RuntimeAddType, loc);
    }
    return { tag: TypeTag.Number };
  },

  If: (c, t, e, loc) => (env) => {
    const ct = c(env);
    if (ct.tag !== TypeTag.Boolean) errorAt(Messages.IfCondNotBoolean, loc);
    const tt = t(env), ee = e(env);
    if (!typeEq(tt, ee)) errorAt(Messages.IfBranchesMismatch, loc);
    return tt;
  },

  Func: (params, body, _loc) => {
    const withArgs = (env: TypeEnv) => extendEnv(env, params.map((p) => [p.name, p.type] as const));
    const retR: R<Type> = local(withArgs)(body); // 本体は拡張環境で
    return mapR(retR, (retTy) => ({ tag: TypeTag.Func, params, retType: retTy } as Type));
  },
  Call: (f, args, loc) => (env) => {
    const fty = f(env);
    if (fty.tag !== TypeTag.Func) {
      errorAt(Messages.FuncExpected, loc);
    }

    const fn = fty as Extract<Type, { tag: typeof TypeTag.Func }>;
    const argTys = args.map((a) => a(env));

    if (fn.params.length !== argTys.length) {
      errorAt(Messages.ArgCountMismatch, loc);
    }

    for (let i = 0; i < argTys.length; i++) {
      if (!typeEq(fn.params[i].type, argTys[i])) {
        errorAt(Messages.ArgTypeMismatch, loc);
      }
    }
    return fn.retType;
  },
};

// ====== 7) 公開 API =====================================================

export function typecheck(t: Term, env: TypeEnv = emptyEnv): Type {
  return foldTermR(algType, t)(env);
}

// ====== 8) 動作テスト ====================================================

console.log(typecheck(parseBasic("(x: boolean) => 42") as unknown as Term, {}));
console.log(typecheck(parseBasic("(x: number) => x") as unknown as Term, {}));

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
  const term = parseBasic(code) as unknown as Term;
  try {
    const ty = typecheck(term);
    console.log(`${code} :: ${ty.tag}`);
  } catch (e) {
    console.error(`${code} => ${(e as Error).message}`);
  }
}
const callExamples = [
  "((x: number) => x + 1)(41)", // OK : Number
  "((x: number, y: number) => x)(1, 2)", // OK : Number
  "((x: number) => x)(true)", // NG : argument type mismatch
  "((x: number, y: number) => x)(1)", // NG : number of arguments mismatch
  "(1)(2)", // NG : function expected
];

for (const code of callExamples) {
  const term = parseBasic(code) as unknown as Term;
  try {
    const ty = typecheck(term);
    console.log(`${code} :: ${ty.tag}`);
  } catch (e) {
    console.error(`${code} => ${(e as Error).message}`);
  }
}
