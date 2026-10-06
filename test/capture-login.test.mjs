import assert from "node:assert/strict";
import { test } from "node:test";
import { encodePassword } from "../scripts/login.mjs";

// Expected values computed independently from the algorithm in
// huawei-lte-api (User._encode_password), not from this implementation.
test("password_type 4 matches the reference algorithm", () => {
  assert.equal(
    encodePassword(4, "admin", "secret", "tok123"),
    "NDAxZWVmOWNiMTA3MzBjNjkwN2YzZGU1NTQ1ODUzY2JjNzg2MzIwNmUzZWQzNzY1MjRkYWRlMTk4YjY2Yjk0Nw==",
  );
});

test("password_type 4 handles non-ASCII passwords as UTF-8", () => {
  assert.equal(
    encodePassword(4, "user", "pässword!", "abcDEF=="),
    "ZjAyYTM0NDZmNTUwMGRiMGFlNDhjYmE4NDBkMWUzMjJlZTliMDMyZGI3MjEwOWExYjlhOGFkNTVmMDNhYjg4Nw==",
  );
});

test("password_type 0 is base64 of the password", () => {
  assert.equal(encodePassword(0, "admin", "secret", "ignored"), "c2VjcmV0");
});

test("password_type 3 follows the reference client and uses base64", () => {
  assert.equal(encodePassword(3, "admin", "secret", "ignored"), "c2VjcmV0");
});

test("an unknown password_type is refused rather than guessed", () => {
  assert.throws(
    () => encodePassword(9, "admin", "secret", "tok"),
    /password_type/,
  );
});

test("an empty password encodes to an empty string", () => {
  assert.equal(encodePassword(4, "admin", "", "tok"), "");
});
