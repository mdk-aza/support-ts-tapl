// -----------------------------------------------------------------------------
// Effect-TS を用いた型検査器の実装
// -----------------------------------------------------------------------------
//
// ■ ひとことで言えば
//
// このコードは、型検査のロジック（algType）とASTの走査（foldTermR）を分離しています。
// さらに、内部的なエラー処理（TypeError）と環境の引き回し（TypeEnv）を
// Effect-TS を使って純粋な値（Effect）として管理し、
// 公開API（typecheck）でそれを実行して、従来通りの例外(throw)と戻り値(return)に変換しています。
//
// ■ なぜ Effect-TS を使うのか？ (モナドとの違い)
//
// 以前の実装（スニペット2、会話履歴参照）では、環境の引き回し（Reader）と
// エラー処理（Exception）を、手製の素朴な関数 (R<A>, local, pureR, errorAt) で実装していました。
//
// これを純粋な関数型の手法で抽象化する場合、一般的には「モナドトランスフォーマー」
// （例えば `ReaderT<Error, Env, A>`）のようなアプローチが取られます。
// しかし、モナドトランスフォーマーは型が複雑になりがちで、
// 複数のエフェクト（Reader, Error, State...）を組み合わせるのが難しいという問題があります。
//
// 一方、Effect-TS は「エフェクトシステム (Effect System)」という異なる発想に基づいています。
//
// 1. **関心の分離 (Separation of Concerns):**
//    Effect-TS は、計算（処理ロジック）を `Effect<A, E, R>` という値として定義します。
//    - `A` (Success): 成功した場合の型（今回は `Type`）
//    - `E` (Error):   失敗した場合の型（今回は `TypeError`）
//    - `R` (Resource): 計算が必要とする「環境」や「サービス」（今回は `TypeEnv`）
//
//    このように、ロジック・エラー・環境依存を型レベルで明示的に分離します。
//
// 2. **合成可能性 (Composability):**
//    `Effect.gen` (ジェネレータ) や `pipe` を使うことで、
//    複数の `Effect` を「どの環境が必要か」「どのエラーが出うるか」を Effect-TS 自身に
//    推論させながら、同期的な `async/await` のように自然に合成できます。
//
// 3. **実行の分離 (Separation of Execution):**
//    `algType` や `foldTermR` で構築されるのは、あくまで「計算の定義（設計図）」です。
//    `typecheck` 関数内で `Effect.provideService` と `Effect.runSyncExit` が
//    呼び出されるまで、実際の計算は一切実行されません（遅延実行）。
//
// この「定義」と「実行」の分離こそがエフェクトシステムの核心であり、
// モナドベースの実装よりも柔軟で、テストしやすく、依存関係の管理が容易なコードを実現します。
//
// このファイルは、その具体的な実装例です。
//
// -----------------------------------------------------------------------------

// ====== imports ======
// error as parseError は、エラー発生箇所のソースコードをハイライト表示するために使います。
import {error as parseError} from "npm:tiny-ts-parser";
// Effect-TS のコア機能
// ★ pipe をインポート
import {Context, Data, Effect, Exit, pipe} from "npm:effect";

// ====== 1) 定数群（タグ/エラー文言）=====================================
// ASTノードの種別（"if", "add" など）を文字列リテラルで直接書く代わりに使用します。
// これにより、タイプミスをコンパイラが検出でき、リファクタリングも容易になります。
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

// 型の種別（"Boolean", "Number" など）を定数として定義します。
export const TypeTag = {
    Boolean: "Boolean",
    Number: "Number",
    Func: "Func",
} as const;

// エラーメッセージを定数として一元管理します。
// これにより、文言の統一や将来的な国際化対応（i18n）が容易になります。
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

// ====== 2) AST / Type / Env / Location =================================

// ソースコード中の「位置」を表す型。
export type Position = { line: number; column: number };
// ソースコード中の「範囲」（開始位置から終了位置）を表す型。
// これをASTの各ノードに持たせることで、型エラーの発生箇所を正確にユーザーに伝えられます。
export type Location = { start: Position; end: Position };
// 関数の仮引数の型。名前と型を持つ。
export type Param = { name: string; type: Type };

