import { describe, expect, test } from "bun:test";
import {
  collapseJsonValues,
  computeRemovedKeys,
  envToJson,
  expandJsonValue,
  findCollisions,
  formatEnvValue,
  jsonToEnv,
  parseEnvContent,
  resolveType,
  stringifyJsonValue,
  validateBulkImportJson,
} from "./bulkImport";

function roundTrip(value: string): string | number | boolean | undefined {
  const env = jsonToEnv(JSON.stringify([{ key: "KEY", value }]));
  return parseEnvContent(env)[0]?.value;
}

describe("env serialization", () => {
  test.each([
    ["multi-line value", "line one\nline two\nline three"],
    ["windows line endings", "a\r\nb"],
    ["embedded double quotes", 'say "hello"'],
    ["backslashes with spaces", "C:\\Program Files\\relic"],
    ["literal backslash-n with spaces", "keep \\n literal"],
    ["single-quoted text", "'quoted'"],
    ["hash sign", "abc#def"],
    ["leading and trailing spaces", "  padded  "],
    ["PEM key", "-----BEGIN KEY-----\nMIIB\\x/+==\n-----END KEY-----"],
    ["plain value", "simple"],
    ["empty value", ""],
    ["equals sign", "a=b=c"],
  ])("round-trips %s", (_, value) => {
    expect(roundTrip(value)).toBe(value);
  });

  test("writes multi-line values with real line breaks in single quotes", () => {
    const env = jsonToEnv(
      JSON.stringify([
        { key: "A", value: "x\ny" },
        { key: "B", value: "z" },
      ]),
    );
    expect(env.split("\n")).toEqual(["A='x", "y'", "B=z"]);
  });

  test("keeps pretty-printed JSON readable", () => {
    const json = JSON.stringify({ db: { host: "localhost", port: 5432 } }, null, 2);
    expect(formatEnvValue(json)).toBe(`'${json}'`);
    expect(roundTrip(json)).toBe(json);
  });

  test("falls back to escaped double quotes when a multi-line value has a single quote", () => {
    expect(formatEnvValue("it's\nhere")).toBe('"it\'s\\nhere"');
    expect(roundTrip("it's\nhere")).toBe("it's\nhere");
  });

  test("reads single-quoted values that span multiple lines", () => {
    const secrets = parseEnvContent("CONFIG='{\n  \"a\": 1  \n}'\nNEXT=1");
    expect(secrets.map((s) => [s.key, s.value])).toEqual([
      ["CONFIG", '{\n  "a": 1  \n}'],
      ["NEXT", "1"],
    ]);
  });

  test("reads an unterminated single quote as a literal single-line value", () => {
    const secrets = parseEnvContent("A='open\nB=2");
    expect(secrets.map((s) => [s.key, s.value])).toEqual([
      ["A", "'open"],
      ["B", "2"],
    ]);
  });

  test("escapes quotes and backslashes", () => {
    expect(formatEnvValue('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
  });

  test("unescapes standard dotenv sequences in double quotes", () => {
    const [secret] = parseEnvContent('KEY="a\\nb \\"c\\" \\\\d"');
    expect(secret?.value).toBe('a\nb "c" \\d');
  });

  test("treats unquoted and single-quoted values literally", () => {
    const secrets = parseEnvContent("A=foo\\nbar\nB='x\\ny'");
    expect(secrets.map((s) => s.value)).toEqual(["foo\\nbar", "x\\ny"]);
  });

  test("reads double-quoted values that span multiple lines", () => {
    const secrets = parseEnvContent('CERT="line1\nline2"\nNEXT=1');
    expect(secrets.map((s) => [s.key, s.value])).toEqual([
      ["CERT", "line1\nline2"],
      ["NEXT", "1"],
    ]);
  });

  test("ignores trailing text after a closing quote", () => {
    expect(parseEnvContent('KEY="value" # comment')[0]?.value).toBe("value");
  });
});

describe("nested JSON values", () => {
  const pretty = JSON.stringify({ db: { host: "localhost" } }, null, 2);

  test("expands object and array values but leaves other strings alone", () => {
    expect(expandJsonValue(pretty)).toEqual({ db: { host: "localhost" } });
    expect(expandJsonValue("[1,2]")).toEqual([1, 2]);
    expect(expandJsonValue("42")).toBe("42");
    expect(expandJsonValue("{not json")).toBe("{not json");
  });

  test("shows JSON values as nested objects in JSON mode", () => {
    const json = JSON.parse(envToJson(`CONFIG='${pretty}'\nPLAIN=x`));
    expect(json[0].value).toEqual({ db: { host: "localhost" } });
    expect(json[1].value).toBe("x");
  });

  test("keeps the original text when the nested value is unchanged", () => {
    const compactSpacing = '{ "a" : 1 }';
    const originals = new Map([["CONFIG", compactSpacing]]);
    expect(stringifyJsonValue({ a: 1 }, compactSpacing)).toBe(compactSpacing);
    const [item] = collapseJsonValues([{ key: "CONFIG", value: { a: 1 } }], originals) as Array<{
      value: string;
    }>;
    expect(item?.value).toBe(compactSpacing);
  });

  test("follows the original layout when the nested value changes", () => {
    expect(stringifyJsonValue({ a: 2 }, '{\n  "a": 1\n}')).toBe('{\n  "a": 2\n}');
    expect(stringifyJsonValue({ a: 2 }, '{"a":1}')).toBe('{"a":2}');
    expect(stringifyJsonValue({ a: 2 })).toBe('{"a":2}');
  });

  test("validates collapsed values as strings", () => {
    const result = validateBulkImportJson(
      collapseJsonValues([{ key: "CONFIG", value: { a: 1 }, type: "number" }]),
    );
    expect(result.valid).toBe(true);
    expect(result.secrets[0]).toMatchObject({ value: '{"a":1}', type: "string" });
  });

  test("round-trips through JSON mode back to .env without changing the value", () => {
    const originals = new Map([["CONFIG", pretty]]);
    const env = jsonToEnv(envToJson(`CONFIG='${pretty}'`), originals);
    expect(parseEnvContent(env)[0]?.value).toBe(pretty);
  });
});

describe("type preservation", () => {
  test("keeps the original type of existing keys", () => {
    const known = new Map([
      ["PORT", "string" as const],
      ["FLAG", "string" as const],
      ["COUNT", "number" as const],
    ]);
    const secrets = parseEnvContent("PORT=3000\nFLAG=true\nCOUNT=5\nNEW=42", known);
    expect(secrets.map((s) => [s.key, s.type])).toEqual([
      ["PORT", "string"],
      ["FLAG", "string"],
      ["COUNT", "number"],
      ["NEW", "number"],
    ]);
  });

  test("falls back to string when the value no longer fits the known type", () => {
    expect(resolveType("not-a-number", "number")).toBe("string");
    expect(resolveType("12", "number")).toBe("number");
    expect(resolveType("false", "boolean")).toBe("boolean");
  });

  test("envToJson uses known types", () => {
    const json = JSON.parse(envToJson("ZIP=02134", undefined, new Map([["ZIP", "string"]])));
    expect(json[0]).toMatchObject({ key: "ZIP", value: "02134", type: "string" });
  });
});

describe("findCollisions", () => {
  const existing = [
    { id: "s1", key: "API_KEY" },
    { id: "s2", key: "DB_URL" },
  ];

  test("ignores secrets that were loaded into the editor", () => {
    expect(findCollisions(["API_KEY", "DB_URL"], existing, new Set(["s1", "s2"]))).toEqual([]);
  });

  test("reports existing secrets the editor did not load", () => {
    expect(findCollisions(["API_KEY", "NEW"], existing, new Set(["s2"]))).toEqual([
      { key: "API_KEY", existingSecretId: "s1" },
    ]);
  });
});

describe("bulkImportValidator", () => {
  describe("validateBulkImportJson", () => {
    test("validates correct JSON structure", () => {
      const input = [
        { key: "API_KEY", value: "secret123", type: "string" },
        { key: "DEBUG", value: "true", type: "boolean" },
      ];
      const result = validateBulkImportJson(input);
      expect(result.valid).toBe(true);
      expect(result.secrets.length).toBe(2);
      expect(result.errors.length).toBe(0);
    });

    test("rejects non-array input", () => {
      const result = validateBulkImportJson({ key: "value" });
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toContain("array");
    });

    test("rejects empty array", () => {
      const result = validateBulkImportJson([]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toContain("No secrets");
    });

    test("rejects missing key field", () => {
      const result = validateBulkImportJson([{ value: "test", type: "string" }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.field).toBe("key");
    });

    test("rejects empty key", () => {
      const result = validateBulkImportJson([{ key: "", value: "test", type: "string" }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toContain("empty");
    });

    test("rejects invalid key format", () => {
      const result = validateBulkImportJson([
        { key: "invalid-key", value: "test", type: "string" },
      ]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toContain("letters, numbers");
    });

    test("allows underscore-prefixed keys", () => {
      const result = validateBulkImportJson([{ key: "_PRIVATE", value: "test", type: "string" }]);
      expect(result.valid).toBe(true);
    });

    test("rejects keys starting with numbers", () => {
      const result = validateBulkImportJson([{ key: "123KEY", value: "test", type: "string" }]);
      expect(result.valid).toBe(false);
    });

    test("detects duplicate keys within import", () => {
      const input = [
        { key: "API_KEY", value: "value1", type: "string" },
        { key: "OTHER", value: "value2", type: "string" },
        { key: "API_KEY", value: "value3", type: "string" },
      ];
      const result = validateBulkImportJson(input);
      expect(result.valid).toBe(false);
      expect(result.duplicateKeys).toContain("API_KEY");
    });

    test("rejects invalid type values", () => {
      const result = validateBulkImportJson([{ key: "KEY", value: "test", type: "invalid" }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.field).toBe("type");
    });

    test("accepts all valid types", () => {
      const input = [
        { key: "STR", value: "test", type: "string" },
        { key: "NUM", value: "123", type: "number" },
        { key: "BOOL", value: "true", type: "boolean" },
      ];
      const result = validateBulkImportJson(input);
      expect(result.valid).toBe(true);
    });

    test("allows empty values", () => {
      const result = validateBulkImportJson([{ key: "EMPTY", value: "", type: "string" }]);
      expect(result.valid).toBe(true);
    });
  });

  describe("computeRemovedKeys", () => {
    test("returns empty when keys are identical", () => {
      const result = computeRemovedKeys(["A", "B", "C"], ["A", "B", "C"]);
      expect(result).toEqual([]);
    });

    test("detects a single removed key", () => {
      const result = computeRemovedKeys(["A", "B", "C"], ["A", "C"]);
      expect(result).toEqual(["B"]);
    });

    test("detects all keys removed", () => {
      const result = computeRemovedKeys(["A", "B"], []);
      expect(result).toEqual(["A", "B"]);
    });

    test("returns empty when new keys are added but none removed", () => {
      const result = computeRemovedKeys(["A", "B"], ["A", "B", "C"]);
      expect(result).toEqual([]);
    });

    test("detects removed keys when new keys are also added", () => {
      const result = computeRemovedKeys(["A", "B", "C"], ["A", "D"]);
      expect(result).toEqual(["B", "C"]);
    });

    test("returns empty when both lists are empty", () => {
      const result = computeRemovedKeys([], []);
      expect(result).toEqual([]);
    });
  });
});
