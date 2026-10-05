import {execFileSync} from "node:child_process";
import fs from "node:fs";

const queries = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "SYSTEM_PROMPT",
  "systemPrompt",
  "system_instruction",
  "AGENT_PROMPT",
];
const priorPath = "docs/sources/agent-prompt-discovery-2026-10-05.json";
const outputPath = "docs/sources/agent-prompt-discovery.generated.json";
const prior = fs.existsSync(priorPath) ? JSON.parse(fs.readFileSync(priorPath, "utf8")) : {items: []};
const priorClassByPath = new Map(
  (prior.items ?? []).map(item => [`${item.repository}\0${item.path}`, item.classification]),
);

function classificationFor(item) {
  const repository = item.repository?.full_name ?? "";
  const path = String(item.path ?? "");
  const priorClass = priorClassByPath.get(`${repository}\0${path}`);
  if (priorClass) return priorClass;
  const base = path.split("/").pop() ?? "";
  if (["AGENTS.md", "AGENT.md", "CLAUDE.md", "GEMINI.md"].includes(base)) {
    return "canonical_instruction_candidate";
  }
  if (base.toLowerCase().includes("prompt")) return "runtime_prompt_candidate";
  return "reference_or_derivative";
}

function excerptFor(item) {
  return (item.text_matches ?? [])
    .map(match => String(match.fragment ?? ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

const hits = new Map();
for (const query of queries) {
  const raw = execFileSync(
    "gh",
    [
      "api",
      "--paginate",
      "--slurp",
      "-X",
      "GET",
      "search/code",
      "-H",
      "Accept: application/vnd.github.text-match+json",
      "-f",
      `q=${query} user:Hazy142`,
      "-f",
      "per_page=100",
    ],
    {encoding: "utf8"},
  );
  const pages = JSON.parse(raw);
  for (const page of pages) {
    for (const item of page.items ?? []) {
      if (hits.has(item.html_url)) continue;
      hits.set(item.html_url, {
        discovery_query: query,
        repository: item.repository?.full_name ?? null,
        path: item.path,
        url: item.html_url,
        classification: classificationFor(item),
        excerpt: excerptFor(item),
      });
    }
  }
}

const items = [...hits.values()].sort((a, b) => a.url.localeCompare(b.url));
const classification_counts = {
  canonical_instruction_candidate: 0,
  reference_or_derivative: 0,
  runtime_prompt_candidate: 0,
};
for (const item of items) classification_counts[item.classification] += 1;

const out = {
  schema: "resonarch.toolfabric.agent-prompt-discovery/v1",
  generated_at: new Date().toISOString(),
  scope: "Live GitHub code search over repositories accessible under owner/org Hazy142",
  queries,
  unique_result_urls: items.length,
  classification_counts,
  caveat:
    "Live discovery evidence only. Known repository/path classifications inherit the frozen 2026-10-05 review; new paths receive a conservative filename heuristic and require human review before normative use.",
  items,
};

fs.writeFileSync(outputPath, JSON.stringify(out, null, 2) + "\n");
console.log(`discovered ${items.length} unique URLs -> ${outputPath}`);
