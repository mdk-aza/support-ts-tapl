import test from "node:test";
import assert from "node:assert";
import * as fc from "npm:fast-check";

import {parseArith, typeShow} from "npm:tiny-ts-parser";
import {typecheck} from "./arith.ts";

function run(code: string) {
  return typecheck(parseArith(code));
}
function ok(expected: string, code: string) {
  assert.equal(expected, typeShow(run(code)));
}
function ng(expected: RegExp, code: string) {
  assert.throws(() => {
    run(code);
    return true;
  }, expected);
}

test("true", () => ok("boolean", `true`));
test("false", () => ok("boolean", `false`));
test("if", () => ok("number", `true ? 1 : 2`));
test("if error", () => ng(/test.ts:1:1-1:16 then and else have different types/, `true ? 1 : true`));

test("number", () => ok("number", `1`));
test("add", () => ok("number", `1 + 2`));
test("add error 1", () => ng(/test.ts:1:1-1:5 number expected/, `true + 1`));
test("add error 2", () => ng(/test.ts:1:5-1:9 number expected/, `1 + true`));

//以下からは追加テストケース
test("property: すべての整数リテラルは number 型になる", () => {
  fc.assert(
    fc.property(fc.nat(), (n) => { // fc.integer() → fc.nat()
      const code = `${n}`;
      const ty = typeShow(typecheck(parseArith(code)));
      assert.equal(ty, "number");
    }),
  );
});

test("property: 任意の (number + number) は number 型になる", () => {
  fc.assert(
    fc.property(fc.nat(), fc.nat(), (a, b) => { // fc.integer() → fc.nat()
      const code = `${a} + ${b}`;
      const ty = typeShow(typecheck(parseArith(code)));
      assert.equal(ty, "number");
    }),
  );
});

test("property: (true ? x : y) は x,y の型が一致すれば型エラーにならない", () => {
  fc.assert(
    fc.property(fc.boolean(), fc.nat(), fc.nat(), (cond, x, y) => { // fc.integer() → fc.nat()
      const code = `${cond} ? ${x} : ${y}`;
      const ty = typeShow(typecheck(parseArith(code)));
      assert.equal(ty, "number");
    }),
  );
});
