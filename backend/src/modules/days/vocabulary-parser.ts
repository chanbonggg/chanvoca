import * as XLSX from "xlsx";

export type VocabularyCardInput = {
  sourceRow: number;
  term: string;
  meaning: string;
};

export type VocabularyParseResult =
  | { ok: true; sourceFormat: "xlsx" | "xls" | "csv"; cards: VocabularyCardInput[] }
  | { ok: false; code: string; message: string; rows?: number[] };

const maxRows = 5_000;
const maxTermLength = 200;
const maxMeaningLength = 1_000;

export function parseVocabularyFile(filename: string, content: Buffer): VocabularyParseResult {
  const sourceFormat = formatFromFilename(filename);
  if (!sourceFormat) return failure("UNSUPPORTED_FILE", "xlsx, xls, csv 파일만 업로드할 수 있습니다.");

  let workbook: XLSX.WorkBook;
  try {
    if (sourceFormat === "csv") {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      workbook = XLSX.read(text, { type: "string", raw: false });
    } else {
      if (!hasExpectedSignature(sourceFormat, content)) {
        return failure("INVALID_FILE", "파일 확장자와 실제 파일 형식이 일치하지 않습니다.");
      }
      workbook = XLSX.read(content, { type: "buffer", raw: false });
    }
  } catch {
    return failure(sourceFormat === "csv" ? "INVALID_UTF8_CSV" : "INVALID_FILE", sourceFormat === "csv" ? "CSV 파일은 UTF-8 인코딩이어야 합니다." : "엑셀 파일을 읽을 수 없습니다.");
  }

  const firstSheet = workbook.Sheets[workbook.SheetNames[0] ?? ""];
  if (!firstSheet) return failure("EMPTY_FILE", "읽을 수 있는 시트가 없습니다.");

  const rows = XLSX.utils.sheet_to_json<unknown[]>(firstSheet, { header: 1, blankrows: true, defval: "", raw: false })
    .map((row, index) => removeMergedPlaceholders(row, index, firstSheet["!merges"]));
  const hasHeader = isHeaderRow(rows[0] ?? []);
  const dataRows = rows.slice(hasHeader ? 1 : 0);
  if (dataRows.length > maxRows) return failure("TOO_MANY_ROWS", `데이터 행은 최대 ${maxRows.toLocaleString("ko-KR")}개까지 업로드할 수 있습니다.`);

  const cards: VocabularyCardInput[] = [];
  const invalidRows: number[] = [];

  dataRows.forEach((row, index) => {
    const sourceRow = index + (hasHeader ? 2 : 1);
    const term = cellText(row[0]);
    const meaning = cellText(row[1]);

    if (!term && !meaning) return;
    if (!term || !meaning || term.length > maxTermLength || meaning.length > maxMeaningLength) {
      invalidRows.push(sourceRow);
      return;
    }
    cards.push({ sourceRow, term, meaning });
  });

  if (invalidRows.length > 0) {
    return failure("INVALID_ROWS", "단어와 뜻을 모두 입력해야 하며 길이 제한을 지켜야 합니다.", invalidRows.slice(0, 20));
  }
  if (cards.length === 0) return failure("EMPTY_FILE", "저장할 단어가 없습니다.");

  return { ok: true, sourceFormat, cards };
}

function formatFromFilename(filename: string) {
  const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return extension === "xlsx" || extension === "xls" || extension === "csv" ? extension : null;
}

function cellText(value: unknown) {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function removeMergedPlaceholders(row: unknown[], rowIndex: number, merges: XLSX.Range[] | undefined) {
  const placeholderColumns = new Set<number>();
  for (const merge of merges ?? []) {
    if (merge.s.r <= rowIndex && rowIndex <= merge.e.r) {
      for (let column = merge.s.c + 1; column <= merge.e.c; column += 1) placeholderColumns.add(column);
    }
  }
  return row.filter((_, column) => !placeholderColumns.has(column));
}

function isHeaderRow(row: unknown[]) {
  const [term, meaning] = row.map(cellText);
  return ["word", "term", "english", "english word", "단어", "영단어"].includes(term.toLowerCase())
    && ["meaning", "definition", "뜻", "의미", "해석"].includes(meaning.toLowerCase());
}

function hasExpectedSignature(format: "xlsx" | "xls", content: Buffer) {
  if (format === "xlsx") return content.subarray(0, 2).toString("ascii") === "PK";
  return content.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
}

function failure(code: string, message: string, rows?: number[]): VocabularyParseResult {
  return { ok: false, code, message, ...(rows ? { rows } : {}) };
}
