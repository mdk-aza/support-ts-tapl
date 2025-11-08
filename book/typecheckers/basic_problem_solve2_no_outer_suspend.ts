// -----------------------------------------------------------------------------
// Effect-TS を用いた型検査器の実装 (★flatMap版・外側 suspend なし・スタックセーフ★)
// -----------------------------------------------------------------------------

import {error as parseError, parseBasic} from "npm:tiny-ts-parser";
import {Context, Data, Effect, Exit, pipe} from "npm:effect";

// ====== AST / Type / Env / Error ======

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

export const TypeTag = {Boolean: "Boolean", Number: "Number", Func: "Func"} as const;

export const Messages = {
    IfCondNotBoolean: "boolean expected",
    IfBranchesMismatch: "then and else have different types",
    RuntimeAddType: "number expected",
    UnknownVariable: "unknown variable",
    NotImplemented: "not implemented yet",
    FuncExpected: "function expected",
    ArgCountMismatch: "number of arguments mismatch",
    ArgTypeMismatch: "parameter type mismatch",
} as const;

export type Position = { line: number; column: number };
export type Location = { start: Position; end: Position };
export type Param = { name: string; type: Type };

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
export const TypeEnvTag = Context.GenericTag<TypeEnv>("@app/TypeEnv");
export const emptyEnv: TypeEnv = Object.freeze({});

const extendEnv = (
    env: TypeEnv,
    entries: ReadonlyArray<readonly [string, Type]>,
): TypeEnv => Object.freeze({...env, ...Object.fromEntries(entries)});

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
                if (!typeEq(a.params[i].type, bb.params[i].type)) return false;
            }
            return typeEq(a.retType, bb.retType);
        }
    }
}

export class TypeError extends Data.TaggedError("TypeError")<{
    readonly message: string;
    readonly loc: Location;
}> {
}

function errorAt(msg: string, loc: Location): never {
    try {
        parseError(msg, {loc} as any);
    } catch {
    }
    const s = loc.start,
        e = loc.end;
    throw new Error(`test.ts:${s.line}:${s.column + 1}-${e.line}:${e.column + 1} ${msg}`);
}

type AlgEffect<A> = Effect.Effect<A, TypeError, TypeEnv>;

const errorEffect = (msg: string, loc: Location): AlgEffect<never> =>
    Effect.try({
        try: () => errorAt(msg, loc),
        catch: () => new TypeError({message: msg, loc}),
    });

// ====== 通常再帰 + flatMap（外側 suspend なし） ======

function typecheckRecursive(t: Term): AlgEffect<Type> {
    // 構築時は再帰しない：ここではまだ switch しか作らない
    // 実行時に入る最初の境界として yieldNow を挿入
    return pipe(
        Effect.yieldNow(),
        Effect.flatMap(() => {
            switch (t.tag) {
                // --- 葉 ---
                case TermTag.True:
                    return Effect.succeed({tag: TypeTag.Boolean});
                case TermTag.False:
                    return Effect.succeed({tag: TypeTag.Boolean});
                case TermTag.Number:
                    return Effect.succeed({tag: TypeTag.Number});
                case TermTag.Var:
                    return pipe(
                        TypeEnvTag,
                        Effect.flatMap((env) => {
                            const ty = env[t.name];
                            if (!ty) return errorEffect(`${Messages.UnknownVariable}: ${t.name}`, t.loc);
                            return Effect.succeed(ty);
                        }),
                    );

                // --- 枝 ---
                case TermTag.Add: {
                    // 内側は必ず suspend で遅延
                    const l = Effect.suspend(() => typecheckRecursive(t.left));
                    const r = Effect.suspend(() => typecheckRecursive(t.right));
                    return pipe(
                        l,
                        Effect.flatMap((lt) =>
                            pipe(
                                r,
                                Effect.flatMap((rt) => {
                                    if (lt.tag !== TypeTag.Number || rt.tag !== TypeTag.Number) {
                                        return errorEffect(Messages.RuntimeAddType, t.loc);
                                    }
                                    return Effect.succeed({tag: TypeTag.Number});
                                }),
                            ),
                        ),
                    );
                }

                case TermTag.If: {
                    const c = Effect.suspend(() => typecheckRecursive(t.cond));
                    const thn = Effect.suspend(() => typecheckRecursive(t.thn));
                    const els = Effect.suspend(() => typecheckRecursive(t.els));
                    return pipe(
                        c,
                        Effect.flatMap((ct) => {
                            if (ct.tag !== TypeTag.Boolean) {
                                return errorEffect(Messages.IfCondNotBoolean, t.loc);
                            }
                            return pipe(
                                thn,
                                Effect.flatMap((tt) =>
                                    pipe(
                                        els,
                                        Effect.flatMap((ee) => {
                                            if (!typeEq(tt, ee)) {
                                                return errorEffect(Messages.IfBranchesMismatch, t.loc);
                                            }
                                            return Effect.succeed(tt);
                                        }),
                                    ),
                                ),
                            );
                        }),
                    );
                }

                case TermTag.Func: {
                    const bodyEffect = Effect.suspend(() => typecheckRecursive(t.body));
                    const retEffect = pipe(
                        bodyEffect,
                        Effect.mapInputContext((context: Context.Context<TypeEnv>) => {
                            const env = Context.get(context, TypeEnvTag);
                            const newEnv = extendEnv(
                                env,
                                t.params.map((p) => [p.name, p.type] as const),
                            );
                            return Context.add(context, TypeEnvTag, newEnv);
                        }),
                    );
                    return pipe(
                        retEffect,
                        Effect.map((retTy) => ({
                            tag: TypeTag.Func,
                            params: t.params,
                            retType: retTy,
                        })),
                    );
                }

                case TermTag.Call: {
                    const f = Effect.suspend(() => typecheckRecursive(t.func));
                    const args = t.args.map((a) => Effect.suspend(() => typecheckRecursive(a)));
                    return pipe(
                        f,
                        Effect.flatMap((fty) => {
                            if (fty.tag !== TypeTag.Func) {
                                return errorEffect(Messages.FuncExpected, t.loc);
                            }
                            return pipe(
                                Effect.all(args),
                                Effect.flatMap((argTys) => {
                                    if (fty.params.length !== argTys.length) {
                                        return errorEffect(Messages.ArgCountMismatch, t.loc);
                                    }
                                    for (let i = 0; i < argTys.length; i++) {
                                        if (!typeEq(fty.params[i].type, argTys[i])) {
                                            return errorEffect(Messages.ArgTypeMismatch, t.args[i].loc);
                                        }
                                    }
                                    return Effect.succeed(fty.retType);
                                }),
                            );
                        }),
                    );
                }

                case TermTag.Seq: {
                    const body = Effect.suspend(() => typecheckRecursive(t.body));
                    const rest = Effect.suspend(() => typecheckRecursive(t.rest));
                    return pipe(body, Effect.flatMap(() => rest));
                }

                case TermTag.Const: {
                    const init = Effect.suspend(() => typecheckRecursive(t.init));
                    const rest = Effect.suspend(() => typecheckRecursive(t.rest));
                    return pipe(
                        init,
                        Effect.flatMap((initTy) =>
                            pipe(
                                TypeEnvTag,
                                Effect.flatMap((currentEnv) => {
                                    const newEnv = extendEnv(currentEnv, [[t.name, initTy]]);
                                    return Effect.provideService(rest, TypeEnvTag, newEnv);
                                }),
                            ),
                        ),
                    );
                }
            }
        }),
    );
}

