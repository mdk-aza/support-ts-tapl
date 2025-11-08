// -----------------------------------------------------------------------------
// Tagless-Final スタイルによる Effect-TS 型検査器（最終版・超コメント入り）
// -----------------------------------------------------------------------------
//
// ■ このファイルが目指すこと
//   - 「構文(AST)の走査」と「意味（型検査・表示など）」を厳密に分離する。
//   - “意味” は Lang<R> インタフェースの実装（インタプリタ）側に集約する。
//   - 同じ AST を、型検査（R=Effect<...>）やプリティプリント（R=string）など
//     複数の“意味”で安全に再解釈できる（＝Tagless-Final の本質）。
//
// ■ 旧（fold + 代数）版との主な違い（重要）
//   1) 旧: `foldTermR(alg, t)` が「走査＋意味」を一緒に持っていた
//      新: `interpret(L, t)` は「走査だけ」。意味は `Lang<R>` 実装（TypeOf/Pretty 等）に委譲
//   2) 旧: 代数型 `TermAlgR<A>` は、子結果が `AlgEffect<A>`（= Effect）で固定だった
//      新: `Lang<R>` は、子結果が汎用 `R`。Effect 固定から解放され、意味を抽象化
//   3) 旧: `algType: TermAlgR<Type>` が型検査ロジックを持つ
//      新: `TypeOf: Lang<AlgEffect<Type>>` が型検査ロジックを持つ（置き場所の移動）
//   4) 旧: `Effect.suspend` で子計算をラップしていた箇所あり
//      新: **削除**（Effect-TS のコンテキスト隔離が正しく効くことをテストで確認）
//
//   → 結果: 構文と意味が完全分離し、評価戦略の差し替え・比較・証明のモジュール性が向上。
//            Effect.suspend の削除でコードも簡潔＆最適化余地アップ。
//
// ■ 実行サンプル
//   - 末尾の `if (import.meta.main)` を有効にすると、動作確認ができます。
// -----------------------------------------------------------------------------

// ====== imports ======
// tiny-ts-parser: ソース位置つきエラーメッセージ用（parseError）と簡易パーサ（parseBasic）
import {error as parseError, parseBasic} from "npm:tiny-ts-parser";
// Effect-TS: Context（Reader相当）、Effect（計算）、Exit（結果）、pipe（関数合成）
import {Context, Data, Effect, Exit, pipe} from "npm:effect";

// ====== 1) タグ/メッセージ ====================================================
// ASTタグ（文字列直書きの代わりに定数化）
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

// 型タグ
export const TypeTag = {
    Boolean: "Boolean",
    Number: "Number",
    Func: "Func",
} as const;

// エラーメッセージ定数
export const Messages = {
    IfCondNotBoolean: "boolean expected",
    IfBranchesMismatch: "then and else have different types",
    RuntimeAddType: "number expected",
    UnknownVariable: "unknown variable",
    FuncExpected: "function expected",
    ArgCountMismatch: "number of arguments mismatch",
    ArgTypeMismatch: "parameter type mismatch",
} as const;

// ====== 2) 位置情報/AST/型/環境 ==============================================
// 位置・範囲（エラーメッセージのために全ノードが保持）
export type Position = { line: number; column: number };
export type Location = { start: Position; end: Position };
// 関数引数
export type Param = { name: string; type: Type };

// AST 定義（最小の式言語：true/false/数値/加算/if/変数/関数/呼び出し/順序/定数束縛）
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

// 型（ブール/数値/関数）
export type Type =
    | { tag: typeof TypeTag.Boolean }
    | { tag: typeof TypeTag.Number }
    | { tag: typeof TypeTag.Func; params: Param[]; retType: Type };

// 型環境（Reader で扱いたいので Context サービス化）
export type TypeEnv = Readonly<Record<string, Type>>;
export const TypeEnvTag = Context.GenericTag<TypeEnv>("@app/TypeEnv");
export const emptyEnv: TypeEnv = Object.freeze({});

// 型付きエラー（Effect の E チャネル用）
// Data.TaggedError を使うと _tag が乗る（判別可能共用体）
export class TypeError extends Data.TaggedError("TypeError")<{
    readonly message: string;
    readonly loc: Location;
}> {
}