// AST (Abstract Syntax Tree; 抽象構文木) のノードを表す型。
// | (ユニオン型) を使うことで、この言語のすべての構文要素を網羅的に表現します。
// すべてのノードが loc: Location を持つのがポイントです。
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

// 型検査器が扱う「型」そのものを表すデータ構造。
export type Type =
    | { tag: typeof TypeTag.Boolean }
    | { tag: typeof TypeTag.Number }
    | { tag: typeof TypeTag.Func; params: Param[]; retType: Type }; // 関数型は引数の型と戻り値の型を持つ

// 型環境 (Type Environment) を表す型。
// 変数名 (string) からその変数の型 (Type) へのマッピング（辞書）です。
// Readonly にすることで、型検査中に意図せず環境が変更されることを防ぎます。
export type TypeEnv = Readonly<Record<string, Type>>;

// --- Effect-TS による変更点 (1) ---
// TypeEnv を Effect-TS の「サービス」として扱えるように Tag を作成します。
// これが、手製の Reader (R<A>) を置き換える中心的な仕組みです。
// '@app/TypeEnv' はデバッグ用の識別子です。
export const TypeEnvTag = Context.GenericTag<TypeEnv>("@app/TypeEnv");
export const emptyEnv: TypeEnv = Object.freeze({});

/**
 * 既存の環境 env に対して、新しい変数の束縛 entries を追加した「新しい」環境を返すヘルパー関数。
 * 元の env は変更しない（不変性 Immutability を保つ）ことが重要です。
 *
 * @param env 親となる環境
 * @param entries
 * @returns 新しい変数が追加された子環境
 */
const extendEnv = (
    env: TypeEnv,
    entries: ReadonlyArray<readonly [string, Type]>,
): TypeEnv =>
    // スプレッド構文を使い、元のenvをコピーした上で新しい束縛を追加します。
    // Object.fromEntries で [key, value] の配列をオブジェクトに変換しています。
    Object.freeze({
        ...env,
        ...Object.fromEntries(entries),
    });

// ====== 3) 型等価（変更なし）===========================
/**
 * 2つの型 `a` と `b` が等価かどうかを判定します。
 * @param a 比較する型1
 * @param b 比較する型2
 * @returns 等価であれば true
 */
export function typeEq(a: Type, b: Type): boolean {
    // 1. タグが違えば、そもそも違う型
    if (a.tag !== b.tag) return false;

    // 2. タグごとの詳細な比較
    switch (a.tag) {
        case TypeTag.Boolean:
        case TypeTag.Number:
            // Boolean同士、Number同士は常に等価
            return true;
        case TypeTag.Func: {
            // a と b が両方 Func であることは if (a.tag !== b.tag) で保証済み
            const bb = b as Extract<Type, { tag: typeof TypeTag.Func }>;
            // 2a. 引数の個数が違えば、違う型
            if (a.params.length !== bb.params.length) return false;
            // 2b. 引数の型を先頭から順に再帰的に比較
            for (let i = 0; i < a.params.length; i++) {
                // ここで typeEq を再帰的に呼んでいるのがポイント。
                // 引数名 (a.params[i].name) は比較しないことに注意（型だけが重要）。
                if (!typeEq(a.params[i].type, bb.params[i].type)) return false;
            }
            // 2c. 戻り値の型を再帰的に比較
            return typeEq(a.retType, bb.retType);
        }
    }
}

// ====== 4) Reader（削除） =================
// --- Effect-TS による変更点 (2) ---
// 以前のコードにあった R<A>, pureR, asks, local, mapR などの
// 手製 Reader コンビネータはすべて不要になりました。
//
// 以下の Effect-TS の機能がそれらを置き換えます。
// ・ R<A> ( = (env: TypeEnv) => A )
//   → Effect.Effect<A, E, R> ( = Effect.Effect<Type, TypeError, TypeEnv> )
// ・ pureR ( = (a: A) => () => a )
//   → Effect.succeed(a)
// ・ asks ( = (f: (env: TypeEnv) => A) => (env) => f(env) )
//   → Effect.gen(function*() { const env = yield* TypeEnvTag; return f(env); })
// ・ local ( = (f: (env) => env) => (ra: R<A>) => (env) => ra(f(env)) )
//   → Effect.mapInputContext((ctx) => Context.add(ctx, TypeEnvTag, f(Context.get(ctx, TypeEnvTag))))
//   → または Effect.provideService(ra, TypeEnvTag, newEnv)
// ・ mapR ( = (ra: R<A>, f: (a: A) => B) => (env) => f(ra(env)) )
//   → Effect.map(ra, f)  または  pipe(ra, Effect.map(f))


