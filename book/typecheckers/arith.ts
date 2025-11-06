// ====== imports ======
import {match, P} from "npm:ts-pattern";
import {error} from "npm:tiny-ts-parser"; // ← これを追加！

// ====== 1) 定数群（タグ/記号/JS型名/エラー）============================

// 1️⃣ 帰納的定義（Inductive Definition）
// これが 帰納的定義（inductive definition）。
// True や False は 基本要素（base case）
// Add, If は 再帰ステップ（inductive case）
// 「有限回の適用で作れるすべてのもの」＝ 最小閉集合
// これが “最小の閉包 (least fixed point)”
// ＝ Milewski本で言う μF（初代数）に相当します。

// --- ASTタグ（Term）
export const TermTag = {
  True: "true",
  False: "false",
  If: "if",
  Number: "number",
  Add: "add",
} as const;

// --- 型タグ（対象言語の型）
export const TypeTag = {
  Boolean: "Boolean",
  Number: "Number",
} as const;

// --- 値タグ（評価結果の表現：対象言語の値を構造体で保持）
// export const ValueTag = {
//   Boolean: "BoolValue",
//   Number: "NumValue",
// } as const;

// --- Resultタグ
export const ResultTag = {
  Ok: "Ok",
  Err: "Err",
} as const;

// // --- プリティプリント用の語句・記号
// export const KW = {
//     true: "true",
//     false: "false",
//     if: "if",
//     then: "then",
//     else: "else",
// } as const;
//
// export const SYM = {
//     plus: "+",
//     lpar: "(",
//     rpar: ")",
// } as const;
//
// // --- JSの typeof で使う型名（生文字列を排除）
// export const JsType = {
//     Number: "number",
//     Boolean: "boolean",
// } as const;

// --- エラーコード（内部識別子）
export const ErrorCode = {
  IfCondNotBoolean: "IfCondNotBoolean",
  IfBranchesMismatch: "IfBranchesMismatch",
  RuntimeAddType: "RuntimeAddType",
  RuntimeIfType: "RuntimeIfType",
  Unreachable: "Unreachable",
} as const;
export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

// --- エラーメッセージ（表示用）
export const Messages: Record<ErrorCode, string> = {
  [ErrorCode.IfCondNotBoolean]: "boolean expected",
  [ErrorCode.IfBranchesMismatch]: "then and else have different types",
  [ErrorCode.RuntimeAddType]: "number expected",
  [ErrorCode.RuntimeIfType]: "boolean expected",
  [ErrorCode.Unreachable]: "unreachable",
};

// ====== 2) AST / Type / Value / Result =================================

export type Term =
  | { tag: typeof TermTag.True }
  | { tag: typeof TermTag.False }
  | { tag: typeof TermTag.If; cond: Term; thn: Term; els: Term }
  | { tag: typeof TermTag.Number; n: number }
  | { tag: typeof TermTag.Add; left: Term; right: Term };

export type Type =
  | { tag: typeof TypeTag.Boolean }
  | { tag: typeof TypeTag.Number };

// export type Value =
//   | { tag: typeof ValueTag.Boolean; value: boolean }
//   | { tag: typeof ValueTag.Number; value: number };

export type Err<E> = { tag: typeof ResultTag.Err; error: ReadonlyArray<E> };
export type Ok<A> = { tag: typeof ResultTag.Ok; value: A };
export type Result<A, E> = Ok<A> | Err<E>;

export const ok = <A>(value: A): Result<A, never> => ({ tag: ResultTag.Ok, value } as const);
export const err = <E>(...es: E[]): Result<never, E> => ({ tag: ResultTag.Err, error: es } as const);

export const isErr = <A, E>(r: Result<A, E>): r is Err<E> => r.tag === ResultTag.Err;
export const isOk = <A, E>(r: Result<A, E>): r is Ok<A> => r.tag === ResultTag.Ok;

// ====== 3) map2（ts-pattern版：エラー配列を結合）=======================

type Res<A, E> = Result<A, E>;
type Pair<A, B, E> = readonly [Res<A, E>, Res<B, E>];

export const map2 = <A, B, C, E>(
  ra: Res<A, E>,
  rb: Res<B, E>,
  f: (a: A, b: B) => C,
): Res<C, E> =>
  match<Pair<A, B, E>>([ra, rb] as const)
    .with(
      [P.when(isErr), P.when(isErr)],
      ([ea, eb]) => ({ tag: ResultTag.Err, error: [...ea.error, ...eb.error] as const }),
    )
    .with([P.when(isErr), P.when(isOk)], ([ea]) => ea)
    .with([P.when(isOk), P.when(isErr)], ([, eb]) => eb)
    .with([P.when(isOk), P.when(isOk)], ([a, b]) => ok(f(a.value, b.value)))
    .otherwise((x) => {
      throw new Error(`non-exhaustive match: ${JSON.stringify(x)}`);
    });

// ====== 4) fold（catamorphism：再帰の形を一箇所に集約）=================

