// -----------------------------------------------------------------------------
// Effect-TS を用いた型検査器の実装 (★flatMap版・構築時クラッシュ実証★)
// -----------------------------------------------------------------------------
//
// ■ このファイルの目的
//
// このファイルは、`Effect.gen` が暗黙的に提供していた
// 「構築時の遅延実行（Lazy）」を取り除いたバージョンです。
//
// `typecheckRecursive` 関数は `Effect.gen` を使わず、
// `Effect.flatMap` や `Effect.map` を直接使って実装されています。
//
// ■ なぜクラッシュするのか？ (★今度こそ、構築時のクラッシュ★)
//
// `Effect.gen(function* () { ... })` は、`function*` の中身を
// 「実行時」まで評価しませんでした（＝Lazyだった）。
//
// しかし、`Effect.flatMap` は、その引数を先行評価（Eager）します。
//
// `case TermTag.Add` の実装を見ると：
//
//   const l = typecheckRecursive(t.left);  // ★ Eager Call
//   const r = typecheckRecursive(t.right); // ★ Eager Call
//   return l.flatMap((lt) => r.flatMap(...));
//
// `l.flatMap` を呼び出す *前* に、JavaScript の先行評価により
// `typecheckRecursive(t.left)` が *即座に*（構築時に）呼び出されます。
//
// これにより、`Effect` の「設計図」を構築する段階で
// JavaScript のコールスタックが消費され、
// 「Maximum call stack size exceeded (スタックオーバーフロー)」
// でクラッシュします。
//
// これは、`Effect.suspend` の TSDoc にあったフィボナッチ数列の
// `blowsUp`（クラッシュする）例と、全く同じ原因です。
//
// ■ 結論
//
// このファイルは、`Effect.gen` が（暗黙的に）
// `Effect.suspend` と同じ「構築時のスタックオーバーフロー防止」
// の役割を果たしていたことを証明するための、
// 最後の「実証コード」です。
//
// -----------------------------------------------------------------------------

// ====== imports ======
// ★ parseBasic は `shallowTerm` のテストにしか使わない
import {error as parseError, parseBasic} from "npm:tiny-ts-parser";
import {Context, Data, Effect, Exit, pipe} from "npm:effect";

// ====== 1-4.5) AST / Type / Env / Error (変更なし) ======================
// (typecheck_effect_final.ts と同一のため、コメントは省略)

export const TermTag = {
    True: "true", False: "false", If: "if", Number: "number",
    Add: "add", Var: "var", Func: "func", Call: "call",
    Seq: "seq", Const: "const",
} as const;
export const TypeTag = {Boolean: "Boolean", Number: "Number", Func: "Func",} as const;
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
    | { tag: typeof TermTag.True; loc: Location } | { tag: typeof TermTag.False; loc: Location }
    | { tag: typeof TermTag.Number; n: number; loc: Location } | {
    tag: typeof TermTag.Add;
    left: Term;
    right: Term;
    loc: Location
}
    | { tag: typeof TermTag.If; cond: Term; thn: Term; els: Term; loc: Location } | {
    tag: typeof TermTag.Var;
    name: string;
    loc: Location
}
    | { tag: typeof TermTag.Func; params: Param[]; body: Term; loc: Location } | {
    tag: typeof TermTag.Call;
    func: Term;
    args: Term[];
    loc: Location
}
    | { tag: typeof TermTag.Seq; body: Term; rest: Term; loc: Location } | {
    tag: typeof TermTag.Const;
    name: string;
    init: Term;
    rest: Term;
    loc: Location
};
export type Type =
    | { tag: typeof TypeTag.Boolean } | { tag: typeof TypeTag.Number }
    | { tag: typeof TypeTag.Func; params: Param[]; retType: Type };