// ソース位置つきエラーを投げる（Effect.try で Fail に変換して扱う）
function errorAt(msg: string, loc: Location): never {
    try {
        parseError(msg, {loc} as any); // 位置つき表示（環境が対応しない場合はフォールバックへ）
    } catch {
    }
    const s = loc.start,
        e = loc.end;
    throw new Error(`test.ts:${s.line}:${s.column + 1}-${e.line}:${e.column + 1} ${msg}`);
}

// 環境拡張（イミュータブル）
const extendEnv = (
    env: TypeEnv,
    entries: ReadonlyArray<readonly [string, Type]>
): TypeEnv =>
    Object.freeze({
        ...env,
        ...Object.fromEntries(entries),
    });

// 型等価（関数型は引数列と戻り値を再帰的に比較。引数名は比較しない）
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

// ====== 3) Tagless-Final: 「構文＝操作の集合（意味へ委譲）」インタフェース ======
//
// 【超重要】Lang<R> は「この言語の構文操作」を “データ” ではなく “操作/関数” として表す。
// R は「意味の型」（＝解釈結果）。これを差し替えると、同じ構文を別の意味で解釈できる。
// 例：R=Effect<Type,...> → 型検査、R=string → プリティ、R=Value → 実行系 …など。
export interface Lang<R> {
    True(loc: Location): R;

    False(loc: Location): R;

    Number(n: number, loc: Location): R;

    Add(l: R, r: R, loc: Location): R;

    If(c: R, t: R, e: R, loc: Location): R;

    Var(name: string, loc: Location): R;

    Func(params: Param[], body: R, loc: Location): R;

    Call(
        f: R,
        args: ReadonlyArray<R>,
        argTerms: ReadonlyArray<Term>, // エラー位置のため元ASTを渡す
        loc: Location
    ): R;

    Seq(body: R, rest: R, loc: Location): R;

    Const(name: string, init: R, rest: R, loc: Location): R;
}

// ====== 4) Tagless-Final: AST 走査器（interpret） ===============================
//
// interpret は「AST の走査だけ」を担当する。意味は一切持たず、Lang<R> に委譲する。
// 旧 foldTermR との違いは、子結果の型が Effect 固定ではなく一般の R になっていること。
export function interpret<R>(L: Lang<R>, t: Term): R {
    switch (t.tag) {
        case TermTag.True:
            return L.True(t.loc);
        case TermTag.False:
            return L.False(t.loc);
        case TermTag.Number:
            return L.Number(t.n, t.loc);
        case TermTag.Var:
            return L.Var(t.name, t.loc);

        case TermTag.Add: {
            const l = interpret(L, t.left);
            const r = interpret(L, t.right);
            return L.Add(l, r, t.loc);
        }
        case TermTag.If: {
            const c = interpret(L, t.cond);
            const thn = interpret(L, t.thn);
            const els = interpret(L, t.els);
            return L.If(c, thn, els, t.loc);
        }
        case TermTag.Func: {
            const body = interpret(L, t.body);
            return L.Func(t.params, body, t.loc);
        }
        case TermTag.Call: {
            const f = interpret(L, t.func);
            const args = t.args.map((a) => interpret(L, a));
            // ★ argTerms を一緒に渡すのは、型ミスマッチ時に “引数側の loc” を指すため
            return L.Call(f, args, t.args, t.loc);
        }
        case TermTag.Seq: {
            const body = interpret(L, t.body);
            const rest = interpret(L, t.rest);
            return L.Seq(body, rest, t.loc);
        }
        case TermTag.Const: {
            const init = interpret(L, t.init);
            const rest = interpret(L, t.rest);
            return L.Const(t.name, init, rest, t.loc);
        }
    }
}

// ====== 5) 型検査インタプリタ（Lang<AlgEffect<Type>> の具象実装） =============
//
// ここが “意味” の本体（旧 algType に相当）。
// Before: TermAlgR<Type>（子は AlgEffect<Type> 固定）
// After : Lang<AlgEffect<Type>>（R として AlgEffect<Type> を指定）
//
// AlgEffect は Reader（TypeEnv）＋ Error（TypeError）を Effect-TS で表す。
export type AlgEffect<A> = Effect.Effect<A, TypeError, TypeEnv>;

