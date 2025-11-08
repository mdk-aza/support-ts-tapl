// ひとことで言えば、このコード）は、元のコードと同じ目的（型検査）を果たしていますが、より高度で、関心の分離が明確な設計になっています。
// 元のコードは、typecheck 関数内の switch 文で再帰処理と型検査ロジックを直接記述する、シンプルでわかりやすい実装です。

// ====== imports ======
import {error as parseError, parseBasic} from "npm:tiny-ts-parser"; // 位置付きエラーをそのまま利用

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
  ArgTypeMismatch: "argument type mismatch",
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
// 空の（グローバル）環境
export const emptyEnv: TypeEnv = Object.freeze({});

// 既存の環境 env に対して、新しい変数の束縛 entries を追加した「新しい」環境を返す関数。
// 元の env は変更しない（不変性 Fmutability を保つ）ことが重要です。
// const extendEnv = (env: TypeEnv, entries: ReadonlyArray<readonly [string, Type]>): TypeEnv =>
//   entries.reduce((e, [k, v]) => ({ ...e, [k]: v }), env);
// 1. パフォーマンスの問題（O(n²)）
// 2. 不変性の保証がない
// ↑のコメントアウトされた実装は、環境が深くなるたびに全コピーが走り O(n²) になる問題があるため、
// ↓のスプレッド構文 + Object.fromEntries を使った O(n) の実装が採用されています。
const extendEnv = (
  env: TypeEnv,
  entries: ReadonlyArray<readonly [string, Type]>,
): TypeEnv =>
  Object.freeze({
    ...env,
    ...Object.fromEntries(entries),
  });

// さらにパフォーマンスを追求するなら、プロトタイプチェーンを使った実装（↓）も考えられます。
// これならコピーがほぼ発生せず、環境構築は O(1) に近くなります（新規束縛の数に依存）。
// 参照はプロトタイプチェーンを遡るため、スコープが深すぎると遅くなる可能性はありますが、通常は高速です。
// const extendEnv = (
//   env: TypeEnv,
//   entries: ReadonlyArray<readonly [string, Type]>,
// ): TypeEnv => {
//   const child = Object.create(env) as TypeEnv;
//   for (const [k, v] of entries) {
//     Object.defineProperty(child, { value: v, enumerable: true, configurable: false, writable: false });
//   }
//   return Object.freeze(child);
// };

// ====== 3) 型等価（引数名は無視、型だけ比較）===========================

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

// ====== 4) Reader（環境） & cata 用コンビネータ =========================
// このセクションは、型検査器のロジックから「環境 (TypeEnv) を引き回す」という
// 定型的な処理を分離・抽象化するためにあります (Reader パターン)。

/**
 * 「型環境 `env` を受け取って、結果 `A` を返す計算」を表す型。
 * R = Reader の略。
 * `(env: TypeEnv) => A` という関数を `R<A>` という型でカプセル化しています。
 */
type R<A> = (env: TypeEnv) => A;

// 値 `a` を、環境に依存しない計算 `R<A>` に持ち上げる。
const pureR = <A>(a: A): R<A> => () => a;

// 現在の環境 `env` を読み取る計算 `R<A>` を作成する。
// `Var` の型検査（環境から変数を探す）などで使います。
const asks = <A>(f: (env: TypeEnv) => A): R<A> => f;

// ある計算 `ra` を、一時的に変更した環境 `f(env)` で実行する。
// `Func` の型検査（関数のボディを、引数を追加した環境で検査する）で使います。
// これがスコープの実現に不可欠です。
const local = (f: (env: TypeEnv) => TypeEnv) => <A>(ra: R<A>): R<A> => (env) => ra(f(env));

// 計算 `ra` の結果 `a` を、関数 `f` で変換する `R<B>` を作る。
const mapR = <A, B>(ra: R<A>, f: (a: A) => B): R<B> => (env) => f(ra(env));

// 2つの計算 `ra`, `rb` の結果を、関数 `f` で結合する `R<C>` を作る。
// `Add` (l, r) や `If` (c, t, e) の型検査で使えます（今回は手動で実装されています）。
const lift2R = <A, B, C>(f: (a: A, b: B) => C) => (ra: R<A>, rb: R<B>): R<C> => (env) => f(ra(env), rb(env));

// ====== 4.5) 位置付きエラー（パーサの error に {loc} を渡す） ============

/**
 * 指定された `loc` (Location) 情報を使って、詳細な型エラーをスローします。
 * @param msg エラーメッセージ (例: "boolean expected")
 * @param loc エラーが発生したASTノードの
 */
