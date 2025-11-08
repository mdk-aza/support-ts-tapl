// ひとことで言えば、このコードは、型検査のロジック（algType）とASTの走査（foldTermR）を分離しています。
// さらに、内部的なエラー処理（TypeError）と環境の引き回し（TypeEnv）を
// Effect-TS を使って純粋な値として管理し、
// 公開API（typecheck）でそれを実行して、従来通りの例外(throw)と戻り値(return)に変換しています。

// ====== imports ======
import {error as parseError} from "npm:tiny-ts-parser";
// ★★★ pipe をインポート
import {Context, Data, Effect, Exit, pipe} from "npm:effect";

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

// 型環境 (Type Environment) を Effect-TS の「サービス」として扱えるように Tag を作成
export type TypeEnv = Readonly<Record<string, Type>>;
export const TypeEnvTag = Context.GenericTag<TypeEnv>("@app/TypeEnv");
export const emptyEnv: TypeEnv = Object.freeze({});

// 環境を不変に拡張するヘルパー
const extendEnv = (
    env: TypeEnv,
    entries: ReadonlyArray<readonly [string, Type]>,
): TypeEnv =>
    Object.freeze({
        ...env,
        ...Object.fromEntries(entries),
    });

// ====== 3) 型等価（変更なし）===========================
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

// ====== 4) Reader（削除） =================
// (Effect-TS が提供するため不要)

// ====== 4.5) 位置付きエラー（変更なし） ============
export class TypeError extends Data.TaggedError("TypeError")<{
    readonly message: string;
    readonly loc: Location;
}> {
}

function errorAt(msg: string, loc: Location): never {
    try {
        parseError(msg, {loc} as any);
    } catch {
        //
    }
    const s = loc.start, e = loc.end;
    throw new Error(`test.ts:${s.line}:${s.column + 1}-${e.line}:${e.column + 1} ${msg}`);
}

// ====== 5) 環境付き catamorphism（変更なし） ===========================
type AlgEffect<A> = Effect.Effect<A, TypeError, TypeEnv>;

type TermAlgR<A> = {
    True: (loc: Location) => AlgEffect<A>;
    False: (loc: Location) => AlgEffect<A>;
    Number: (n: number, loc: Location) => AlgEffect<A>;
    Add: (l: AlgEffect<A>, r: AlgEffect<A>, loc: Location) => AlgEffect<A>;
    If: (c: AlgEffect<A>, t: AlgEffect<A>, e: AlgEffect<A>, loc: Location) => AlgEffect<A>;
    Var: (name: string, loc: Location) => AlgEffect<A>;
    Func: (params: Param[], body: AlgEffect<A>, loc: Location) => AlgEffect<A>;
    Call: (f: AlgEffect<A>, args: ReadonlyArray<AlgEffect<A>>, argTerms: ReadonlyArray<Term>, loc: Location) => AlgEffect<A>;
    Seq: (body: AlgEffect<A>, rest: AlgEffect<A>, loc: Location) => AlgEffect<A>;
    Const: (name: string, init: AlgEffect<A>, rest: AlgEffect<A>, loc: Location) => AlgEffect<A>;

};

export function foldTermR<A>(alg: TermAlgR<A>, t: Term): AlgEffect<A> {
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
            return alg.Call(f, args, t.args, t.loc);

        case TermTag.Seq: {
            return alg.Seq(
                foldTermR(alg, t.body),
                foldTermR(alg, t.rest),
                t.loc,
            );
        }
        case TermTag.Const:
            return alg.Const(
                t.name,
                foldTermR(alg, t.init),  // ✅ t.body ではなく t.init
                foldTermR(alg, t.rest),
                t.loc,
            );
    }
}

// ====== 6) 型検査用の代数（Func の実装を修正） =========================

// ====== 6) 型検査用の代数（Effect.gen と suspend を使用） =========================