export type TypeEnv = Readonly<Record<string, Type>>;
export const TypeEnvTag = Context.GenericTag<TypeEnv>("@app/TypeEnv");
export const emptyEnv: TypeEnv = Object.freeze({});
const extendEnv = (
    env: TypeEnv,
    entries: ReadonlyArray<readonly [string, Type]>,
): TypeEnv => Object.freeze({...env, ...Object.fromEntries(entries),});

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
    } catch { /* */
    }
    const s = loc.start, e = loc.end;
    throw new Error(`test.ts:${s.line}:${s.column + 1}-${e.line}:${e.column + 1} ${msg}`);
}

// ====== 5-6) "通常再帰" + `flatMap` による型検査（★構築時クラッシュ版★） =================

type AlgEffect<A> = Effect.Effect<A, TypeError, TypeEnv>;

// Effect.try を Effect に変換するヘルパー
const errorEffect = (msg: string, loc: Location): AlgEffect<never> =>
    Effect.try({
        try: () => errorAt(msg, loc),
        catch: () => new TypeError({message: msg, loc: loc}),
    });

/**
 * `Effect.gen` を使わず、`Effect.flatMap` を直接使う「通常再帰」関数。
 * `Effect.suspend` を使っていないため、*構築時* にスタックオーバーフローを起こす。
 */
