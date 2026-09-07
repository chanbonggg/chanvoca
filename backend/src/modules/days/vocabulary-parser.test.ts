import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";

import { parseVocabularyFile } from "./vocabulary-parser.js";

test("parses UTF-8 CSV and preserves duplicate cards", () => {
  const result = parseVocabularyFile("today.csv", Buffer.from("word,meaning\ncalm,침착한\ncalm,평온한\n", "utf8"));

  assert.deepEqual(result, {
    ok: true,
    sourceFormat: "csv",
    cards: [
      { sourceRow: 2, term: "calm", meaning: "침착한" },
      { sourceRow: 3, term: "calm", meaning: "평온한" },
    ],
  });
});

test("parses the first worksheet of an xlsx file", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["word", "meaning"], ["steady", "꾸준한"]]), "Words");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["ignored", "무시"]]), "Ignored");
  const result = parseVocabularyFile("today.xlsx", XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));

  assert.deepEqual(result, {
    ok: true,
    sourceFormat: "xlsx",
    cards: [{ sourceRow: 2, term: "steady", meaning: "꾸준한" }],
  });
});

test("parses horizontally merged word and meaning columns without a header", () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["resume", "", "이력서", ""], ["vacancy", "", "공석", ""]]);
  sheet["!merges"] = [
    XLSX.utils.decode_range("A1:B1"), XLSX.utils.decode_range("C1:D1"),
    XLSX.utils.decode_range("A2:B2"), XLSX.utils.decode_range("C2:D2"),
  ];
  XLSX.utils.book_append_sheet(workbook, sheet, "Words");

  const result = parseVocabularyFile("merged.xlsx", XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));

  assert.deepEqual(result, {
    ok: true,
    sourceFormat: "xlsx",
    cards: [
      { sourceRow: 1, term: "resume", meaning: "이력서" },
      { sourceRow: 2, term: "vacancy", meaning: "공석" },
    ],
  });
});

test("parses an xls file", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["word", "meaning"], ["adapt", "적응하다"]]), "Words");
  const result = parseVocabularyFile("today.xls", XLSX.write(workbook, { type: "buffer", bookType: "biff8" }));

  assert.deepEqual(result, {
    ok: true,
    sourceFormat: "xls",
    cards: [{ sourceRow: 2, term: "adapt", meaning: "적응하다" }],
  });
});

test("rejects the entire file when a partial row exists", () => {
  const result = parseVocabularyFile("today.csv", Buffer.from("word,meaning\ncalm,침착한\nempty,\n", "utf8"));

  assert.deepEqual(result, {
    ok: false,
    code: "INVALID_ROWS",
    message: "단어와 뜻을 모두 입력해야 하며 길이 제한을 지켜야 합니다.",
    rows: [3],
  });
});

test("rejects non UTF-8 CSV", () => {
  const result = parseVocabularyFile("today.csv", Buffer.from([0xff, 0xfe, 0x61]));

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "INVALID_UTF8_CSV");
});
