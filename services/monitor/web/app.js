// The monitor's public page. The "Verify in your browser" panel takes its
// result only from verifier.wasm, over data fetched directly from the log; the
// monitor's report is shown beside it, never used by it.

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") node.textContent = v;
    else if (k === "class") node.className = v;
    else if (k.startsWith("data-")) node.setAttribute(k, v);
    else node[k] = v;
  }
  node.append(...children);
  return node;
}

const short = (b64) => (b64 ? `${b64.slice(0, 16)}…` : "—");

function age(iso) {
  if (!iso || iso.startsWith("0001")) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s.toFixed(1)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

async function fetchText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

const config = await (await fetch("/config.json", { cache: "no-store" })).json();
const policies = new Map();

const verifierReady = (async () => {
  if (!config.wasm) throw new Error("this build has no verifier");
  const go = new Go();
  const started = performance.now();
  const { instance } = await WebAssembly.instantiateStreaming(
    fetch(`/${config.wasm}`),
    go.importObject,
  );
  void go.run(instance);
  document.body.dataset.wasmMs = String(Math.round(performance.now() - started));
  return globalThis.keelsonVerifier;
})();

// Checks ---------------------------------------------------------------------

const CHECKS = [
  ["checkpoint", "Checkpoint signatures and witness quorum, under the pinned policy"],
  ["consistency", "Consistency with the checkpoint this browser saw before"],
  ["inclusion", "Inclusion of the leaf in the tree"],
  ["leaf", "Leaf format"],
];

function resetChecks() {
  $("checks").replaceChildren(
    ...CHECKS.map(([id, label]) =>
      el("li", { "data-check": id, "data-status": "pending" }, el("span", { text: label })),
    ),
  );
  setVerdict("pending", "Verifying…");
}

function mark(id, status, detail) {
  const li = $("checks").querySelector(`[data-check="${id}"]`);
  li.dataset.status = status;
  li.querySelector(".detail")?.remove();
  li.lastChild.append(el("span", { class: "detail", text: detail }));
}

function setVerdict(state, text) {
  $("verdict").dataset.state = state;
  $("verdict").textContent = text;
}

const savedKey = (origin) => `keelson-monitor:checkpoint:${origin}`;

function readSaved(origin) {
  try {
    return localStorage.getItem(savedKey(origin));
  } catch {
    return null;
  }
}

function save(origin, note) {
  try {
    localStorage.setItem(savedKey(origin), note);
  } catch {
    // Storage is unavailable; the next visit starts without a saved checkpoint.
  }
}

// A saved checkpoint was verified before it was saved: its body is enough.
function savedTree(note) {
  const [, size, root] = note.split("\n");
  return { size: Number(size), root };
}

async function verify(origin, index) {
  resetChecks();
  const v = await verifierReady.catch((e) => {
    setVerdict("fail", `The verifier did not load: ${e.message}`);
  });
  if (!v) return;
  const started = performance.now();
  let failed = false;
  const fail = (id, e) => {
    failed = true;
    mark(id, "fail", e.message ?? String(e));
  };

  let note;
  let cp;
  try {
    if (!policies.has(origin.name)) policies.set(origin.name, await fetchText(`/${origin.policy}`));
    note = await fetchText(`${origin.url}checkpoint`);
    cp = await v.verifyCheckpoint(note, policies.get(origin.name));
    mark(
      "checkpoint",
      "ok",
      `size ${cp.size}, root ${short(cp.root)}, cosigned by ${cp.cosigners.join(", ")}`,
    );
  } catch (e) {
    fail("checkpoint", e);
    for (const id of ["consistency", "inclusion", "leaf"])
      mark(id, "skip", "needs a valid checkpoint");
    return finish(started, failed);
  }

  const saved = readSaved(origin.name);
  const old = saved ? savedTree(saved) : null;
  let oldSize = -1;
  if (!old) {
    mark(
      "consistency",
      "skip",
      "first visit from this browser: the checkpoint is saved for next time",
    );
  } else if (old.size > cp.size) {
    fail("consistency", new Error(`the log went back from size ${old.size} to ${cp.size}`));
  } else if (old.size === cp.size) {
    if (old.root === cp.root) mark("consistency", "ok", `same tree as before, size ${cp.size}`);
    else fail("consistency", new Error(`a different root at size ${cp.size}`));
  } else if (old.size === 0) {
    mark("consistency", "ok", `size ${cp.size} extends the empty tree`);
  } else {
    oldSize = old.size;
  }

  const wantLeaf = cp.size > 0;
  if (!wantLeaf) {
    mark("inclusion", "skip", "the log is empty");
    mark("leaf", "skip", "the log is empty");
  } else if (index >= cp.size) {
    mark("inclusion", "skip", `index ${index} is not below the tree size ${cp.size}`);
    mark("leaf", "skip", `index ${index} is not below the tree size ${cp.size}`);
  }
  const inTree = wantLeaf && index < cp.size;

  if (oldSize > 0 || inTree) {
    let p;
    try {
      p = await v.prove(origin.url, cp.size, cp.root, oldSize, inTree ? index : -1);
    } catch (e) {
      if (oldSize > 0) fail("consistency", e);
      if (inTree) {
        fail("inclusion", e);
        mark("leaf", "skip", "needs the leaf's tiles");
      }
      return finish(started, failed);
    }
    if (oldSize > 0) {
      try {
        await v.verifyConsistency(saved, note, p.consistency);
        mark("consistency", "ok", `size ${cp.size} extends size ${oldSize} seen before`);
      } catch (e) {
        fail("consistency", e);
      }
    }
    if (inTree) {
      try {
        const leaf = await v.parseLeaf(p.entry);
        mark("leaf", "ok", `mode: ${leaf.mode}, alibi ${leaf.alibiId}, issued ${leaf.issuedAt}`);
        await v.verifyInclusion(index, leaf.leafHash, p.inclusion, note);
        mark("inclusion", "ok", `leaf ${index} is in the tree of size ${cp.size}`);
      } catch (e) {
        const leafCheck = $("checks").querySelector('[data-check="leaf"]');
        if (leafCheck.dataset.status === "pending") {
          fail("leaf", e);
          mark("inclusion", "skip", "needs a well-formed leaf");
        } else {
          fail("inclusion", e);
        }
      }
    }
  }
  if (!failed) save(origin.name, note);
  return finish(started, failed);
}

function finish(started, failed) {
  const ms = Math.round(performance.now() - started);
  document.body.dataset.verifyMs = String(ms);
  if (failed)
    setVerdict("fail", `Verification failed (${ms} ms). The failing check is marked above.`);
  else setVerdict("ok", `Every check passed in your browser (${ms} ms).`);
}

// The monitor's report ----------------------------------------------------------

function originCard(r, checks) {
  const degraded = r.degradedLeaves ?? [];
  const findings = r.findings ?? [];
  const row = (term, ...value) => [el("dt", { text: term }), el("dd", {}, ...value)];
  const colog = r.coLogged
    ? `size ${r.coLogged.size} co-logged, proof verified ${age(r.coLogged.checkedAt)}`
    : "no co-logged checkpoint checked yet";
  const degradedList = el(
    "ul",
    { class: "degraded" },
    ...degraded.map((i) =>
      el(
        "li",
        {},
        el("button", {
          type: "button",
          text: `#${i}`,
          title: "Verify this leaf in your browser",
          "data-index": String(i),
          onclick: () => {
            $("origin").value = r.origin;
            $("index").value = String(i);
            void run();
          },
        }),
      ),
    ),
  );
  return el(
    "article",
    { class: "origin", "data-origin": r.origin },
    el("h3", { text: r.origin }),
    el(
      "dl",
      {},
      ...row("Size", el("span", { "data-field": "size", text: String(r.size) })),
      ...row("Root", el("span", { class: "mono", text: short(r.root) })),
      ...row(
        "Verified",
        el("span", { text: r.error ? `${age(r.verifiedAt)} (${r.error})` : age(r.verifiedAt) }),
      ),
      ...row(
        "Cosigned by",
        el("span", { text: r.cosigners.length ? r.cosigners.join(", ") : "—" }),
      ),
      ...row("Sigsum", el("span", { text: colog })),
      ...row("Leaves audited", el("span", { text: String(r.leavesAudited) })),
      ...row(
        "Degraded leaves",
        el("span", { "data-field": "degraded-count", text: String(degraded.length) }),
        degraded.length
          ? el("div", { class: "flag", text: "Degraded: TDX leg only, Nitro was down" })
          : "",
        degradedList,
      ),
      ...row(
        "TEE signers",
        el("span", { text: checks.teeSigners === "enabled" ? "checked" : "not yet enabled" }),
      ),
      ...row(
        "On-chain anchor",
        el("span", { text: checks.anchors === "enabled" ? "checked" : "not yet enabled" }),
      ),
      ...row(
        "Findings",
        findings.length
          ? el(
              "ul",
              { class: "findings" },
              ...findings.map((f) =>
                el("li", {
                  text: `${f.kind}${f.index != null ? ` at ${f.index}` : ""}: ${f.detail}`,
                }),
              ),
            )
          : el("span", { text: "none" }),
      ),
    ),
  );
}

function eqItem(e) {
  return el(
    "li",
    { "data-equivocation": e.id },
    el("a", { href: `/equivocations/${e.id}`, text: `${e.kind} · ${e.id.slice(0, 16)}…` }),
    ` ${new Date(e.detectedAt).toISOString()}`,
  );
}

async function refreshReport() {
  try {
    const r = await (await fetch("/report", { cache: "no-store" })).json();
    $("origins").replaceChildren(...r.origins.map((o) => originCard(o, r.checks)));
    const drills = r.equivocations.filter((e) => e.origin.includes("/conformance/"));
    const production = r.equivocations.filter((e) => !e.origin.includes("/conformance/"));
    $("eq-production").replaceChildren(
      ...(production.length
        ? production.map(eqItem)
        : [el("li", { class: "empty", text: "none" })]),
    );
    $("eq-drills").replaceChildren(
      ...(drills.length ? drills.map(eqItem) : [el("li", { class: "empty", text: "none yet" })]),
    );
  } catch {
    // The report is refreshed again shortly.
  }
}

// Wiring -----------------------------------------------------------------------

for (const o of config.origins) $("origin").append(el("option", { value: o.name, text: o.name }));

async function run() {
  const origin = config.origins.find((o) => o.name === $("origin").value);
  const index = Math.max(0, Math.floor(Number($("index").value) || 0));
  await verify(origin, index);
}

$("verify-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void run();
});

await refreshReport();
setInterval(() => void refreshReport(), 2000);
await run();
document.body.dataset.ready = "";
