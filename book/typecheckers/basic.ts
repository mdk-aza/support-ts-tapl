// ====== imports ======
import {error} from "npm:tiny-ts-parser";

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

// --- エラーコード
export const ErrorCode = {
    IfCondNotBoolean: "IfCondNotBoolean",
    IfBranchesMismatch: "IfBranchesMismatch",
    RuntimeAddType: "RuntimeAddType",
    RuntimeIfType: "RuntimeIfType",
    Unreachable: "Unreachable",
} as const;
export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

// --- エラーメッセージ
export const Messages: Record<ErrorCode, string> = {
    [ErrorCode.IfCondNotBoolean]: "boolean expected",
    [ErrorCode.IfBranchesMismatch]: "then and else have different types",
    [ErrorCode.RuntimeAddType]: "number expected",
    [ErrorCode.RuntimeIfType]: "boolean expected",
    [ErrorCode.Unreachable]: "unreachable",
};

// ====== 2) AST / Type / Result =========================================

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
                if (!typeEq(a.params[i], bf.params[i])) return false;
            }
            return typeEq(a.ret, bf.ret);
        }
    }
}

// ====== 4) paraTerm（paramorphism）=======================================

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

// ====== 5) 型検査器 =======================================================

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
            if (!typeEq(T.out, E.out)) {
                error(Messages[ErrorCode.IfBranchesMismatch], self);
            }
            return T.out;
        },
    }, t);
}