const algType: TermAlgR<Type> = {
    // Effect.succeed は pureR の代わり
    True: (_loc) => Effect.succeed({tag: TypeTag.Boolean}),
    False: (_loc) => Effect.succeed({tag: TypeTag.Boolean}),
    Number: (_n, _loc) => Effect.succeed({tag: TypeTag.Number}),

    // ★★★ 'Var' (変更なし) ★★★
    // (yield* TypeEnvTag は Context.Tag であり、mapInputContext された Effect ではないため)
    Var: (name, loc) =>
        Effect.gen(function* () {
            const env = yield* TypeEnvTag;
            const ty = env[name];
            if (!ty) {
                const msg = `${Messages.UnknownVariable}: ${name}`;
                return yield* Effect.try({
                    try: () => errorAt(msg, loc),
                    catch: () => new TypeError({message: msg, loc}),
                });
            }
            return ty;
        }),

    // ★★★ 'Add' (suspend を追加) ★★★
    Add: (l, r, loc) =>
        Effect.gen(function* () {
            // l と r は Func の結果である可能性があるため suspend でラップ
            const lt = yield* Effect.suspend(() => l);
            const rt = yield* Effect.suspend(() => r);
            if (lt.tag !== TypeTag.Number || rt.tag !== TypeTag.Number) {
                const msg = Messages.RuntimeAddType;
                return yield* Effect.try({
                    try: () => errorAt(msg, loc),
                    catch: () => new TypeError({message: msg, loc}),
                });
            }
            return {tag: TypeTag.Number};
        }),

    // ★★★ 'If' (suspend を追加) ★★★
    If: (c, t, e, loc) =>
        Effect.gen(function* () {
            // c, t, e は Func の結果である可能性があるため suspend でラップ
            const ct = yield* Effect.suspend(() => c);
            if (ct.tag !== TypeTag.Boolean) {
                const msg = Messages.IfCondNotBoolean;
                return yield* Effect.try({
                    try: () => errorAt(msg, loc),
                    catch: () => new TypeError({message: msg, loc}),
                });
            }
            const tt = yield* Effect.suspend(() => t);
            const ee = yield* Effect.suspend(() => e);
            if (!typeEq(tt, ee)) {
                const msg = Messages.IfBranchesMismatch;
                return yield* Effect.try({
                    try: () => errorAt(msg, loc),
                    catch: () => new TypeError({message: msg, loc}),
                });
            }
            return tt;
        }),

    // ★★★ 'Func' (mapInputContext を使った実装を維持) ★★★
    Func: (params, body, _loc) => {
        // 1. body (Effect) が要求する環境を、現在の環境から変換する
        const retEffect = pipe(
            body,
            Effect.mapInputContext(
                (context: Context.Context<TypeEnv>) => {
                    const env = Context.get(context, TypeEnvTag);
                    const newEnv = extendEnv(
                        env,
                        params.map((p) => [p.name, p.type] as const),
                    );
                    return Context.add(context, TypeEnvTag, newEnv);
                },
            ),
        );
        // 2. 戻り値の型 (retTy) を Func 型にマッピングする
        return pipe(
            retEffect,
            Effect.map((retTy) => ({ // <- これが mapR 操作
                tag: TypeTag.Func,
                params,
                retType: retTy,
            }))
        );
    },

    // ★★★ 'Call' (suspend を追加) ★★★
    Call: (f, args, argTerms, loc) =>
        Effect.gen(function* () {
            // f は Func の結果である可能性が高いため suspend でラップ
            const fty = yield* Effect.suspend(() => f);
            if (fty.tag !== TypeTag.Func) {
                const msg = Messages.FuncExpected;
                return yield* Effect.try({
                    try: () => errorAt(msg, loc),
                    catch: () => new TypeError({message: msg, loc}),
                });
            }

            // args の中身も Func の結果である可能性があるため suspend でラップ
            const argTys = yield* Effect.suspend(() => Effect.all(args));

            if (fty.params.length !== argTys.length) {
                const msg = Messages.ArgCountMismatch;
                return yield* Effect.try({
                    try: () => errorAt(msg, loc),
                    catch: () => new TypeError({message: msg, loc}),
                });
            }

            for (let i = 0; i < argTys.length; i++) {
                if (!typeEq(fty.params[i].type, argTys[i])) {
                    const msg = "parameter type mismatch";
                    return yield* Effect.try({
                        try: () => errorAt(msg, argTerms[i].loc),
                        catch: () => new TypeError({message: msg, loc: argTerms[i].loc}),
                    });
                }
            }
            return fty.retType;
        }),
    // ★★★ 'Seq' の実装を追加 ★★★
    Seq: (body, rest, _loc) =>
        Effect.gen(function* () {
            yield* Effect.suspend(() => body); // body を評価 (結果は使わない)
            return yield* Effect.suspend(() => rest); // rest の型を返す
        }),

    // ★★★ 'Const' の実装を追加 ★★★
    Const: (name, init, rest, _loc) =>
        Effect.gen(function* () {
            // init の型を評価
            const initTy = yield* Effect.suspend(() => init);
            // 現在の環境を取得
            const currentEnv = yield* TypeEnvTag;
            // 環境を拡張
            const newEnv = extendEnv(currentEnv, [[name, initTy]]);
            // rest を新しい環境で評価
            return yield* Effect.provideService(rest, TypeEnvTag, newEnv);
        }),
};