// 2️⃣ 構造的帰納法（Structural Induction）
// TAPLで言っていること
//
// 「帰納的に定義されたものの性質を証明したければ、“構造ごとに場合分け”して証明する。」
//
// たとえば次の性質を証明したい：
//
// P(t): 「任意の Term t について、ノード数は有限である」
//
// 帰納法のやり方
//
// 基本ケース: True, False, Number は明らかに有限。
//
// 帰納ステップ: Add(left, right) のとき
// 左右が有限 → 和も有限。
//
// 他の構築子も同様。
// これが「構造的帰納法の計算的側面」＝ 構造的再帰 (structural recursion)。
// function isFiniteTerm(t: Term): boolean {
//     switch (t.tag) {
//         case TermTag.True:
//         case TermTag.False:
//         case TermTag.Number:
//             return true; // 基底
//         case TermTag.Add:
//             return isFiniteTerm(t.left) && isFiniteTerm(t.right); // 帰納ステップ
//         case TermTag.If:
//             return (
//                 isFiniteTerm(t.cond) &&
//                 isFiniteTerm(t.thn) &&
//                 isFiniteTerm(t.els)
//             );
//     }
// }

// 3️⃣ 構造的再帰（Structural Recursion）
//
// TAPLではこう説明されます：
//
// 帰納的定義に対応して、再帰関数を「構造に従って」書けば、
// その関数は停止するし、全域的に定義される。

// 各ケースで再帰が子構造にのみ進む（小さくなる）
//
// 構造が有限 → 再帰も有限
// → 停止性 (termination) が保証される。

type TermAlg<A> = {
  True: () => A;
  False: () => A;
  Number: (n: number) => A;
  Add: (l: A, r: A) => A;
  If: (c: A, t: A, e: A) => A;
};

// export function foldTerm<A>(alg: TermAlg<A>, t: Term): A {
//   switch (t.tag) {
//     case TermTag.True:
//       return alg.True();
//     case TermTag.False:
//       return alg.False();
//     case TermTag.Number:
//       return alg.Number(t.n);
//     case TermTag.Add: {
//       const l = foldTerm(alg, t.left);
//       const r = foldTerm(alg, t.right);
//       return alg.Add(l, r);
//     }
//     case TermTag.If: {
//       const c = foldTerm(alg, t.cond);
//       const th = foldTerm(alg, t.thn);
//       const el = foldTerm(alg, t.els);
//       return alg.If(c, th, el);
//     }
//   }
// }

// 4️⃣ 停止性 (Termination) と 全域性 (Totality)
//
// TAPL 3.5–3.6節の主張：
//
// 構造的再帰 は必ず停止する。
//
// 全域的（total）：すべての Term に結果を返す。
//
// 部分関数（partial） ではない。

// size は必ず停止して数値を返す
//
// 入力に対応しないパターンが存在しない（網羅的）
// → 全域・停止的
//
// これが TAPLでいう “構造的再帰 = 全域停止関数”。

// function size(t: Term): number {
//     switch (t.tag) {
//         case TermTag.True:
//         case TermTag.False:
//         case TermTag.Number:
//             return 1;
//         case TermTag.Add:
//             return 1 + size(t.left) + size(t.right);
//         case TermTag.If:
//             return 1 + size(t.cond) + size(t.thn) + size(t.els);
//     }
// }

// 5️⃣ foldTerm の理論的意味
//
// TAPL第3章の「構造的再帰」を関数合成的に一般化すると
// Milewski本の “catamorphism” になります。
//
// つまり：
//
// TAPLの言葉	あなたのコード	圏論的名称
// 構造的再帰	foldTerm	catamorphism
// 構造的帰納法	foldTerm の停止性・正しさの証明法	構造的 induction
// 帰納的定義	Term 型	初代数 μF

//6️⃣ TAPLがここで伝えたいコアメッセージ
//
// 🧠 「“構造”を基準に定義されたデータに対しては、
// 構造を基準に再帰を書くことで、常に安全・停止・正しい関数が作れる。」
//
// これが後の「型検査器」「評価器」などすべての基盤になります。

// 7️⃣ まとめ表
// TAPLの概念	TypeScriptでの対応	安全性保証
// 帰納的定義	type Term = ...	有限構造
// 構造的帰納法	switch (t.tag) による全ケース分解	網羅性
// 造的再帰	foldTerm	停止性・全域性
// 型安全性の証明の準備	typecheck を foldTerm ベースで書く
//
// ====== 45
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
/* ============================================================
   評価器（evaluate）は一旦コメントアウト中
============================================================ */

// // ====== 5) 評価器（Value もタグ管理でJS値に依存しない）=================
// const evalAlg: TermAlg<Value> = {
//   True: () => ({ tag: ValueTag.Boolean, value: true }),
//   False: () => ({ tag: ValueTag.Boolean, value: false }),
//   Number: (n) => ({ tag: ValueTag.Number, value: n }),
//   Add: (l, r) => {
//     if (l.tag !== ValueTag.Number || r.tag !== ValueTag.Number) {
//       throw new Error(Messages[ErrorCode.RuntimeAddType]);
//     }
//     return { tag: ValueTag.Number, value: l.value + r.value } as const;
//   },
//   If: (c, t, e) => {
//     if (c.tag !== ValueTag.Boolean) {
//       throw new Error(Messages[ErrorCode.RuntimeIfType]);
//     }
//     return c.value ? t : e;
//   },
// };
// export const evaluate = (t: Term): Value => foldTerm(evalAlg, t);