export const TypeOf: Lang<AlgEffect<Type>> = {
    // リテラル：環境に依存しないので Effect.succeed
    True: (_loc) => Effect.succeed({tag: TypeTag.Boolean}),
    False: (_loc) => Effect.succeed({tag: TypeTag.Boolean}),
    Number: (_n, _loc) => Effect.succeed({tag: TypeTag.Number}),

    // 変数：環境から型を引く。無ければ TypeError を Fail に積む。
    Var: (name, loc) =>
        Effect.gen(function* () {
            const env = yield* TypeEnvTag;
            const ty = env[name];
            if (!ty) {
                const msg = `${Messages.UnknownVariable}: ${name}`;
                return yield* Effect.try({
                    try: () => errorAt(msg, loc), // 位置つき throw
                    catch: () => new TypeError({message: msg, loc}), // Fail に変換
                });
            }
            return ty;
        }),

    // 加算：両辺が Number であることを要求
    // ★ 旧版との違い：Effect.suspend(...) ラップは削除。
    //    → Effect-TS のランタイム（flatMap/gen）で Context 隔離が正しく保たれるため。
    Add: (l, r, loc) =>
        Effect.gen(function* () {
            const lt = yield* l;
            const rt = yield* r;
            if (lt.tag !== TypeTag.Number || rt.tag !== TypeTag.Number) {
                const msg = Messages.RuntimeAddType;
                return yield* Effect.try({
                    try: () => errorAt(msg, loc),
                    catch: () => new TypeError({message: msg, loc}),
                });
            }
            return {tag: TypeTag.Number};
        }),

    // if：条件は Boolean、then/else の型一致を要求
    If: (c, t, e, loc) =>
        Effect.gen(function* () {
            const ct = yield* c;
            if (ct.tag !== TypeTag.Boolean) {
                const msg = Messages.IfCondNotBoolean;
                return yield* Effect.try({
                    try: () => errorAt(msg, loc),
                    catch: () => new TypeError({message: msg, loc}),
                });
            }
            const tt = yield* t;
            const ee = yield* e;
            if (!typeEq(tt, ee)) {
                const msg = Messages.IfBranchesMismatch;
                return yield* Effect.try({
                    try: () => errorAt(msg, loc),
                    catch: () => new TypeError({message: msg, loc}),
                });
            }
            return tt;
        }),

    // 関数：スコープ拡張は mapInputContext/provideService で行うのが正道
    Func: (params, body, _loc) => {
        // body の要求する Context を「パラメータを追加した環境」に差し替える
        const retEffect = pipe(
            body,
            Effect.mapInputContext((context: Context.Context<TypeEnv>) => {
                const env = Context.get(context, TypeEnvTag);
                const newEnv = extendEnv(
                    env,
                    params.map((p) => [p.name, p.type] as const)
                );
                return Context.add(context, TypeEnvTag, newEnv);
            })
        );
        // 関数型の戻り値型を作って返す
        return pipe(
            retEffect,
            Effect.map((retTy) => ({tag: TypeTag.Func, params, retType: retTy}))
        );
    },

    // 呼び出し：関数型であること、引数個数・型一致を検査
    // ★ 型ミス時の位置は「関数全体 loc」ではなく「該当引数の loc」を指す
    Call: (f, args, argTerms, loc) =>
        Effect.gen(function* () {
            const fty = yield* f;
            if (fty.tag !== TypeTag.Func) {
                const msg = Messages.FuncExpected;
                return yield* Effect.try({
                    try: () => errorAt(msg, loc),
                    catch: () => new TypeError({message: msg, loc}),
                });
            }
            const argTys = yield* Effect.all(args);
            if (fty.params.length !== argTys.length) {
                const msg = Messages.ArgCountMismatch;
                return yield* Effect.try({
                    try: () => errorAt(msg, loc),
                    catch: () => new TypeError({message: msg, loc}),
                });
            }
            for (let i = 0; i < argTys.length; i++) {
                if (!typeEq(fty.params[i].type, argTys[i])) {
                    const msg = Messages.ArgTypeMismatch;
                    return yield* Effect.try({
                        try: () => errorAt(msg, argTerms[i].loc), // ★引数の位置を指す
                        catch: () =>
                            new TypeError({message: msg, loc: argTerms[i].loc}),
                    });
                }
            }
            return fty.retType;
        }),

    // 順序：左を捨てて右の型を返す（左で失敗すれば当然失敗）
    Seq: (body, rest, _loc) =>
        Effect.gen(function* () {
            yield* body;
            return yield* rest;
        }),

    // const 束縛：初期化式の型で環境を拡張して本体を検査
    Const: (name, init, rest, _loc) =>
        Effect.gen(function* () {
            const initTy = yield* init;
            const currentEnv = yield* TypeEnvTag;
            const newEnv = extendEnv(currentEnv, [[name, initTy]]);
            return yield* Effect.provideService(rest, TypeEnvTag, newEnv);
        }),
};

