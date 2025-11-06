// deno: import { match, P } from "npm:ts-pattern";
import { match, P } from "ts-pattern";
import { parse, parseArith } from "./book/tiny-ts-parser.ts";

// ─── Tag の集中管理 ────────────────────────────────────────────
export const TermTag = {
    True:   "true",
    False:  "false",
    If:     "if",
    Number: "number",
    Add:    "add",
} as const;

export const TypeTag = {
    Boolean: "Boolean",
    Number:  "Number",
} as const;

export const ResultTag = {
    Ok:  "Ok",
    Err: "Err",
} as const;

// ─── Term / Type 定義 ────────────────────────────────────────────
export type Term =
    | { tag: typeof TermTag.True }
    | { tag: typeof TermTag.False }
    | { tag: typeof TermTag.If; cond: Term; thn: Term; els: Term }
    | { tag: typeof TermTag.Number; n: number }
    | { tag: typeof TermTag.Add; left: Term; right: Term };

export type Type =
    | { tag: typeof TypeTag.Boolean }
    | { tag: typeof TypeTag.Number };

// ─── Result 型（エラー蓄積）─────────────────────────────────────────────
export type Err<E> = { tag: typeof ResultTag.Err; error: ReadonlyArray<E> };
export type Ok<A>  = { tag: typeof ResultTag.Ok;  value: A };
export type Result<A, E> = Ok<A> | Err<E>;

// ─── コンストラクタ & 型ガード ───────────────────────────────────────
export const ok  = <A,>(value: A): Result<A, never>   =>
    ({ tag: ResultTag.Ok, value } as const);

export const err = <E,>(...es: E[]): Result<never, E> =>
    ({ tag: ResultTag.Err, error: es } as const);

export const isErr = <A, E>(r: Result<A, E>): r is Err<E> =>
    r.tag === ResultTag.Err;

export const isOk = <A, E>(r: Result<A, E>): r is Ok<A> =>
    r.tag === ResultTag.Ok;

// ─── map2（ts-pattern版）───────────────────────────────────────────────
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

// ─── その他ユーティリティ ─────────────────────────────────────────────
const sameType = (a: Type, b: Type) => a.tag === b.tag;

// ─── 型検査器本体 ────────────────────────────────────────────────────
export function typecheck(t: Term): Result<Type, string> {
    switch (t.tag) {
        case TermTag.True:
            return ok({ tag: TypeTag.Boolean });
        case TermTag.False:
            return ok({ tag: TypeTag.Boolean });
        case TermTag.Number:
            return ok({ tag: TypeTag.Number });

        case TermTag.Add: {
            return map2(typecheck(t.left), typecheck(t.right), (lt, rt) => {
                if (lt.tag !== TypeTag.Number || rt.tag !== TypeTag.Number) {
                    throw new Error("unreachable");
                }
                return { tag: TypeTag.Number } as Type;
            });
        }

        case TermTag.If: {
            const rc = typecheck(t.cond);
            const rt = typecheck(t.thn);
            const re = typecheck(t.els);

            const errors: string[] = [];

            if (rc.tag === ResultTag.Ok && rc.value.tag !== TypeTag.Boolean) {
                errors.push("if condition must be Boolean");
            }
            if (rt.tag === ResultTag.Ok && re.tag === ResultTag.Ok && !sameType(rt.value, re.value)) {
                errors.push("if branches must have the same type");
            }
            if (rc.tag === ResultTag.Err) errors.push(...rc.error);
            if (rt.tag === ResultTag.Err) errors.push(...rt.error);
            if (re.tag === ResultTag.Err) errors.push(...re.error);

            if (errors.length) return err(...errors);

            return ok(
                rt.tag === ResultTag.Ok ? rt.value :
                    re.tag === ResultTag.Ok ? re.value :
                        { tag: TypeTag.Boolean }
            );
        }
    }
}

// ─── テスト出力 ──────────────────────────────────────────────────────
console.log(map2(ok(1), ok(2), (a, b) => a + b));      // Ok 3
console.log(map2(err("A"), ok(2), (a, b) => a + b));   // Err ["A"]
console.log(map2(ok(1), err("B"), (a, b) => a + b));   // Err ["B"]
console.log(map2(err("A"), err("B"), (a, b) => a + b));// Err ["A","B"]

console.log(typecheck(parseArith("1 + 2")));            // Ok { tag: "Number" }
// console.log(typecheck(parseArith("true + 2")));      // Err [...]