// ====== 4.5) 位置付きエラー（変更なし） ============
// 1. エラー型は Effect-TS (Data) で定義
// これにより、Effect の E (Error) チャネルで型安全に扱うことができます。
// Data.TaggedError を使うと ._tag プロパティで判別可能なエラークラスを簡単に作れます。
export class TypeError extends Data.TaggedError("TypeError")<{
    readonly message: string;
    readonly loc: Location;
}> {
}

/**
 * 指定された `loc` (Location) 情報を使って、詳細な型エラーをスローします。
 * この関数がスローする *標準の Error* は、
 * Effect の計算 (algType) の中で Effect.try によってキャッチされ、
 * 上記の *カスタム TypeError* に変換されます。
 *
 * @param msg エラーメッセージ (例: "boolean expected")
 * @param loc エラーが発生したASTノードの
 */
function errorAt(msg: string, loc: Location): never {
    try {
        // npm:tiny-ts-parser の error 関数は、第2引数に { loc } を持つオブジェクトを
        // 期待するため、`as any` でラップして渡しています。
        // これがコンソールにソースコードの該当箇所をハイライト表示します。
        parseError(msg, {loc} as any);
    } catch {
        // parseError が throw しなかった場合（テスト環境などで）の保険
    }
    // 念のため、標準的な "file:line:col" 形式のフォールバックエラーをスローします。
    // この throw が Effect.try にキャッチされます。
    const s = loc.start, e = loc.end;
    throw new Error(`test.ts:${s.line}:${s.column + 1}-${e.line}:${e.column + 1} ${msg}`);
}

// ====== 5) 環境付き catamorphism（変更なし） ===========================

// --- Effect-TS による変更点 (3) ---
// R<A> が Effect.Effect<A, TypeError, TypeEnv> に変わります。
// A = 畳み込みの結果の型 (今回は Type)
// E = 発生しうるエラー (今回は TypeError)
// R = 必要な環境/サービス (今回は TypeEnv)
type AlgEffect<A> = Effect.Effect<A, TypeError, TypeEnv>;

/**
 * `Term` (AST) の各ノードに対応する処理をまとめた「代数 (Algebra)」の型。
 *
 * ここでの「代数 (Algebra)」とは、関数型プログラミングの文脈、特に
 * Catamorphism (fold) パターンで使われる用語です。
 * 一言でいうと、「データ構造（今回ならTerm）の『作り方』に1対1で対応する
 * 『処理の仕方』を定義したオブジェクト」のことです。
 *
 * `foldTermR` は、この代数を受け取ってASTを処理します。
 * すべての処理が `AlgEffect<A>` (＝ Effect<A, E, R>) を返すのが特徴です。
 */
type TermAlgR<A> = {
    True: (loc: Location) => AlgEffect<A>;
    False: (loc: Location) => AlgEffect<A>;
    Number: (n: number, loc: Location) => AlgEffect<A>;
    // Add ノードの処理。l と r は、*子ノードを処理した結果の計算* AlgEffect<A> です。
    Add: (l: AlgEffect<A>, r: AlgEffect<A>, loc: Location) => AlgEffect<A>;
    If: (c: AlgEffect<A>, t: AlgEffect<A>, e: AlgEffect<A>, loc: Location) => AlgEffect<A>;
    Var: (name: string, loc: Location) => AlgEffect<A>;
    // Func ノードの処理。body は *子ノードを処理した結果の計算* AlgEffect<A> です。
    Func: (params: Param[], body: AlgEffect<A>, loc: Location) => AlgEffect<A>;
    // Call ノード。argTerms はエラー位置報告のために Term そのものも受け取ります。
    Call: (f: AlgEffect<A>, args: ReadonlyArray<AlgEffect<A>>, argTerms: ReadonlyArray<Term>, loc: Location) => AlgEffect<A>;
    Seq: (body: AlgEffect<A>, rest: AlgEffect<A>, loc: Location) => AlgEffect<A>;
    Const: (name: string, init: AlgEffect<A>, rest: AlgEffect<A>, loc: Location) => AlgEffect<A>;
};

