// ====== imports ======
import { match, P } from "npm:ts-pattern";           // Nodeなら: from "ts-pattern"
import { parseArith } from "./book/tiny-ts-parser.ts";

// ====== 1) 定数群（タグ/記号/JS型名/エラー）============================

// --- ASTタグ（Term）
export const TermTag = {
    True:   "true",
    False:  "false",
    If:     "if",
    Number: "number",
    Add:    "add",
} as const;

// --- 型タグ（対象言語の型）
export const TypeTag = {
    Boolean: "Boolean",
    Number:  "Number",
} as const;

// --- 値タグ（評価結果の表現：対象言語の値を構造体で保持）
export const ValueTag = {
    Boolean: "BoolValue",
    Number:  "NumValue",
} as const;

// --- Resultタグ
export const ResultTag = {
    Ok:  "Ok",
    Err: "Err",
} as const;

// --- プリティプリント用の語句・記号
export const KW = {
    true:  "true",
    false: "false",
    if:    "if",
    then:  "then",
    else:  "else",
} as const;

export const SYM = {
    plus: "+",
    lpar: "(",
    rpar: ")",
} as const;

// --- JSの typeof で使う型名（生文字列を排除）
export const JsType = {
    Number: "number",
    Boolean: "boolean",
} as const;

// --- エラーコード（内部識別子）
export const ErrorCode = {
    IfCondNotBoolean:   "IfCondNotBoolean",
    IfBranchesMismatch: "IfBranchesMismatch",
    RuntimeAddType:     "RuntimeAddType",
    RuntimeIfType:      "RuntimeIfType",
    Unreachable:        "Unreachable",
} as const;
export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

// --- エラーメッセージ（表示用）
export const Messages: Record<ErrorCode, string> = {
    [ErrorCode.IfCondNotBoolean]:   "if condition must be Boolean",
    [ErrorCode.IfBranchesMismatch]: "if branches must have the same type",
    [ErrorCode.RuntimeAddType]:     "runtime type error: add expects numbers",
    [ErrorCode.RuntimeIfType]:      "runtime type error: if expects boolean condition",
    [ErrorCode.Unreachable]:        "unreachable",
};

// ====== 2) AST / Type / Value / Result =================================

export type Term =
    | { tag: typeof TermTag.True }
    | { tag: typeof TermTag.False }
    | { tag: typeof TermTag.If;     cond: Term; thn: Term; els: Term }
    | { tag: typeof TermTag.Number; n: number }
    | { tag: typeof TermTag.Add;    left: Term; right: Term };

export type Type =
    | { tag: typeof TypeTag.Boolean }
    | { tag: typeof TypeTag.Number };

export type Value =
    | { tag: typeof ValueTag.Boolean; value: boolean }
    | { tag: typeof ValueTag.Number;  value: number };

export type Err<E> = { tag: typeof ResultTag.Err; error: ReadonlyArray<E> };
export type Ok<A>  = { tag: typeof ResultTag.Ok;  value: A };
export type Result<A, E> = Ok<A> | Err<E>;

export const ok  = <A,>(value: A): Result<A, never>   =>
    ({ tag: ResultTag.Ok, value } as const);
export const err =   <E,>(...es: E[]): Result<never, E> =>
    ({ tag: ResultTag.Err, error: es } as const);

export const isErr = <A, E>(r: Result<A, E>): r is Err<E> => r.tag === ResultTag.Err;
export const isOk  = <A, E>(r: Result<A, E>): r is Ok<A>  => r.tag === ResultTag.Ok;

// ====== 3) map2（ts-pattern版：エラー配列を結合）=======================

type Res<A, E> = Result<A, E>;
type Pair<A, B, E> = readonly [Res<A, E>, Res<B, E>];

export const map2 = <A, B, C, E>(
    ra: Res<A, E>,
    rb: Res<B, E>,
    f: (a: A, b: B) => C
): Res<C, E> =>
    match<Pair<A, B, E>>([ra, rb] as const)
        .with([P.when(isErr), P.when(isErr)],
            ([ea, eb]) => ({ tag: ResultTag.Err, error: [...ea.error, ...eb.error] as const }))
        .with([P.when(isErr), P.when(isOk)],  ([ea]) => ea)
        .with([P.when(isOk),  P.when(isErr)], ([, eb]) => eb)
        .with([P.when(isOk),  P.when(isOk)],
            ([a, b]) => ok(f(a.value, b.value)))
        .exhaustive();

// ====== 4) fold（catamorphism：再帰の形を一箇所に集約）=================