// ====== 7) 公開 API（Fail と Die を正しく処理する）（変更なし） =========
export function typecheck(t: any, env: TypeEnv = emptyEnv): Type {
    const computation = foldTermR(algType, t);

    // ★ Effect.provideService の引数順序を確認
    const runnable = Effect.provideService(computation, TypeEnvTag, env);

    const result = Effect.runSyncExit(runnable);

    if (Exit.isSuccess(result)) {
        return result.value;
    } else {
        if (result.cause._tag === "Fail") {
            const err = result.cause.error;
            // TypeError の情報を使って errorAt を呼び出す
            errorAt(err.message, err.loc);
        }
        if (result.cause._tag === "Die") {
            throw result.cause.defect;
        }
        throw new Error(`Typechecking failed (Unknown Cause): ${JSON.stringify(result.cause)}`);
    }
}

// ====== 8) 動作テスト（変更なし） =======================
// console.log("--- 単体テスト ---");
// try {
//     console.log(typecheck(parseBasic("(x: boolean) => 42") as unknown as Term, {}));
//     console.log(typecheck(parseBasic("(x: number) => x") as unknown as Term, {}));
// } catch (e) {
//     if (e instanceof TypeError) {
//         console.error(e.message);
//     } else {
//         console.error("Unknown error:", e);
//     }
// }
//
// console.log("\n--- 基本的な例 (examples) ---");
// const examples = [
//     "true",
//     "false",
//     "true ? 1 : 2",
//     "1",
//     "1 + 2",
//     "true ? 1 : true",
//     "true + 1",
//     "1 + true",
// ];
//
// for (const code of examples) {
//     const term = parseBasic(code) as unknown as Term;
//     try {
//         const ty = typecheck(term);
//         console.log(`${code} :: ${ty.tag}`);
//     } catch (e) {
//         if (e instanceof TypeError) {
//             console.error(`${code} => ${e.message} (at ${e.loc.start.line}:${e.loc.start.column})`);
//         } else {
//             console.error(`${code} => Unknown error:`, e);
//         }
//     }
// }
//
// console.log("\n--- 関数呼び出しの例 (callExamples) ---");
// const callExamples = [
//     "((x: number) => x + 1)(41)",
//     "((x: number, y: number) => x)(1, 2)",
//     "((x: number) => x)(true)",
//     "((x: number, y: number) => x)(1)",
//     "(1)(2)",
// ];
//
// for (const code of callExamples) {
//     const term = parseBasic(code) as unknown as Term;
//     try {
//         const ty = typecheck(term);
//         console.log(`${code} :: ${ty.tag}`);
//     } catch (e) {
//         if (e instanceof TypeError) {
//             console.error(`${code} => ${e.message} (at ${e.loc.start.line}:${e.loc.start.column})`);
//         } else {
//             console.error(`${code} => Unknown error:`, e);
//         }
//     }
// }
//
// console.log("\n--- Seq/Const の例 ---");
// const seqConstExamples = [
//     "const x = 1; x + 2",          // OK: Number
//     "const x = true; x ? 1 : 2",   // OK: Number
//     "1; 2",                         // OK: Number (Seq)
//     "const x = 1; const y = 2; x + y", // OK: Number
// ];
//
// for (const code of seqConstExamples) {
//     const term = parseBasic(code) as unknown as Term;
//     try {
//         const ty = typecheck(term);
//         console.log(`${code} :: ${ty.tag}`);
//     } catch (e) {
//         if (e instanceof TypeError) {
//             console.error(`${code} => ${e.message} (at ${e.loc.start.line}:${e.loc.start.column})`);
//         } else {
//             console.error(`${code} => Unknown error:`, e);
//         }
//     }
// }
//
// // …（basic.ts の実装）…
//
// console.log(typecheck(parseBasic(`
//  const add = (x: number, y: number) => x + y;
//  const select = (b: boolean, x: number, y: number) => b ? x : y;
//  const x = add(1, add(2, 3));
//  const y = select(true, x, x);
//   y;
// `), {}));