/**
 * Catamorphism (または fold) を実現する関数。
 * この関数の責務は「ASTの木構造を再帰的にたどる」ことだけです。
 * 「各ノードで具体的に何をするか」は、引数 `alg` (代数) が決定します。
 *
 * これにより、「ASTの走査」と「具体的な処理（型検査、評価、コード生成など）」を
 * 完全に分離でき、コードの見通しが良くなります。
 *
 * @param alg ASTの各ノードに対する処理を定義したオブジェクト
 * @param t 処理対象のASTノード
 * @returns ノード t に対する処理をカプセル化した計算 `AlgEffect<A>`
 */
export function foldTermR<A>(alg: TermAlgR<A>, t: Term): AlgEffect<A> {
    switch (t.tag) {
        // --- 葉 (Leaf) ノード ---
        // 葉ノードは、対応する alg の関数を呼ぶだけです。
        case TermTag.True:
            return alg.True(t.loc);
        case TermTag.False:
            return alg.False(t.loc);
        case TermTag.Number:
            return alg.Number(t.n, t.loc);
        case TermTag.Var:
            return alg.Var(t.name, t.loc);

        // --- 枝 (Branch) ノード ---
        // 枝ノードは、まず子ノードに対して再帰的に foldTermR を呼び出し、
        // その「結果（＝AlgEffect<A>）」を alg の関数に渡します。
        case TermTag.Add:
            return alg.Add(
                foldTermR(alg, t.left), // 左の子を処理した「計算」
                foldTermR(alg, t.right), // 右の子を処理した「計算」
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
            // Func ノードも枝ノード。子である body を再帰的に処理します。
            return alg.Func(t.params, foldTermR(alg, t.body), t.loc);
        case TermTag.Call:
            const f = foldTermR(alg, t.func);
            const args = t.args.map((a) => foldTermR(alg, a)); // map で子ノードのリストを処理
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
                foldTermR(alg, t.init),
                foldTermR(alg, t.rest),
                t.loc,
            );
    }
}

// ====== 6) 型検査用の代数（Effect.gen と suspend を使用） =========================

// --- Effect-TS による変更点 (4) ---
// ここが最も大きな変更点です。
// (env) => { ... } という手動の Reader 実装が
// Effect.gen (ジェネータ構文) や Effect.map/Effect.contextMap に置き換わります。

/**
 * `foldTermR` に渡すための、「型検査」に特化した代数 (Algebra)。
 * `A` が `Type` になる (AlgEffect<Type>) ように定義されています。
 * つまり、各ノードの処理は「環境 (TypeEnv) を要求し、型 (Type) を返すか、
 * もしくは型エラー (TypeError) で失敗する可能性のある計算 (Effect)」
 * となります。
 */