function errorAt(msg: string, loc: Location): never {
  try {
    // npm:tiny-ts-parser の error 関数は、第2引数に { loc } を持つオブジェクトを
    // 期待するため、`as any` でラップして渡しています。
    parseError(msg, { loc } as any);
  } catch {
    // parseError が throw しなかった場合（テスト環境などで）の保険
  }
  // 念のため、標準的な "file:line:col" 形式のフォールバックエラーをスローします。
  const s = loc.start, e = loc.end;
  throw new Error(`test.ts:${s.line}:${s.column + 1}-${e.line}:${e.column + 1} ${msg}`);
}

// ====== 5) 環境付き catamorphism（foldTermR） ===========================

/**
 * `Term` (AST) の各ノードに対応する処理をまとめた「代数 (Algebra)」の型。
 * `foldTermR` は、この代数を受け取ってASTを処理します。
 * すべての処理が `R<A>` (＝ (env: TypeEnv) => A) を返すのが特徴です。
 */
type TermAlgR<A> = {
  True: (loc: Location) => R<A>;
  False: (loc: Location) => R<A>;
  Number: (n: number, loc: Location) => R<A>;
  // Add ノードの処理。l と r は、*子ノードを処理した結果の計算* R<A> です。
  Add: (l: R<A>, r: R<A>, loc: Location) => R<A>;
  If: (c: R<A>, t: R<A>, e: R<A>, loc: Location) => R<A>;
  Var: (name: string, loc: Location) => R<A>;
  // Func ノードの処理。body は *子ノードを処理した結果の計算* R<A> です。
  Func: (params: Param[], body: R<A>, loc: Location) => R<A>;
  Call: (f: R<A>, args: ReadonlyArray<R<A>>, loc: Location) => R<A>;
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
 * @returns ノード t に対する処理をカプセル化した計算 `R<A>`
 */
export function foldTermR<A>(alg: TermAlgR<A>, t: Term): R<A> {
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
    // その「結果（＝R<A>）」を alg の関数に渡します。
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
      return alg.Call(f, args, t.loc);

    // --- 未実装のノード ---
    case TermTag.Seq:
    case TermTag.Const:
      // 未実装のノードに遭遇したら、NotImplemented エラーをスローする計算を返します。
      return (_env) => errorAt(Messages.NotImplemented, t.loc);
  }
}

// ====== 6) 型検査用の代数（位置付きエラー対応） =========================

/**
 * `foldTermR` に渡すための、「型検査」に特化した代数 (Algebra)。
 * `A` が `Type` になる (R<Type>) ように定義されています。
 * つまり、各ノードの処理は「環境 (env) を受け取って、そのノードの型 (Type) を返す計算」
 * となります。
 */
