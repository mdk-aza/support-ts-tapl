// ====== imports ======
import {error} from "npm:tiny-ts-parser"; // ← これを追加！

// ====== 1) 定数群（タグ/記号/JS型名/エラー）============================

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

// --- Resultタグ
export const ResultTag = {
  Ok: "Ok",
  Err: "Err",
} as const;

// --- エラーコード（内部識別子）
export const ErrorCode = {
  IfCondNotBoolean: "IfCondNotBoolean",
  IfBranchesMismatch: "IfBranchesMismatch",
  RuntimeAddType: "RuntimeAddType",
  RuntimeIfType: "RuntimeIfType",
  Unreachable: "Unreachable",
} as const;
export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

// --- エラーメッセージ（表示用）
export const Messages: Record<ErrorCode, string> = {
  [ErrorCode.IfCondNotBoolean]: "boolean expected",
  [ErrorCode.IfBranchesMismatch]: "then and else have different types",
  [ErrorCode.RuntimeAddType]: "number expected",
  [ErrorCode.RuntimeIfType]: "boolean expected",
  [ErrorCode.Unreachable]: "unreachable",
};

// ====== 2) AST / Type / Value / Result =================================

// --- AST node 型（tag は必ず TermTag.* を使う）
export type Term =
  | { tag: typeof TermTag.True }
  | { tag: typeof TermTag.False }
  | { tag: typeof TermTag.If; cond: Term; thn: Term; els: Term }
  | { tag: typeof TermTag.Number; n: number }
  | { tag: typeof TermTag.Add; left: Term; right: Term }
  | { tag: typeof TermTag.Var; name: string }
  | { tag: typeof TermTag.Func; params: Param[]; body: Term }
  | { tag: typeof TermTag.Call; func: Term; args: Term[] }
  | { tag: typeof TermTag.Seq; body: Term; rest: Term }
  | { tag: typeof TermTag.Const; name: string; init: Term; rest: Term };

export type Type =
  | { tag: typeof TypeTag.Boolean }
  | { tag: typeof TypeTag.Number }
  | { tag: typeof TypeTag.Func; params: Type[]; ret: Type };

type Param = { name: string; type: Type };

export type Err<E> = { tag: typeof ResultTag.Err; error: ReadonlyArray<E> };
export type Ok<A> = { tag: typeof ResultTag.Ok; value: A };
export type Result<A, E> = Ok<A> | Err<E>;

// ====== 4) fold（catamorphism：再帰の形を一箇所に集約）=================

type Child<A> = { out: A; node: Term };

type TermParaAlg<A> = {
  True: (self: Term) => A;
  False: (self: Term) => A;
  Number: (n: number, self: Term) => A;
  Add: (left: Child<A>, right: Child<A>, self: Term) => A;
  If: (cond: Child<A>, thn: Child<A>, els: Child<A>, self: Term) => A;
};

export function paraTerm<A>(alg: TermParaAlg<A>, t: Term): A {
  switch (t.tag) {
    case TermTag.True:
      return alg.True(t);
    case TermTag.False:
      return alg.False(t);
    case TermTag.Number:
      return alg.Number(t.n, t);
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
  }
}

export function typecheck(t: Term): Type {
  return paraTerm<Type>({
    True: () => ({ tag: TypeTag.Boolean }),
    False: () => ({ tag: TypeTag.Boolean }),
    Number: () => ({ tag: TypeTag.Number }),

    Add: (L, R) => {
      if (L.out.tag !== TypeTag.Number) {
        error(Messages[ErrorCode.RuntimeAddType], L.node);
      }
      if (R.out.tag !== TypeTag.Number) {
        error(Messages[ErrorCode.RuntimeAddType], R.node);
      }
      return { tag: TypeTag.Number };
    },

    If: (C, T, E, self) => {
      if (C.out.tag !== TypeTag.Boolean) {
        error(Messages[ErrorCode.RuntimeIfType], C.node);
      }
      if (T.out.tag !== E.out.tag) {
        error(Messages[ErrorCode.IfBranchesMismatch], self);
      }
      return T.out;
    },
  }, t);
}