const algType: TermAlgR<Type> = {
    // True リテラルの型は、環境に依存せず常に Boolean
    // Effect.succeed は pureR の代わり
    True: (_loc) => Effect.succeed({tag: TypeTag.Boolean}),
    // False リテラルの型は、環境に依存せず常に Boolean
    False: (_loc) => Effect.succeed({tag: TypeTag.Boolean}),
    // Number リテラルの型は、環境に依存せず常に Number
    Number: (_n, _loc) => Effect.succeed({tag: TypeTag.Number}),

    // Var ノードの型は、環境に依存する
    // (yield* TypeEnvTag は Context.Tag であり、mapInputContext された Effect ではないため)
    Var: (name, loc) =>
        // Effect.gen は do 記法とも呼ばれ、同期的な
        // async/await のように Effect を扱えます。
        Effect.gen(function* () {
            // yield* TypeEnvTag は「現在の環境 TypeEnv を要求する」
            // (手製 Reader の `asks` に相当)
            const env = yield* TypeEnvTag;
            const ty = env[name];
            if (!ty) {
                // 変数が見つからない
                const msg = `${Messages.UnknownVariable}: ${name}`;
                // Effect.try は、try ブロックで発生した throw を
                // catch ブロックで E チャネルのエラー (TypeError) に変換します。
                return yield* Effect.try({
                    try: () => errorAt(msg, loc), // この関数は throw する
                    catch: () => new TypeError({message: msg, loc}), // Effect の失敗(E)チャネル用の型エラーに変換
                });
            }
            // 型が見つかった
            return ty;
        }),

    // Add ノードの型検査
    Add: (l, r, loc) =>
        Effect.gen(function* () {
            // l, r は Effect<Type, ...> です。
            // (env) => l(env) の代わりに yield* で実行結果を取得します。
            // ★★★
            // l と r は Func (mapInputContext) の結果である可能性があるため、
            // その環境変更（スコープ）がこの場で正しく適用されるよう、
            // Effect.suspend で評価を遅延させ、ここで実行します。
            // ★★★
            const lt = yield* Effect.suspend(() => l);
            const rt = yield* Effect.suspend(() => r);

            // 両方が Number でなければエラー
            if (lt.tag !== TypeTag.Number || rt.tag !== TypeTag.Number) {
                const msg = Messages.RuntimeAddType;
                return yield* Effect.try({
                    try: () => errorAt(msg, loc),
                    catch: () => new TypeError({message: msg, loc}),
                });
            }
            // Add の結果は Number 型
            return {tag: TypeTag.Number};
        }),

    // If ノードの型検査
    If: (c, t, e, loc) =>
        Effect.gen(function* () {
            // 1. 条件 (cond) の型をチェック
            // ★ c, t, e も Func の結果である可能性があるため suspend でラップ
            const ct = yield* Effect.suspend(() => c);
            if (ct.tag !== TypeTag.Boolean) {
                const msg = Messages.IfCondNotBoolean;
                return yield* Effect.try({
                    try: () => errorAt(msg, loc),
                    catch: () => new TypeError({message: msg, loc}),
                });
            }
            // 2. then 節と else 節の型をチェック
            const tt = yield* Effect.suspend(() => t);
            const ee = yield* Effect.suspend(() => e);

            // 3. then と else の型が等価かチェック (typeEq を使う)
            if (!typeEq(tt, ee)) {
                const msg = Messages.IfBranchesMismatch;
                return yield* Effect.try({
                    try: () => errorAt(msg, loc),
                    catch: () => new TypeError({message: msg, loc}),
                });
            }
            // If 式全体の型は then 節の型
            return tt;
        }),

    // Func ノードの型検査
    // ★★★ 'Func' (mapInputContext を使った実装を維持) ★★★
    Func: (params, body, _loc) => {
        // 1. `body` (Effect) が要求する環境(Context)を、
        //    現在の環境(env) から変換（拡張）する Effect を作成します。
        //    (手製 Reader の `local(withArgs)(body)` に相当)
        const retEffect = pipe(
            body, // body は AlgEffect<Type>
            Effect.mapInputContext(
                // この関数は「古い Context」を受け取り「新しい Context」を返します
                (context: Context.Context<TypeEnv>) => {
                    // 1a. 古い Context から現在の TypeEnv を取得
                    const env = Context.get(context, TypeEnvTag);
                    // 1b. 環境を拡張
                    const newEnv = extendEnv(
                        env,
                        params.map((p) => [p.name, p.type] as const),
                    );
                    // 1c. 古い Context に「新しい TypeEnv」を上書きして返す
                    return Context.add(context, TypeEnvTag, newEnv);
                },
            ),
        );

        // 2. 拡張環境で実行される `retEffect` (ボディの型を返す計算) の
        //    結果 (retTy) を使って、`Func` 型全体を構築します。
        //    (手製 Reader の `mapR` に相当)
        return pipe(
            retEffect,
            Effect.map((retTy) => ({ // <- これが mapR 操作
                tag: TypeTag.Func,
                params,
                retType: retTy,
            }))
        );
    },

    // Call ノードの型検査
    // ★★★ 'Call' (suspend を追加) ★★★
    Call: (f, args, argTerms, loc) =>
        Effect.gen(function* () {
            // 1. 呼び出される関数 f の型 (fty) を検査
            // ★ f は Func の結果である可能性が高いため suspend でラップ
            const fty = yield* Effect.suspend(() => f);
            if (fty.tag !== TypeTag.Func) {
                const msg = Messages.FuncExpected;
                return yield* Effect.try({
                    try: () => errorAt(msg, loc),
                    catch: () => new TypeError({message: msg, loc}),
                });
            }

            // 2. 実引数 (args) の型 (argTys) をすべて検査
            // Effect.all は Effect の配列を 1 つの Effect<Type[]> にします。
            // ★ args の中身も Func の結果である可能性があるため suspend でラップ
            const argTys = yield* Effect.suspend(() => Effect.all(args));

            // 3. 仮引数と実引数の「個数」を比較
            if (fty.params.length !== argTys.length) {
                const msg = Messages.ArgCountMismatch;
                return yield* Effect.try({
                    try: () => errorAt(msg, loc),
                    catch: () => new TypeError({message: msg, loc}),
                });
            }

            // 4. 仮引数と実引数の「型」を比較
            for (let i = 0; i < argTys.length; i++) {
                if (!typeEq(fty.params[i].type, argTys[i])) {
                    // ★ メッセージを修正
                    const msg = Messages.ArgTypeMismatch;
                    // ★ エラー位置として、関数呼び出し `loc` ではなく
                    //    型が合わない引数の位置 `argTerms[i].loc` を使う
                    return yield* Effect.try({
                        try: () => errorAt(msg, argTerms[i].loc),
                        catch: () => new TypeError({message: msg, loc: argTerms[i].loc}),
                    });
                }
            }
            // 5. Call 式全体の型は、関数の「戻り値の型 (retType)」
            return fty.retType;
        }),

    // Seq ノードの型検査 (例: "1; true")
    // ★★★ 'Seq' の実装を追加 ★★★
    Seq: (body, rest, _loc) =>
        Effect.gen(function* () {
            // 1. body (1つ目の式) を評価します。
            //    型エラーがあればここで失敗します。
            //    結果の型は使いません。
            // ★ suspend でラップ
            yield* Effect.suspend(() => body);
            // 2. rest (2つ目の式) を評価し、その型を Seq 全体の型として返します。
            // ★ suspend でラップ
            return yield* Effect.suspend(() => rest);
        }),

    // Const ノードの型検査 (例: "const x = 1; x + 2")
    // ★★★ 'Const' の実装を追加 ★★★
    Const: (name, init, rest, _loc) =>
        Effect.gen(function* () {
            // 1. init (初期化式 "1") の型を評価します。
            // ★ suspend でラップ
            const initTy = yield* Effect.suspend(() => init);
            // 2. 現在の環境を取得します。
            const currentEnv = yield* TypeEnvTag;
            // 3. 現在の環境に "x" = Number を追加して、新しい環境 newEnv を作ります。
            const newEnv = extendEnv(currentEnv, [[name, initTy]]);

            // 4. rest (本体 "x + 2") の計算 (Effect) に対して、
            //    `Effect.provideService` を使って、
            //    要求される TypeEnv サービスを newEnv で上書き（提供）します。
            //    (Func で使った mapInputContext と同じことができます)
            return yield* Effect.provideService(rest, TypeEnvTag, newEnv);
        }),
};