function typecheckRecursive(t: Term): AlgEffect<Type> {
    switch (t.tag) {
        // --- 葉 (Leaf) ノード (ベースケース) ---
        case TermTag.True:
            return Effect.succeed({tag: TypeTag.Boolean});
        case TermTag.False:
            return Effect.succeed({tag: TypeTag.Boolean});
        case TermTag.Number:
            return Effect.succeed({tag: TypeTag.Number});
        case TermTag.Var:
            // `flatMap` や `map` を使って `gen` と同じロジックを構築
            // ★★★ 修正 ★★★
            // `Effect.context<TypeEnv>()` ではなく `TypeEnvTag` を直接使う
            return pipe(
                TypeEnvTag, // yield* TypeEnvTag
                // ★★★★★★★★★★
                Effect.flatMap((env) => {
                    const ty = env[t.name];
                    if (!ty) {
                        const msg = `${Messages.UnknownVariable}: ${t.name}`;
                        return errorEffect(msg, t.loc); // yield* Effect.try...
                    }
                    return Effect.succeed(ty); // return ty
                })
            );

        // --- 枝 (Branch) ノード (再帰ケース) ---

        case TermTag.Add: {
            // ★★★ クラッシュの原因 ★★★
            // `l.flatMap` が呼ばれる *前* に、JavaScript の
            // 先行評価が `typecheckRecursive` を即座に再帰呼び出しする
            const l = typecheckRecursive(t.left);
            const r = typecheckRecursive(t.right);
            // ★★★★★★★★★★★★★★★★★

            return pipe(
                l, // yield* l
                Effect.flatMap((lt) => pipe(
                    r, // yield* r
                    Effect.flatMap((rt) => {
                        if (lt.tag !== TypeTag.Number || rt.tag !== TypeTag.Number) {
                            const msg = Messages.RuntimeAddType;
                            return errorEffect(msg, t.loc); // yield* Effect.try...
                        }
                        return Effect.succeed({tag: TypeTag.Number}); // return ...
                    })
                ))
            );
        }

        case TermTag.If: {
            // ★★★ クラッシュの原因 ★★★
            const c = typecheckRecursive(t.cond);
            const thn = typecheckRecursive(t.thn);
            const els = typecheckRecursive(t.els);
            // ★★★★★★★★★★★★★★★★★

            return pipe(
                c, // yield* c
                Effect.flatMap((ct) => {
                    if (ct.tag !== TypeTag.Boolean) {
                        const msg = Messages.IfCondNotBoolean;
                        return errorEffect(msg, t.loc);
                    }
                    return pipe(
                        thn, // yield* thn
                        Effect.flatMap((tt) => pipe(
                            els, // yield* els
                            Effect.flatMap((ee) => {
                                if (!typeEq(tt, ee)) {
                                    const msg = Messages.IfBranchesMismatch;
                                    return errorEffect(msg, t.loc);
                                }
                                return Effect.succeed(tt); // return tt
                            })
                        ))
                    );
                })
            );
        }

        case TermTag.Func: {
            // ★★★ クラッシュの原因 ★★★
            const bodyEffect = typecheckRecursive(t.body);
            // ★★★★★★★★★★★★★★★★★

            // mapInputContext は flatMap のチェーンの外側で適用できる
            const retEffect = pipe(
                bodyEffect,
                Effect.mapInputContext(
                    (context: Context.Context<TypeEnv>) => {
                        const env = Context.get(context, TypeEnvTag);
                        const newEnv = extendEnv(
                            env,
                            t.params.map((p) => [p.name, p.type] as const),
                        );
                        return Context.add(context, TypeEnvTag, newEnv);
                    },
                ),
            );

            // Effect.map は Effect.flatMap(v => Effect.succeed(f(v))) と同じ
            return pipe(
                retEffect, // yield* retEffect (gen の中で)
                Effect.map((retTy) => ({ // return ...
                    tag: TypeTag.Func,
                    params: t.params,
                    retType: retTy,
                }))
            );
        }

        case TermTag.Call: {
            // ★★★ クラッシュの原因 ★★★
            const f = typecheckRecursive(t.func);
            // .map のコールバックも先行評価される
            const args = t.args.map((a) => typecheckRecursive(a));
            // ★★★★★★★★★★★★★★★★★

            return pipe(
                f, // yield* f
                Effect.flatMap((fty) => {
                    if (fty.tag !== TypeTag.Func) {
                        const msg = Messages.FuncExpected;
                        return errorEffect(msg, t.loc);
                    }

                    return pipe(
                        Effect.all(args), // yield* Effect.all(args)
                        Effect.flatMap((argTys) => {
                            if (fty.params.length !== argTys.length) {
                                const msg = Messages.ArgCountMismatch;
                                return errorEffect(msg, t.loc);
                            }

                            // Effect の配列を作成
                            const checks: AlgEffect<Type>[] = [];
                            for (let i = 0; i < argTys.length; i++) {
                                if (!typeEq(fty.params[i].type, argTys[i])) {
                                    const msg = Messages.ArgTypeMismatch;
                                    // エラー Effect を配列に追加
                                    checks.push(errorEffect(msg, t.args[i].loc));
                                }
                            }

                            // エラーチェック Effect があれば、それを実行
                            if (checks.length > 0) {
                                // 複数のエラーがありうるが、最初のエラーで失敗する
                                return checks[0];
                            }

                            // エラーがなければ、関数の戻り値を返す
                            return Effect.succeed(fty.retType); // return fty.retType
                        })
                    );
                })
            );
        }

        case TermTag.Seq: {
            // ★★★ クラッシュの原因 ★★★
            const body = typecheckRecursive(t.body);
            const rest = typecheckRecursive(t.rest);
            // ★★★★★★★★★★★★★★★★★

            return pipe(
                body, // yield* body
                Effect.flatMap(() => rest) // return yield* rest
            );
        }

        case TermTag.Const: {
            // ★★★ クラッシュの原因 ★★★
            const init = typecheckRecursive(t.init);
            const rest = typecheckRecursive(t.rest);
            // ★★★★★★★★★★★★★★★★★

            return pipe(
                init, // yield* init
                Effect.flatMap((initTy) => pipe(
                    // ★★★ 修正 ★★★
                    // `Effect.context<TypeEnv>()` ではなく `TypeEnvTag` を直接使う
                    TypeEnvTag, // yield* TypeEnvTag
                    // ★★★★★★★★★★
                    Effect.flatMap((currentEnv) => {
                        const newEnv = extendEnv(currentEnv, [[t.name, initTy]]);
                        // provideService は flatMap のチェーンの外側で適用できる
                        return Effect.provideService(rest, TypeEnvTag, newEnv);
                    })
                ))
            );
        }
    }
}


// ====== 7) 公開 API（★ `async` / `await` と `runPromiseExit` を使用 ★） =========
/**
 * 型検査器のエントリポイント。(非同期版)
 * @param t 型検査対象のAST
 * @param env 初期型環境 (グローバル変数など)。デフォルトは空。
 * @returns 型検査の結果 (Type) の Promise
 * @throws (Effect.try が catch した) 標準 Error
 */
