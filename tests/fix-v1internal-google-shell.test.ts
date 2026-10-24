import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import { antigravityFrameView, rewrapAntigravityFrame } from "../src/util.ts";

// omp's google-antigravity provider streams v1internal frames, i.e. every
// Gemini chunk arrives wrapped in `{"response":{candidates,...}}`. The plugin
// passthrough used to read top-level `candidates`/`usageMetadata` only, so a
// perfectly terminated shelled turn looked like "no terminal event ever seen"
// and the client got the in-band truncation error instead of the answer.

function makeRes(chunks: string[]) {
    return {
        writes: chunks,
        write(b: Buffer | string) {
            chunks.push(typeof b === "string" ? b : b.toString("utf8"));
            return true;
        },
        end(b?: Buffer | string) {
            if (b !== undefined) chunks.push(typeof b === "string" ? b : b.toString("utf8"));
        },
        once() {},
        destroyed: false,
        writableEnded: false,
    } as unknown as ServerResponse;
}

function streamOf(events: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
            } else {
                controller.close();
            }
        },
    });
}

const shelled = (inner: Record<string, unknown>) => `data: ${JSON.stringify({ response: inner, traceId: "t-1" })}\n\n`;
const plain = (inner: Record<string, unknown>) => `data: ${JSON.stringify(inner)}\n\n`;

const textFrame = (text: string) => shelled({ candidates: [{ index: 0, content: { role: "model", parts: [{ text }] } }] });
const finishFrame = (reason: string) => shelled({ candidates: [{ index: 0, finishReason: reason }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3, totalTokenCount: 14 } });

function frames(writes: string[]): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const w of writes) {
        for (const frame of w.split("\n\n")) {
            const m = frame.match(/^data: (.*)$/m);
            if (!m) continue;
            try {
                out.push(JSON.parse(m[1]!) as Record<string, unknown>);
            } catch {
                /* not a JSON frame */
            }
        }
    }
    return out;
}

function hasTruncation(writes: string[]): boolean {
    return frames(writes).some((ev) => {
        const err = ev["error"] as Record<string, unknown> | undefined;
        return !!err && (err["status"] === "UNAVAILABLE" || err["message"] === "upstream stream ended before a completion event; this turn may be incomplete");
    });
}

test("frame view: shelled payload is inspected inside `response`, plain bodies unchanged", () => {
    const inner = { candidates: [{ finishReason: "STOP" }] };
    const shelledFrame = { response: inner, traceId: "t" };
    const a = antigravityFrameView(shelledFrame);
    assert.equal(a.view, inner);
    assert.equal(a.shell, shelledFrame);
    assert.deepEqual(rewrapAntigravityFrame(a.shell, { candidates: [] }), { response: { candidates: [] }, traceId: "t" });

    const b = antigravityFrameView(inner);
    assert.equal(b.view, inner);
    assert.equal(b.shell, undefined);
    assert.deepEqual(rewrapAntigravityFrame(b.shell, { candidates: [] }), { candidates: [] });
});

test("chat pipe (google, v1internal shell): a terminated shelled turn is forwarded, not reported as a truncation", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([textFrame("hello"), finishFrame("STOP")]),
        makeRes(out),
        "google",
    );
    const parsed = frames(out);
    assert.equal(hasTruncation(out), false, "no in-band truncation for a stream that ended with finishReason");
    const text = parsed
        .map((ev) => ((ev["response"] as Record<string, unknown> | undefined)?.["candidates"] as Array<Record<string, unknown>> | undefined)?.[0])
        .map((c) => ((c?.["content"] as Record<string, unknown> | undefined)?.["parts"] as Array<Record<string, unknown>> | undefined)?.[0]?.["text"])
        .filter((t): t is string => typeof t === "string")
        .join("");
    assert.equal(text, "hello");
    // The shell is preserved on every forwarded frame: the client reads `response`.
    assert.ok(parsed.every((ev) => typeof ev["response"] === "object"));
    assert.equal((((parsed.at(-1)!["response"] as Record<string, unknown>)["candidates"] as Array<Record<string, unknown>>)[0]!)["finishReason"], "STOP");
});

test("chat pipe (google, v1internal shell): a cut before any finishReason still reports the truncation", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([textFrame("partial")]),
        makeRes(out),
        "google",
    );
    assert.equal(hasTruncation(out), true, "a shelled stream without finishReason must keep the truncation signal");
});

test("chat pipe (google, plain body): control — unchanged behaviour without a shell", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([plain({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "hi" }] } }] }), plain({ candidates: [{ index: 0, finishReason: "STOP" }] })]),
        makeRes(out),
        "google",
    );
    assert.equal(hasTruncation(out), false);
    assert.ok(frames(out).every((ev) => ev["response"] === undefined));
});