// ====== 7) 公開 API（Fail と Die を正しく処理する）（変更なし） =========
/**
 * 型検査器のエントリポイント。
 * @param t 型検査対象のAST
 * @param env 初期型環境 (グローバル変数など)。デフォルトは空。
 * @returns 型検査の結果 (Type)
 * @throws (Effect.try が catch した) 標準 Error
 */
export function typecheck(t: any, env: TypeEnv = emptyEnv): Type {
    // 1. foldTermR (AST走査) に algType (型検査ロジック) と t (AST) を渡す。
    //    この結果は `computation` ( = Effect<Type, TypeError, TypeEnv> ) という
    //    「計算の定義」です。この時点ではまだ実行されません。
    const computation = foldTermR(algType, t);

    // 2. その「計算」が要求する `TypeEnv` サービスに、
    //    初期環境 `env` を提供（inject）します。
    //    `runnable` は `Effect<Type, TypeError, never>` となり、
    //    外部依存がなくなった（実行可能な）Effect になります。
    // ★ Effect.provideService の引数順序を確認 (computation, Tag, env)
    const runnable = Effect.provideService(computation, TypeEnvTag, env);

    // 3. `Effect.runSyncExit` で計算を同期的に実行し、
    //    結果を `Exit<Type, TypeError>` 型で受け取ります。
    //    `Exit` は成功 (Success) または失敗 (Failure) のいずれかです。
    const result = Effect.runSyncExit(runnable);

    if (Exit.isSuccess(result)) {
        // 4a. 成功した場合:
        //     result.value に Type が入っているので、そのまま返します。
        return result.value;
    } else {
        // 4b. 失敗した場合:
        //     result.cause に失敗の原因 (Cause) が入っています。
        if (result.cause._tag === "Fail") {
            // 4b-1. `Fail` は、私たちが意図して発生させた
            //        E チャネルのエラー (TypeError) です。
            const err = result.cause.error;
            // `TypeError` の情報 (message, loc) を `errorAt` に渡し、
            // 従来通りの例外 (throw) を発生させます。
            errorAt(err.message, err.loc);
        }
        if (result.cause._tag === "Die") {
            // 4b-2. `Die` は、意図しない例外 (バグなど) です。
            //        (例: Effect.try で catch し忘れた throw)
            throw result.cause.defect;
        }
        // 4b-3. その他の Cause (Interrupt など)
        throw new Error(`Typechecking failed (Unknown Cause): ${JSON.stringify(result.cause)}`);
    }
}