// ====== 公開 API（async / await + runPromiseExit） ======

export async function typecheck(t: any, env: TypeEnv = emptyEnv): Promise<Type> {
    const computation = typecheckRecursive(t);
    const runnable = Effect.provideService(computation, TypeEnvTag, env);
    const result = await Effect.runPromiseExit(runnable);

    if (Exit.isSuccess(result)) {
        return result.value;
    } else {
        if ((result.cause as any)._tag === "Fail") {
            const err = (result.cause as any).error;
            errorAt(err.message, err.loc);
        }
        if ((result.cause as any)._tag === "Die") {
            throw (result.cause as any).defect;
        }
        throw new Error(`Typechecking failed (Unknown Cause): ${JSON.stringify(result.cause)}`);
    }
}

// ====== 動作テスト（深いASTは手動構築） ======

(async () => {
    const loc: Location = {start: {line: 1, column: 1}, end: {line: 1, column: 1}};

    try {
        console.log("--- 浅いASTのテスト (これは成功するはず) ---");
        const shallowTerm = parseBasic("const x = 1; x + 2") as unknown as Term;
        console.log(`const x = 1; x + 2 :: ${(await typecheck(shallowTerm, {})).tag}`);

        console.log("\n--- 深いASTのテスト (yieldNow + 内側 suspend + runPromiseExit) ---");
        const depth = 20000;
        console.log(`深さ ${depth} のASTを（ループで）構築中...`);

        let deepTerm: Term = {tag: TermTag.Number, n: 1, loc};
        const num1: Term = {tag: TermTag.Number, n: 1, loc};
        for (let i = 0; i < depth; i++) {
            deepTerm = {tag: TermTag.Add, left: num1, right: deepTerm, loc};
        }

        console.log("型検査を実行...");
        const resultType = await typecheck(deepTerm, {});

        console.log("\n--- ★テスト成功！★ ---");
        console.log(`深さ ${depth} のASTの型検査に成功しました。`);
        console.log(`最終的な型: ${resultType.tag}`);
        console.error("`Effect.yieldNow`、内側の `Effect.suspend`、`Effect.runPromiseExit` がスタックオーバーフローを防ぎました。");
    } catch (e: any) {
        console.error("\n--- ★テスト失敗 (クラッシュしてしまった)★ ---");
        console.error(`エラー: ${e.message}`);
        if (e.message.includes("Maximum call stack size exceeded")) {
            console.error("`yieldNow` の位置または内側の `suspend` が不足しています。");
        } else {
            console.error("予期せぬエラーでクラッシュしました。", e);
        }
    }
})();