/* ============================================================
   プリティプリンタ（pretty）も一旦コメントアウト中
============================================================ */

// // ====== 6) プリティプリンタ（語句/記号はKW/SYMから）====================
// const printAlg: TermAlg<string> = {
//   True: () => KW.true,
//   False: () => KW.false,
//   Number: (n) => String(n),
//   Add: (l, r) => `${SYM.lpar}${l} ${SYM.plus} ${r}${SYM.rpar}`,
//   If: (c, t, e) => `${KW.if} ${c} ${KW.then} ${t} ${KW.else} ${e}`,
// };
// export const pretty = (t: Term): string => foldTerm(printAlg, t);

// ====== 7) 型検査器 =====================================================

// const sameType = (a: Type, b: Type) => a.tag === b.tag;

const errsOf = <A>(r: Result<A, ErrorCode>) => r.tag === ResultTag.Err ? r.error : ([] as ErrorCode[]);

const typecheckAlg: TermAlg<Result<Type, ErrorCode>> = {
  True: () => ok({ tag: TypeTag.Boolean }),
  False: () => ok({ tag: TypeTag.Boolean }),
  Number: () => ok({ tag: TypeTag.Number }),

  Add: (lt, rt) =>
    map2(lt, rt, (l, r) => {
      if (l.tag !== TypeTag.Number || r.tag !== TypeTag.Number) {
        throw new Error(Messages[ErrorCode.Unreachable]);
      }
      return { tag: TypeTag.Number } as Type;
    }),

  If: (rc, rt, re) => {
    const all = [
      ...errsOf(rc),
      ...errsOf(rt),
      ...errsOf(re),
      ...(rc.tag === ResultTag.Ok && rc.value.tag !== TypeTag.Boolean ? [ErrorCode.IfCondNotBoolean] : []),
      ...(rt.tag === ResultTag.Ok && re.tag === ResultTag.Ok && rt.value.tag !== re.value.tag
        ? [ErrorCode.IfBranchesMismatch]
        : []),
    ];

    if (all.length) return err(...all);

    // ここまで来たら: rcはOk(Boolean)、rt/reはいずれかOk（かつ同型保障済み）
    if (rt.tag === ResultTag.Ok) return ok(rt.value);
    if (re.tag === ResultTag.Ok) return ok(re.value);
    // 到達しないはず
    throw new Error(Messages[ErrorCode.Unreachable]);
  },
};

// 以前:
// 成功は Type をそのまま、失敗は Err<ErrorCode> を返す型
// export type TypecheckOut = Type | Err<ErrorCode>;
// export const typecheck = (t: Term): TypecheckOut => { ... };

/**
 * 型検査：当面は True/False/Number/Add/If のみ
 * 将来的に Var/Func/Call/Seq/Const を扱うときのため env を受け取れるようにしておく。
 * 既存呼び出しには影響なし（第2引数省略可）。
 */
export function typecheck(t: Term, env: TypeEnv = emptyEnv): Type {
  // env は現状未使用（Var/Func 等を実装するときに利用）
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
      if (T.out.tag !== E.out.tag) {
        error(Messages[ErrorCode.IfBranchesMismatch], self);
      }
      return T.out;
    },
  }, t);
}

// export const formatErrors = (errs: ReadonlyArray<ErrorCode>) => errs.map((e) => Messages[e]);

// ====== 2.5) 型環境 ================================================

// 変数名 -> 型 の写像（将来 Var/Func/Call/Seq/Const で使用）
export type TypeEnv = Readonly<Record<string, Type>>;

// 空環境（外から注入しない限りは空でスタート）
export const emptyEnv: TypeEnv = Object.freeze({});

// 参照・更新ヘルパ（永続的＝元を破壊しない）
export const envGet = (env: TypeEnv, name: string): Type | undefined => env[name];
export const envSet = (env: TypeEnv, name: string, ty: Type): TypeEnv => ({ ...env, [name]: ty });
export const envExtend = (env: TypeEnv, entries: ReadonlyArray<readonly [string, Type]>): TypeEnv =>
  entries.reduce((e, [k, v]) => ({ ...e, [k]: v }), env);

// ====== 6) 動作テスト（例）==============================================
//
// const examples = [
//   "true",
//   "false",
//   "true ? 1 : 2",
//   "1",
//   "1 + 2",
//   "true ? 1 : true", // ← then and else have different types
//   "true + 1", // ← number expected
//   "1 + true", // ← number expected
// ];
//
// for (const code of examples) {
//   const term = parseArith(code) as Term;
//   try {
//     const ty = typecheck(term);
//     console.log(`${code} :: ${ty.tag}`);
//   } catch (e) {
//     console.error(`${code} => ${(e as Error).message}`);
//   }
// }
