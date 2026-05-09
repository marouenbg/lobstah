#!/usr/bin/env node
// Real integration test: send representative skill workloads through
// the lobstah router → AWS anchor and report which patterns work.
// Top 10 ClawHub skills are mostly "agent uses a CLI" by @steipete
// (weather, github, gog, sonoscli, nano-pdf, obsidian, ...). They
// share the same LLM workload shape, so we test the SHAPES rather
// than installing every skill individually.
//
// Tests run against http://127.0.0.1:17480 (the standalone router
// we have running with credit enforcement).

const ROUTER = process.env.LOBSTAH_ROUTER_URL ?? "http://127.0.0.1:17480";
const REQ_HDR = "x-lobstah-requester";

const ourPubkey = await fetch(`${ROUTER}/pubkey`).then((r) => r.json()).then((d) => d.pubkey);
console.log(`router pubkey: ${ourPubkey.slice(0, 24)}…`);
console.log(`(routing through ${ROUTER})`);
console.log("");

const tests = [];

const test = async (name, body, validate) => {
  process.stdout.write(`▸ ${name} ... `);
  const t0 = Date.now();
  try {
    const r = await fetch(`${ROUTER}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", [REQ_HDR]: ourPubkey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const elapsed = Math.round((Date.now() - t0) / 100) / 10;
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.log(`✗ HTTP ${r.status} (${elapsed}s)`);
      console.log(`  ${text.slice(0, 200)}`);
      tests.push({ name, ok: false, elapsed, reason: `HTTP ${r.status}` });
      return null;
    }
    const data = await r.json();
    const verdict = validate(data);
    if (verdict.ok) {
      console.log(`✓ (${elapsed}s) ${verdict.note ?? ""}`);
    } else {
      console.log(`✗ (${elapsed}s) ${verdict.reason}`);
    }
    tests.push({ name, ok: verdict.ok, elapsed, ...verdict });
    return data;
  } catch (e) {
    const elapsed = Math.round((Date.now() - t0) / 100) / 10;
    console.log(`✗ EXCEPTION (${elapsed}s) ${e.message}`);
    tests.push({ name, ok: false, elapsed, reason: e.message });
    return null;
  }
};

// Helper: extract content from Ollama-shaped response
const content = (d) => d?.message?.content ?? d?.choices?.[0]?.message?.content ?? "";

// ─── T1: Plain text completion (baseline, all skills need this) ───────
await test(
  "T1 — Plain text Q&A (baseline)",
  {
    model: "qwen2.5:7b",
    stream: false,
    messages: [{ role: "user", content: "Reply with one word: pong" }],
  },
  (d) => {
    const c = content(d).trim().toLowerCase();
    return c.includes("pong")
      ? { ok: true, note: `got "${c.slice(0, 40)}"` }
      : { ok: false, reason: `expected "pong", got "${c.slice(0, 80)}"` };
  },
);

// ─── T2: Long system prompt (~3k tokens — typical skill inject) ───────
const longSystem = `You are a helpful assistant with access to tools.
${"You should always think step by step before answering. ".repeat(80)}
When asked a question, respond concisely.`;
await test(
  "T2 — Long system prompt (skill-injected context)",
  {
    model: "qwen2.5:7b",
    stream: false,
    messages: [
      { role: "system", content: longSystem },
      { role: "user", content: "What is 7+5? Reply with just the number." },
    ],
  },
  (d) => {
    const c = content(d).trim();
    return c.includes("12")
      ? { ok: true, note: `system prompt was ~${longSystem.length} chars` }
      : { ok: false, reason: `expected "12" in answer, got "${c.slice(0, 80)}"` };
  },
);

// ─── T3: Tool-call (function calling) — github/gog/sonoscli pattern ──
await test(
  "T3 — Tool-call request (function calling)",
  {
    model: "qwen2.5:7b",
    stream: false,
    messages: [
      {
        role: "system",
        content:
          "You have access to a tool: get_weather(city: string). When the user asks about weather, respond with ONLY a JSON object like {\"tool\":\"get_weather\",\"args\":{\"city\":\"...\"}}. Do not write anything else.",
      },
      { role: "user", content: "What's the weather in Berlin?" },
    ],
  },
  (d) => {
    const c = content(d).trim();
    try {
      // Strip markdown code fences if present
      const stripped = c.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      const parsed = JSON.parse(stripped);
      if (parsed.tool === "get_weather" && parsed.args?.city) {
        return { ok: true, note: `parsed tool call: city="${parsed.args.city}"` };
      }
      return { ok: false, reason: `parsed but wrong shape: ${JSON.stringify(parsed).slice(0, 80)}` };
    } catch {
      return { ok: false, reason: `not valid JSON: ${c.slice(0, 100)}` };
    }
  },
);

// ─── T4: Multi-turn (skill uses agent state) ─────────────────────────
await test(
  "T4 — Multi-turn conversation",
  {
    model: "qwen2.5:7b",
    stream: false,
    messages: [
      { role: "user", content: "My favorite color is blue." },
      { role: "assistant", content: "Got it, your favorite color is blue." },
      { role: "user", content: "What did I say my favorite color was? One word." },
    ],
  },
  (d) => {
    const c = content(d).trim().toLowerCase();
    return c.includes("blue")
      ? { ok: true, note: `recalled context` }
      : { ok: false, reason: `did not recall "blue", got "${c.slice(0, 80)}"` };
  },
);

// ─── T5: JSON output mode (skills like github wanting structured data) ─
await test(
  "T5 — Structured JSON output",
  {
    model: "qwen2.5:7b",
    stream: false,
    messages: [
      {
        role: "user",
        content:
          "Return a JSON object with two fields: name (string) and answer (number). For: What is 2+2? Return ONLY the JSON, no other text.",
      },
    ],
  },
  (d) => {
    const c = content(d).trim();
    try {
      const stripped = c.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      const parsed = JSON.parse(stripped);
      if (typeof parsed.name === "string" && typeof parsed.answer === "number") {
        return parsed.answer === 4
          ? { ok: true, note: `JSON valid + answer correct` }
          : { ok: true, note: `JSON valid, answer=${parsed.answer} (not 4 but format works)` };
      }
      return { ok: false, reason: `wrong shape: ${JSON.stringify(parsed).slice(0, 80)}` };
    } catch {
      return { ok: false, reason: `not valid JSON: ${c.slice(0, 100)}` };
    }
  },
);

// ─── T6: Streaming response with usage chunk ─────────────────────────
process.stdout.write(`▸ T6 — Streaming response ... `);
const t0 = Date.now();
try {
  const r = await fetch(`${ROUTER}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", [REQ_HDR]: ourPubkey },
    body: JSON.stringify({
      model: "qwen2.5:7b",
      stream: true,
      messages: [{ role: "user", content: "count from 1 to 5" }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) {
    console.log(`✗ HTTP ${r.status}`);
    tests.push({ name: "T6", ok: false, elapsed: 0, reason: `HTTP ${r.status}` });
  } else {
    const text = await r.text();
    const events = text.split("\n\n").filter((e) => e.length > 0);
    const dataEvents = events.filter((e) => e.startsWith("data: "));
    const hasReceipt = events.some((e) => e.includes(":lobstah-receipt:"));
    const hasDone = events.some((e) => e.includes("[DONE]"));
    const elapsed = Math.round((Date.now() - t0) / 100) / 10;
    if (dataEvents.length >= 3 && hasDone) {
      console.log(`✓ (${elapsed}s) ${dataEvents.length} chunks, receipt=${hasReceipt}, [DONE]=${hasDone}`);
      tests.push({ name: "T6 — Streaming", ok: true, elapsed, note: `${dataEvents.length} chunks` });
    } else {
      console.log(`✗ (${elapsed}s) chunks=${dataEvents.length} receipt=${hasReceipt} done=${hasDone}`);
      tests.push({ name: "T6 — Streaming", ok: false, elapsed, reason: "incomplete stream" });
    }
  }
} catch (e) {
  console.log(`✗ EXCEPTION ${e.message}`);
  tests.push({ name: "T6 — Streaming", ok: false, elapsed: 0, reason: e.message });
}

// ─── Summary ──────────────────────────────────────────────────────────
console.log("");
console.log("─── Summary ────────────────────────────────────────────");
const passed = tests.filter((t) => t.ok).length;
console.log(`${passed}/${tests.length} tests passed`);
console.log("");
for (const t of tests) {
  const mark = t.ok ? "✓" : "✗";
  const detail = t.ok ? t.note ?? "" : `— ${t.reason}`;
  console.log(`${mark} ${t.name} (${t.elapsed}s) ${detail}`);
}

// Map back to which skills each test category covers.
console.log("");
console.log("─── Skill coverage ────────────────────────────────────");
const map = {
  "T1": "All 10 skills (baseline)",
  "T2": "Skills with verbose system prompts (skill-vetter, proactive-agent, self-improving-agent)",
  "T3": "Tool-call skills (github, gog, sonoscli, nano-pdf, obsidian, weather)",
  "T4": "Conversational skills with state (proactive-agent, self-improving-agent)",
  "T5": "Skills consuming structured output (github→gh-api, skill-vetter→reports)",
  "T6": "Skills wanting interactive feel (any chat session)",
};
for (const [k, v] of Object.entries(map)) {
  const t = tests.find((x) => x.name.startsWith(k));
  const mark = t?.ok ? "✓" : "✗";
  console.log(`${mark} ${k} → ${v}`);
}