// ====== 8) 動作テスト（変更なし） =======================
// (tiny-ts-parser の parseBasic をインポートする必要があります)
/*
import { parseBasic } from "npm:tiny-ts-parser";

console.log("--- 単体テスト ---");
try {
    console.log(typecheck(parseBasic("(x: boolean) => 42") as unknown as Term, {}));
    console.log(typecheck(parseBasic("(x: number) => x") as unknown as Term, {}));
} catch (e) {
    if (e instanceof TypeError) {
        console.error(e.message);
    } else {
        console.error("Unknown error:", e);
    }
}

console.log("\n--- 基本的な例 (examples) ---");
const examples = [
    "true",
    "false",
    "true ? 1 : 2",
    "1",
    "1 + 2",
    "true ? 1 : true",
    "true + 1",
    "1 + true",
];

for (const code of examples) {
    const term = parseBasic(code) as unknown as Term;
    try {
        const ty = typecheck(term);
        console.log(`${code} :: ${ty.tag}`);
    } catch (e) {
        // errorAt でスローされた詳細なエラーメッセージが出力されます
        console.error(`${code} => ${(e as Error).message}`);
    }
}

console.log("\n--- 関数呼び出しの例 (callExamples) ---");
const callExamples = [
    "((x: number) => x + 1)(41)",
    "((x: number, y: number) => x)(1, 2)",
    "((x: number) => x)(true)",
    "((x: number, y: number) => x)(1)",
    "(1)(2)",
];

for (const code of callExamples) {
    const term = parseBasic(code) as unknown as Term;
    try {
        const ty = typecheck(term);
        console.log(`${code} :: ${ty.tag}`);
    } catch (e) {
        console.error(`${code} => ${(e as Error).message}`);
    }
}

console.log("\n--- Seq/Const の例 ---");
const seqConstExamples = [
    "const x = 1; x + 2",          // OK: Number
    "const x = true; x ? 1 : 2",   // OK: Number
    "1; 2",                         // OK: Number (Seq)
    "const x = 1; const y = 2; x + y", // OK: Number
    "const x = 1; y + 2",           // NG: unknown variable: y
    "1; const x = true; x",         // OK: Boolean
];

for (const code of seqConstExamples) {
    const term = parseBasic(code) as unknown as Term;
    try {
        const ty = typecheck(term);
        console.log(`${code} :: ${ty.tag}`);
    } catch (e) {
        console.error(`${code} => ${(e as Error).message}`);
    }
}

console.log("\n--- 高階関数の例 ---");
const higherOrderExamples = [
    `
 const apply = (f: Func(Number, Number), x: Number) => f(x);
 apply((y: Number) => y + 1, 10)
 `, // OK: Number
    `
 const twice = (f: Func(Number, Number)) => (x: Number) => f(f(x));
 const add2 = (y: Number) => y + 2;
 const add4 = twice(add2);
 add4(10)
 `, // OK: Number
];

for (const code of higherOrderExamples) {
    const term = parseBasic(code) as unknown as Term;
    try {
        const ty = typecheck(term);
        console.log(`[Example] :: ${ty.tag}`);
    } catch (e) {
        console.error(`[Example] => ${(e as Error).message}`);
    }
}
*/