type TermAlg<A> = {
    True:   () => A;
    False:  () => A;
    Number: (n: number) => A;
    Add:    (l: A, r: A) => A;
    If:     (c: A, t: A, e: A) => A;
};

export function foldTerm<A>(alg: TermAlg<A>, t: Term): A {
    switch (t.tag) {
        case TermTag.True:   return alg.True();
        case TermTag.False:  return alg.False();
        case TermTag.Number: return alg.Number(t.n);
        case TermTag.Add: {
            const l = foldTerm(alg, t.left);
            const r = foldTerm(alg, t.right);
            return alg.Add(l, r);
        }
        case TermTag.If: {
            const c  = foldTerm(alg, t.cond);
            const th = foldTerm(alg, t.thn);
            const el = foldTerm(alg, t.els);
            return alg.If(c, th, el);
        }
    }
}

// ====== 5) 評価器（Value もタグ管理でJS値に依存しない）=================

const evalAlg: TermAlg<Value> = {
    True:   () => ({ tag: ValueTag.Boolean, value: true }),
    False:  () => ({ tag: ValueTag.Boolean, value: false }),
    Number: (n) => ({ tag: ValueTag.Number,  value: n }),
    Add:    (l, r) => {
        if (l.tag !== ValueTag.Number || r.tag !== ValueTag.Number)
            throw new Error(Messages[ErrorCode.RuntimeAddType]);
        return { tag: ValueTag.Number, value: l.value + r.value } as const;
    },
    If: (c, t, e) => {
        if (c.tag !== ValueTag.Boolean)
            throw new Error(Messages[ErrorCode.RuntimeIfType]);
        return c.value ? t : e;
    },
};

export const evaluate = (t: Term): Value => foldTerm(evalAlg, t);

// ====== 6) プリティプリンタ（語句/記号はKW/SYMから）====================

const printAlg: TermAlg<string> = {
    True:   () => KW.true,
    False:  () => KW.false,
    Number: (n) => String(n),
    Add:    (l, r) => `${SYM.lpar}${l} ${SYM.plus} ${r}${SYM.rpar}`,
    If:     (c, t, e) => `${KW.if} ${c} ${KW.then} ${t} ${KW.else} ${e}`,
};

export const pretty = (t: Term): string => foldTerm(printAlg, t);

// ====== 7) 型検査器（Result<Type, ErrorCode>：文言は最後に変換）========

const sameType = (a: Type, b: Type) => a.tag === b.tag;
const errsOf = <A>(r: Result<A, ErrorCode>) =>
    r.tag === ResultTag.Err ? r.error : ([] as ErrorCode[]);

const typecheckAlg: TermAlg<Result<Type, ErrorCode>> = {
    True:   () => ok({ tag: TypeTag.Boolean }),
    False:  () => ok({ tag: TypeTag.Boolean }),
    Number: () => ok({ tag: TypeTag.Number }),

    Add: (lt, rt) =>
        map2(lt, rt, (l, r) => {
            if (l.tag !== TypeTag.Number || r.tag !== TypeTag.Number)
                throw new Error(Messages[ErrorCode.Unreachable]); // Ok/Okのみのはず
            return { tag: TypeTag.Number } as Type;
        }),

    If: (rc, rt, re) => {
        const all = [
            ...errsOf(rc), ...errsOf(rt), ...errsOf(re),
            ...(rc.tag === ResultTag.Ok && rc.value.tag !== TypeTag.Boolean ? [ErrorCode.IfCondNotBoolean] : []),
            ...(rt.tag === ResultTag.Ok && re.tag === ResultTag.Ok && !sameType(rt.value, re.value) ? [ErrorCode.IfBranchesMismatch] : []),
        ];
        return all.length ? err(...all) : ok(rt.value);
    },
};

export const typecheck = (t: Term): Result<Type, ErrorCode> =>
    foldTerm(typecheckAlg, t);

// 表示用にエラーコードをメッセージへ
export const formatErrors = (errs: ReadonlyArray<ErrorCode>) =>
    errs.map((e) => Messages[e]);

// ====== 8) 動作テスト ====================================================

const t1 = parseArith("1 + 2") as Term;
console.log("pretty:", pretty(t1));                    // => "(1 + 2)"
console.log("eval:  ", evaluate(t1));                  // => { tag:"NumValue", value:3 }
console.log("type:  ", typecheck(t1));                 // => Ok { tag: "Number" }

// const t2 = parseArith("true + 2") as Term;
// const ty2 = typecheck(t2);
// console.log("type2: ", ty2.tag === ResultTag.Err ? formatErrors(ty2.error) : ty2);
