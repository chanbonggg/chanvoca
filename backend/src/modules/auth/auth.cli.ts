import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { createDatabase } from "../../shared/db.js";
import { createInvite, hashPassword, loginId, setupOwner, tokenHash } from "./auth.js";

async function passwordInput() {
  if (!process.stdin.isTTY) {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 2048) throw new Error("Password input too long.");
    }
    return input.replace(/\r?\n$/, "");
  }
  process.stderr.write("비밀번호 (6~128자): ");
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let input = "";
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n" || character === "\u0003") {
          process.stdin.off("data", onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stderr.write("\n");
          if (character === "\u0003") reject(new Error("Cancelled."));
          else resolve(input);
          return;
        }
        if (character === "\u007f" || character === "\b") input = [...input].slice(0, -1).join("");
        else input += character;
        if (input.length > 2048) { process.stdin.off("data", onData); process.stdin.setRawMode(false); process.stdin.pause(); reject(new Error("Password input too long.")); return; }
      }
    };
    process.stdin.on("data", onData);
  });
}
export async function main() {
  const [action, rawId] = process.argv.slice(2);
  const sql = createDatabase();
  try {
    if (action === "invite") {
      console.log(await createInvite(sql));
    } else if (action === "cancel-invite") {
      const input = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const code = await input.question("취소할 초대 코드: ");
        await sql`UPDATE auth_invites SET revoked_at = now() WHERE token_hash = ${tokenHash(code)}`;
        console.log("초대를 취소했습니다.");
      } finally { input.close(); }
    } else if (action === "setup" || action === "reset-password") {
      const id = loginId(rawId);
      if (!id) throw new Error("Provide a valid login ID.");
      const hashed = await hashPassword(await passwordInput());
      await sql.begin(async (tx) => {
        if (action === "setup") { await setupOwner(tx, id, hashed); return; }
        const users = await tx<{ user_id: string }[]>`UPDATE auth_credentials SET password_hash = ${hashed} WHERE login_id = ${id} RETURNING user_id`;
        if (!users[0]) throw new Error("Account not found.");
        await tx`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = ${users[0].user_id} AND revoked_at IS NULL`;
      });
      console.log(action === "setup" ? "기존 데이터에 계정을 연결했습니다." : "비밀번호를 변경하고 모든 로그인을 해제했습니다.");
    } else throw new Error("Usage: auth.cli.js setup <id> | invite | cancel-invite | reset-password <id>");
  } finally { await sql.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("계정 작업에 실패했습니다. 입력과 DB 상태를 확인하세요. 기존 데이터는 삭제하지 않습니다."); process.exitCode = 1; });
}