export async function typecheck(t: any, env: TypeEnv = emptyEnv): Promise<Type> {
    // 1. `typecheckRecursive` を呼ぶ
    // (この時点でスタックオーバーフローするはず)
    const computation = typecheckRecursive(t);

    // 2. 依存注入 (DI)
    const runnable = Effect.provideService(computation, TypeEnvTag, env);

    // 3. ★ 非同期かつスタックセーフなランタイムで実行 ★
    // (ただし、`computation` の構築が先行評価で
    //  クラッシュするため、ここには到達しないはず)
    const result = await Effect.runPromiseExit(runnable);

    if (Exit.isSuccess(result)) {
        return result.value;
    } else {
        // (runPromiseExit は Effect の E チャネルのエラーを
        //  throw せず、Failure で返す)
        if (result.cause._tag === "Fail") {
            const err = result.cause.error;
            errorAt(err.message, err.loc);
        }
        if (result.cause._tag === "Die") {
            throw result.cause.defect;
        }
        throw new Error(`Typechecking failed (Unknown Cause): ${JSON.stringify(result.cause)}`);
    }
}

// ====== 8) 動作テスト（★ `parseBasic` を使わずにASTを手動構築 ★） =======================
// (即時実行非同期関数 (IIFE) でトップレベル await を有効にする)
(async () => {
    // ダミーの位置情報 (loc)
    const loc: Location = {start: {line: 1, column: 1}, end: {line: 1, column: 1}};

    try {
        // 1. 浅いAST (これは成功するはず)
        console.log("--- 浅いASTのテスト (これは成功するはず) ---");
        const shallowTerm = parseBasic("const x = 1; x + 2") as unknown as Term;
        // ★ await で呼び出し
        console.log(`const x = 1; x + 2 :: ${(await typecheck(shallowTerm, {})).tag}`);

        // 2. 非常に深いAST (★flatMap + 先行評価で、構築時にクラッシュするはず★)
        console.log("\n--- 深いASTのテスト (flatMap + 先行評価で、構築時にクラッシュするはず) ---");

        // ★★★ `parseBasic` のクラッシュを回避するため、AST を手動で構築 ★★★
        const depth = 20000;
        console.log(`深さ ${depth} のASTを（ループで）構築中...`);

        let deepTerm: Term = {tag: TermTag.Number, n: 1, loc};
        const num1: Term = {tag: TermTag.Number, n: 1, loc};

        for (let i = 0; i < depth; i++) {
            // deepTerm = 1 + (deepTerm)
            deepTerm = {tag: TermTag.Add, left: num1, right: deepTerm, loc};
        }
        // ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★

        console.log("型検査を実行... (クラッシュ待ち)");
        // ★ await で呼び出し
        // この `typecheck` が `typecheckRecursive` を呼び出し、
        // `Effect` の「設計図の構築」段階で
        // 先行評価によるスタックオーバーフローが発生するはず。
        const resultType = await typecheck(deepTerm, {});

        // もしクラッシュしなかった場合（こちらには来ないはず）
        console.log("\n--- ★テスト失敗 (クラッシュしなかった)★ ---");
        console.log(`深さ ${depth} のASTの型検査に（予期せず）成功しました。`);
        console.log(`最終的な型: ${resultType.tag}`);
        console.error("JavaScript のランタイムが末尾再帰最適化(TCO)を行ったか、スタックが非常に深い環境です。");

    } catch (e: any) {
        // 期待されるクラッシュ
        console.error("\n--- ★クラッシュを検知 (テスト成功！)★ ---");
        console.error(`エラー: ${e.message}`);
        if (e.message.includes("Maximum call stack size exceeded")) {
            console.error("期待通り、スタックオーバーフローが発生しました。");
            console.error("`Effect.gen` の『暗黙の遅延実行』がないため、`Effect.suspend` が構築時に必要でした。");
        } else {
            console.error("予期せぬエラーでクラッシュしました。", e);
        }
    }
})();