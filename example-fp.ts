// ====== imports ======
import { match, P } from "ts-pattern";           // Deno: "npm:ts-pattern"
import { parseArith } from "./book/tiny-ts-parser.ts";

// ====== 1) 定数群（タグ/キーワード/演算子/メッセージ）================

// --- ASTタグ
export const TermTag = {
    True:   "true",
    False:  "false",
    If:     "if",
    Number: "number",
    Add:    "add",
} as const;

// --- 型タグ
export const TypeTag = {
    Boolean: "Boolean",
    Number:  "Number",
} as const;

// --- Resultタグ
export const ResultTag = {
    Ok:  "Ok",
    Err: "Err",
} as const;

// --- プリティプリントで使う語句・記号
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

// --- エラーコード（アプリ内で使う識別子）
export const ErrorCode = {
    IfCondNotBoolean:     "IfCondNotBoolean",
    IfBranchesMismatch:   "IfBranchesMismatch",
    RuntimeAddType:       "RuntimeAddType",
    RuntimeIfType:        "RuntimeIfType",
    Unreachable:          "Unreachable",
} as const;
export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

// --- エラーメッセージ（表示用：i18n差し替え可）
export const Messages: Record<ErrorCode, string> = {
    [ErrorCode.IfCondNotBoolean]:   "if condition must be Boolean",
    [ErrorCode.IfBranchesMismatch]: "if branches must have the same type",
    [ErrorCode.RuntimeAddType]:     "runtime type error: add expects numbers",
    [ErrorCode.RuntimeIfType]:      "runtime type error: if expects boolean condition",
    [ErrorCode.Unreachable]:        "unreachable",
};

// ====== 2) AST / 型 / Result ===========================================

export type Term =
    | { tag: typeof TermTag.True }
    | { tag: typeof TermTag.False }
    | { tag: typeof TermTag.If;     cond: Term; thn: Term; els: Term }
    | { tag: typeof TermTag.Number; n: number }
    | { tag: typeof TermTag.Add;    left: Term; right: Term };

export type Type =
    | { tag: typeof TypeTag.Boolean }
    | { tag: typeof TypeTag.Number };

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

// ====== 5) 評価器（Value文字列も定数利用）==============================

type Value = number | boolean;

const evalAlg: TermAlg<Value> = {
    True:   () => true,
    False:  () => false,
    Number: (n) => n,
    Add:    (l, r) => {
        if (typeof l !== "number" || typeof r !== "number")
            throw new Error(Messages[ErrorCode.RuntimeAddType]);
        return l + r;
    },
    If: (c, t, e) => {
        if (typeof c !== "boolean")
            throw new Error(Messages[ErrorCode.RuntimeIfType]);
        return c ? t : e;
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
        const errors: ErrorCode[] = [];

        if (rc.tag === ResultTag.Ok && rc.value.tag !== TypeTag.Boolean)
            errors.push(ErrorCode.IfCondNotBoolean);

        if (rt.tag === ResultTag.Ok && re.tag === ResultTag.Ok && !sameType(rt.value, re.value))
            errors.push(ErrorCode.IfBranchesMismatch);

        if (rc.tag === ResultTag.Err) errors.push(...rc.error);
        if (rt.tag === ResultTag.Err) errors.push(...rt.error);
        if (re.tag === ResultTag.Err) errors.push(...re.error);

        if (errors.length) return err(...errors);
        return ok(
            rt.tag === ResultTag.Ok ? rt.value :
                re.tag === ResultTag.Ok ? re.value :
                    { tag: TypeTag.Boolean } // 到達しないダミー
        );
    },
};

export const typecheck = (t: Term): Result<Type, ErrorCode> =>
    foldTerm(typecheckAlg, t);

// （必要なら）エラーを表示用文字列に変換
export const formatErrors = (errs: ReadonlyArray<ErrorCode>) =>
    errs.map((e) => Messages[e]);

// ====== 8) 動作テスト ====================================================

const t1 = parseArith("1 + 2") as Term;
console.log("pretty:", pretty(t1));        // => "(1 + 2)"
console.log("eval:  ", evaluate(t1));      // => 3
const ty1 = typecheck(t1);
console.log("type:  ", ty1);

const t2 = parseArith("true + 2") as Term;
const ty2 = typecheck(t2);
console.log("type2: ",
    ty2.tag === ResultTag.Err ? formatErrors(ty2.error) : ty2);
