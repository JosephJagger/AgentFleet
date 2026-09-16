import { describe, expect, it } from "vitest";
import { ATTACHMENT_ACCEPT, validateAttachmentBytes } from "./file-drafts";

const safeXlsx = "UEsDBBQAAAAIAO9yMF3HHBc8CgAAAAgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbLMJqSxILda3AwBQSwMEFAAAAAgA73IwXYLZHNUSAAAAEAAAAAsAAABfcmVscy8ucmVsc7MJSs1JLMnMzyvOyCwo1rcDAFBLAwQUAAAACADvcjBdzp6YEw0AAAALAAAADwAAAHhsL3dvcmtib29rLnhtbLMpzy/KTsrPz9a3AwBQSwECFAMUAAAACADvcjBdxxwXPAoAAAAIAAAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIAO9yMF2C2RzVEgAAABAAAAALAAAAAAAAAAAAAACAATsAAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIAO9yMF3OnpgTDQAAAAsAAAAPAAAAAAAAAAAAAACAAXYAAAB4bC93b3JrYm9vay54bWxQSwUGAAAAAAMAAwC3AAAAsAAAAAAA";

function decode(value: string): Uint8Array { const binary = atob(value); return Uint8Array.from(binary, character => character.charCodeAt(0)); }

describe("secure binary attachments", () => {
  it("offers PDF and XLSX and validates their real contents", () => {
    expect(ATTACHMENT_ACCEPT).toContain(".pdf");
    expect(ATTACHMENT_ACCEPT).toContain(".xlsx");
    expect(() => validateAttachmentBytes(new TextEncoder().encode("%PDF-1.7\n%%EOF\n"), "guide.pdf")).not.toThrow();
    expect(() => validateAttachmentBytes(decode(safeXlsx), "book.xlsx")).not.toThrow();
    expect(() => validateAttachmentBytes(new TextEncoder().encode("renamed"), "guide.pdf")).toThrow(/格式/);
    expect(() => validateAttachmentBytes(new TextEncoder().encode("PK fake"), "book.xlsx")).toThrow(/格式/);
  });
});