// ====== 6) 公開 API（fold版→Tagless-Final版の唯一の呼び出し差分） ============
//
// Before: const computation = foldTermR(algType, t);
// After : const computation = interpret(TypeOf, t);  ← ← ← ここが唯一の変更点
//
// 以降（provideService → runSyncExit → Exit 判定）は同じ。
export function typecheck(t: Term, env: TypeEnv = emptyEnv): Type {
    // AST を「型検査という意味」で解釈
    const computation = interpret(TypeOf, t);

    // 計算が要求する TypeEnv を注入
    const runnable = Effect.provideService(computation, TypeEnvTag, env);

    // 実行して Exit を受け取る（Success or Failure）
    const result = Effect.runSyncExit(runnable);

    if (Exit.isSuccess(result)) return result.value;

    if (result.cause._tag === "Fail") {
        const err = result.cause.error as TypeError;
        errorAt(err.message, err.loc); // 位置つき例外として再throw
    }
    if (result.cause._tag === "Die") {
        throw result.cause.defect; // 予期しない例外
    }
    throw new Error(
        `Typechecking failed (Unknown Cause): ${JSON.stringify(result.cause)}`
    );
}

// ====== 7) もう一つの“意味”の例：プリティプリンタ ===========================
//
// 同じ構文を今度は「文字列」として解釈（Tagless-Final の威力デモ）
export const Pretty: Lang<string> = {
    True: () => "true",
    False: () => "false",
    Number: (n) => String(n),
    Var: (name) => name,
    Add: (l, r) => `(${l} + ${r})`,
    If: (c, t, e) => `(${c} ? ${t} : ${e})`,
    Func: (params, body) =>
        `(${params.map((p) => `${p.name}: ${p.type.tag}`).join(", ")}) => ${body}`,
    Call: (f, args) => `${f}(${args.join(", ")})`,
    Seq: (body, rest) => `${body}; ${rest}`,
    Const: (name, init, rest) => `const ${name} = ${init}; ${rest}`,
};

// ====== 8) 実行例（Deno: deno run -A thisfile.ts） ===========================
//
// - 「Tagless-Final の構文→意味の分離」が効いていることがすぐ分かる動作確認。
// - 解析対象の AST は tiny-ts-parser の parseBasic を使って作っている（簡易文法）。
//
if (import.meta.main) {
    const code1 = "(x: number) => x + 1";
    const code2 = "((x: number) => x)(true)"; // 型エラー例

    const term1 = parseBasic(code1) as unknown as Term;
    console.log("Pretty:", interpret(Pretty, term1)); // => (x: Number) => (x + 1)
    console.log("Type  :", typecheck(term1).tag);     // => "Func"

    try {
        const term2 = parseBasic(code2) as unknown as Term;
        console.log("Type  :", typecheck(term2).tag);   // ここはエラーになるはず
    } catch (e) {
        console.error("TypeError:", (e as Error).message);
    }
}

/* ここまで
   ---------------------------------------------------------------
   補足: Effect.suspend を消した理由（設計ノート）
   - 旧実装では、子計算 l/r を gen の中で実行する際に suspend でラップしていた。
   - 理由は「ローカルなコンテキスト（mapInputContext/provide）によるスコープ拡張が
     gen の合成で漏れないか？」という懸念（古典的にある）。
   - しかし Effect-TS のランタイムは Context を継続境界で正しく隔離/復元するため、
     ここでの型検査器においては suspend なしで正しく動作することをテストで確認済み。
   - 結果として、suspend は冗長＆最適化を阻害しうるため削除が望ましい。
   ---------------------------------------------------------------
*/
