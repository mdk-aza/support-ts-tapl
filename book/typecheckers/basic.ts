// ====== imports ======
import {error, parseBasic} from "npm:tiny-ts-parser";

// ====== 1) 定数群（タグ/記号/エラー）=====================================

// --- ASTタグ（Term）
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

// --- 型タグ（対象言語の型）
export const TypeTag = {
  Boolean: "Boolean",
  Number: "Number",
  Func: "Func",
} as const;

// --- エラーコード／メッセージ
export const ErrorCode = {
  IfCondNotBoolean: "IfCondNotBoolean",
  IfBranchesMismatch: "IfBranchesMismatch",
  RuntimeAddType: "RuntimeAddType",
  RuntimeIfType: "RuntimeIfType",
  Unreachable: "Unreachable",
} as const;
export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

export const Messages: Record<ErrorCode, string> = {
  [ErrorCode.IfCondNotBoolean]: "boolean expected",
  [ErrorCode.IfBranchesMismatch]: "then and else have different types",
  [ErrorCode.RuntimeAddType]: "number expected",
  [ErrorCode.RuntimeIfType]: "boolean expected",
  [ErrorCode.Unreachable]: "unreachable",
};

// ====== 2) AST / Type / Env =============================================

export type Term =
  | { tag: typeof TermTag.True }
  | { tag: typeof TermTag.False }
  | { tag: typeof TermTag.Number; n: number }
  | { tag: typeof TermTag.Add; left: Term; right: Term }
  | { tag: typeof TermTag.If; cond: Term; thn: Term; els: Term }
  | { tag: typeof TermTag.Var; name: string }
  | { tag: typeof TermTag.Func; params: Param[]; body: Term }
  | { tag: typeof TermTag.Call; func: Term; args: Term[] }
  | { tag: typeof TermTag.Seq; body: Term; rest: Term }
  | { tag: typeof TermTag.Const; name: string; init: Term; rest: Term };

export type Type =
  | { tag: typeof TypeTag.Boolean }
  | { tag: typeof TypeTag.Number }
  | { tag: typeof TypeTag.Func; params: Param[]; retType: Type };

export type Param = { name: string; type: Type };

export type TypeEnv = Readonly<Record<string, Type>>;
export const emptyEnv: TypeEnv = Object.freeze({});

export const envExtend = (
  env: TypeEnv,
  entries: ReadonlyArray<readonly [string, Type]>,
): TypeEnv => entries.reduce((e, [k, v]) => ({ ...e, [k]: v }), env);

// ====== 3) 型等価判定 =====================================================

export function typeEq(a: Type, b: Type): boolean {
  if (a.tag !== b.tag) return false;
  switch (a.tag) {
    case TypeTag.Boolean:
    case TypeTag.Number:
      return true;
    case TypeTag.Func: {
      const bf = b as Extract<Type, { tag: typeof TypeTag.Func }>;
      if (a.params.length !== bf.params.length) return false;
      for (let i = 0; i < a.params.length; i++) {
        if (!typeEq(a.params[i].type, bf.params[i].type)) return false; // 引数名は無視
      }
      return typeEq(a.retType, bf.retType);
    }
  }
}

// ====== 4) paramorphism（paraTerm）=======================================

type Child<A> = { out: A; node: Term };

type TermParaAlg<A> = {
  True: (self: Term) => A;
  False: (self: Term) => A;
  Number: (n: number, self: Term) => A;
  Add: (left: Child<A>, right: Child<A>, self: Term) => A;
  If: (cond: Child<A>, thn: Child<A>, els: Child<A>, self: Term) => A;
  Var: (name: string, self: Term) => A;
  Func: (params: Param[], body: Child<A>, self: Term) => A;
  // Call/Seq/Const は未実装（必要なら追加）
};

export function paraTerm<A>(alg: TermParaAlg<A>, t: Term): A {
  switch (t.tag) {
    case TermTag.True:
      return alg.True(t);
    case TermTag.False:
      return alg.False(t);
    case TermTag.Number:
      return alg.Number(t.n, t);
    case TermTag.Var:
      return alg.Var(t.name, t);
    case TermTag.Add: {
      const l = { out: paraTerm(alg, t.left), node: t.left };
      const r = { out: paraTerm(alg, t.right), node: t.right };
      return alg.Add(l, r, t);
    }
    case TermTag.If: {
      const c = { out: paraTerm(alg, t.cond), node: t.cond };
      const th = { out: paraTerm(alg, t.thn), node: t.thn };
      const el = { out: paraTerm(alg, t.els), node: t.els };
      return alg.If(c, th, el, t);
    }
    case TermTag.Func: {
      const b = { out: paraTerm(alg, t.body), node: t.body };
      return alg.Func(t.params, b, t);
    }
    case TermTag.Call:
    case TermTag.Seq:
    case TermTag.Const:
      error("not implemented yet", t);
      // 到達しない
      return undefined as unknown as A;
  }
}

// ====== 5) 型検査器 =======================================================

export function typecheck(t: Term, env: TypeEnv = emptyEnv): Type {
  return paraTerm<Type>({
    True: () => ({ tag: TypeTag.Boolean }),
    False: () => ({ tag: TypeTag.Boolean }),
    Number: () => ({ tag: TypeTag.Number }),

    Var: (name, self) => {
      const ty = env[name];
      if (!ty) error(`unknown variable: ${name}`, self);
      return ty!;
    },

    Add: (L, R) => {
      if (L.out.tag !== TypeTag.Number) error(Messages[ErrorCode.RuntimeAddType], L.node);
      if (R.out.tag !== TypeTag.Number) error(Messages[ErrorCode.RuntimeAddType], R.node);
      return { tag: TypeTag.Number };
    },

    If: (C, T, E, self) => {
      if (C.out.tag !== TypeTag.Boolean) error(Messages[ErrorCode.RuntimeIfType], C.node);
      if (!typeEq(T.out, E.out)) error(Messages[ErrorCode.IfBranchesMismatch], self);
      return T.out;
    },

    Func: (params, body, _self) => {
      // 1) 引数型で環境を拡張
      const localEnv = envExtend(env, params.map((p) => [p.name, p.type] as const));
      // 2) 本体を拡張環境で改めて型付け（para の out は元envなので使わない）
      const retTy = typecheck(body.node, localEnv);
      // 3) 期待どおりの関数型を返す（名前つき params / retType）
      return { tag: TypeTag.Func, params, retType: retTy };
    },
  }, t);
}
console.log(typecheck(parseBasic("(x: boolean) => 42"), {}));