const algType: TermAlgR<Type> = {
  // True リテラルの型は、環境に依存せず常に Boolean
  True: (_loc) => pureR({ tag: TypeTag.Boolean }),
  // False リテラルの型は、環境に依存せず常に Boolean
  False: (_loc) => pureR({ tag: TypeTag.Boolean }),
  // Number リテラルの型は、環境に依存せず常に Number
  Number: (_n, _loc) => pureR({ tag: TypeTag.Number }),

  // Var ノードの型は、環境に依存する
  Var: (name, loc) =>
    // `asks` を使って環境 env を読み取る計算を定義
    asks((env) => {
      const ty = env[name]; // 環境から変数の型を引く
      if (!ty) errorAt(`${Messages.UnknownVariable}: ${name}`, loc); // 見つからなければエラー
      return ty!;
    }),

  // Add ノードの型検査
  // l, r はそれぞれ「左辺の型を返す計算」「右辺の型を返す計算」
  Add: (l, r, loc) => (env) => {
    // env を受け取ったら、まず l と r の計算を *同じ env で* 実行して型を得る
    const lt = l(env), rt = r(env);
    // 両方が Number でなければエラー
    if (lt.tag !== TypeTag.Number || rt.tag !== TypeTag.Number) {
      errorAt(Messages.RuntimeAddType, loc);
    }
    // Add の結果は Number 型
    return { tag: TypeTag.Number };
  },

  // If ノードの型検査
  If: (c, t, e, loc) => (env) => {
    // 1. 条件 (cond) の型をチェック
    const ct = c(env);
    if (ct.tag !== TypeTag.Boolean) errorAt(Messages.IfCondNotBoolean, loc);

    // 2. then 節と else 節の型をチェック
    const tt = t(env), ee = e(env);

    // 3. then と else の型が等価かチェック (typeEq を使う)
    if (!typeEq(tt, ee)) errorAt(Messages.IfBranchesMismatch, loc);

    // If 式全体の型は then 節の型 (else 節の型でも良い)
    return tt;
  },

  // Func ノードの型検査
  Func: (params, body, _loc) => {
    // 1. 「現在の環境に、この関数の引数 (params) を追加する」関数を定義
    const withArgs = (env: TypeEnv) => extendEnv(env, params.map((p) => [p.name, p.type] as const));

    // 2. `local(withArgs)(body)` を使って、
    //    「拡張された環境で body の型検査を実行する」という新しい計算 `retR` を作る。
    //    `body` は `R<Type>` ( = (env) => Type) であり、
    //    `retR` も `R<Type>` ( = (env) => Type) です。
    const retR: R<Type> = local(withArgs)(body); // 本体は拡張環境で

    // 3. `retR` (ボディの型を返す計算) の結果 (retTy) を使って、
    //    `Func` 型全体を構築する計算を `mapR` で作成する。
    return mapR(retR, (retTy) => ({ tag: TypeTag.Func, params, retType: retTy } as Type));
  },

  // Call ノードの型検査
  Call: (f, args, loc) => (env) => {
    // 1. 呼び出される関数 f の型 (fty) を検査
    const fty = f(env);
    if (fty.tag !== TypeTag.Func) {
      errorAt(Messages.FuncExpected, loc);
    }
    const fn = fty as Extract<Type, { tag: typeof TypeTag.Func }>; // fty を関数型として扱う

    // 2. 実引数 (args) の型 (argTys) をすべて検査
    const argTys = args.map((a) => a(env));

    // 3. 仮引数 (fn.params) と実引数 (argTys) の「個数」を比較
    if (fn.params.length !== argTys.length) {
      errorAt(Messages.ArgCountMismatch, loc);
    }

    // 4. 仮引数と実引数の「型」を
    for (let i = 0; i < argTys.length; i++) {
      if (!typeEq(fn.params[i].type, argTys[i])) { // typeEq で比較
        errorAt(Messages.ArgTypeMismatch, loc);
      }
    }

    // 5. Call 式全体の型は、関数の「戻り値の型 (retType)」
    return fn.retType;
  },
};

// ====== 7) 公開 API =====================================================

/**
 * 型検査器のエントリポイント。
 * @param t 型検査対象のAST
 * @param env 初期型環境 (グローバル変数など)。デフォルトは空。
 * @returns 型検査の結果 (Type)
 */
export function typecheck(t: Term, env: TypeEnv = emptyEnv): Type {
  // 1. foldTermR (AST走査) に algType (型検査ロジック) と t (AST) を渡す。
  //    この結果は `R<Type>` ( = (env: TypeEnv) => Type) という「計算」
  const computation = foldTermR(algType, t);

  // 2. その「計算」に、初期環境 `env` を渡して実行する。
  //    これにより、型検査が開始され、最終的な型 (Type) が返される。
  return computation(env);
}

// ====== 8) 動作テスト ====================================================
// このセクションは、定義した型検査器が正しく動作するかを検証します。

console.log("--- 単体テスト ---");
try {
  console.log(typecheck(parseBasic("(x: boolean) => 42") as unknown as Term, {}));
  console.log(typecheck(parseBasic("(x: number) => x") as unknown as Term, {}));
} catch (e) {
  console.error((e as Error).message);
}

console.log("\n--- 基本的な例 (examples) ---");
const examples = [
  "true",
  "false",
  "true ? 1 : 2",
  "1",
  "1 + 2",
  "true ? 1 : true", // ← then and else have different types
  "true + 1", // ← number expected
  "1 + true", // ← number expected
];

for (const code of examples) {
  const term = parseBasic(code) as unknown as Term;
  try {
    const ty = typecheck(term);
    console.log(`${code} :: ${ty.tag}`);
  } catch (e) {
    // errorAt でスローされた詳細なエラーメッセージが出力される
    console.error(`${code} => ${(e as Error).message}`);
  }
}

console.log("\n--- 関数呼び出しの例 (callExamples) ---");
const callExamples = [
  "((x: number) => x + 1)(41)", // OK : Number
  "((x: number, y: number) => x)(1, 2)", // OK : Number
  "((x: number) => x)(true)", // NG : argument type mismatch
  "((x: number, y: number) => x)(1)", // NG : number of arguments mismatch
  "(1)(2)", // NG : function expected
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
