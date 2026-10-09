import { test } from "node:test";
import assert from "node:assert/strict";
import { rewrapAntigravityEnvelope, unwrapAntigravityEnvelope } from "../src/util.ts";

const ENVELOPED: Record<string, unknown> = {
    project: "proj-123",
    model: "gemini-3.8-flash",
    request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        systemInstruction: { parts: [{ text: "sys" }] },
        sessionId: "sess-9",
    },
};

test("unwrapAntigravityEnvelope: omp antigravity envelope yields the inner request + shell", () => {
    const { inner, shell } = unwrapAntigravityEnvelope(ENVELOPED);
    assert.ok(shell, "shell captured");
    assert.equal(shell.project, "proj-123");
    assert.equal(shell.model, "gemini-3.8-flash");
    const req = inner as Record<string, unknown>;
    assert.ok(Array.isArray(req.contents), "inner request has contents");
    assert.equal((req.contents as unknown[]).length, 1);
    assert.equal(req.sessionId, "sess-9", "inner fields preserved");
});

test("unwrapAntigravityEnvelope: plain google body (top-level contents) untouched", () => {
    const plain = { contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { temperature: 0.2 } };
    const { inner, shell } = unwrapAntigravityEnvelope(plain);
    assert.equal(shell, undefined, "no shell for plain google body");
    assert.equal(inner, plain, "parsed body returned as-is");
});

test("unwrapAntigravityEnvelope: envelope without request.contents untouched", () => {
    const weird = { project: "p", model: "m", request: { notContents: true } };
    const { inner, shell } = unwrapAntigravityEnvelope(weird);
    assert.equal(shell, undefined);
    assert.equal(inner, weird);
});

test("unwrapAntigravityEnvelope: non-object / array input untouched", () => {
    assert.equal(unwrapAntigravityEnvelope(null).inner, null);
    assert.equal(unwrapAntigravityEnvelope("str").inner, "str");
    const arr = [1, 2];
    assert.equal(unwrapAntigravityEnvelope(arr).inner, arr, "array returned as-is");
    assert.equal(unwrapAntigravityEnvelope(arr).shell, undefined, "array: shell undefined");
});

test("rewrapAntigravityEnvelope: plain body passes through unchanged", () => {
    assert.equal(rewrapAntigravityEnvelope(undefined, "raw"), "raw");
});

test("rewrapAntigravityEnvelope: rebuilt google body goes back into the shell", () => {
    const rebuilt = JSON.stringify({
        contents: [{ role: "model", parts: [{ text: "compressed" }] }],
        systemInstruction: { parts: [{ text: "client system" }, { text: "compress prompt" }] },
    });
    const out = rewrapAntigravityEnvelope(ENVELOPED, rebuilt);
    assert.equal(typeof out, "string");
    const parsed = JSON.parse(out as string) as Record<string, unknown>;
    assert.equal(parsed.project, "proj-123", "project preserved");
    assert.equal(parsed.model, "gemini-3.8-flash", "model preserved");
    assert.equal("contents" in parsed, false, "no top-level contents in the envelope");
    const req = parsed.request as Record<string, unknown>;
    const contents = req.contents as Array<Record<string, unknown>>;
    assert.equal(contents.length, 1);
    assert.match(JSON.stringify(contents), /compressed/, "rebuilt body reached the request");
    assert.match(JSON.stringify(req.systemInstruction ?? {}), /compress prompt/, "systemInstruction rebuilt");
});

test("rewrapAntigravityEnvelope: Buffer body handled", () => {
    const out = rewrapAntigravityEnvelope(ENVELOPED, Buffer.from(JSON.stringify({ contents: [{ role: "user", parts: [] }] })));
    const parsed = JSON.parse(out.toString()) as Record<string, unknown>;
    assert.equal(parsed.project, "proj-123");
    assert.ok(Array.isArray((parsed.request as Record<string, unknown>).contents));
});

test("rewrapAntigravityEnvelope: invalid inner JSON falls back to the raw body", () => {
    const out = rewrapAntigravityEnvelope(ENVELOPED, "not-json");
    assert.equal(out, "not-json");
});
