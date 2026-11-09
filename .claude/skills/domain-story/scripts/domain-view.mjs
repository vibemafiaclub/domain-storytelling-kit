#!/usr/bin/env node
// DOMAIN.md를 색칠한 HTML로 보여 주고, 표기 규칙을 어긴 곳을 알려 준다. 의존성 없음.
//
//   node .claude/skills/domain-story/scripts/domain-view.mjs [docs/DOMAIN.md] [--out 파일.html] [--no-open] [--check] [--status]
//
// 표기 (번호 문장 안에서만 읽는다)
//   [역할]     — 일을 하는 사람. 배경 초록
//   {엔티티}   — 하나하나 구별해서 추적하는 대상. 배경 노랑
//   (값객체)   — 값이 같으면 같은 것으로 보는 대상(기간·금액·요건). 배경 보라
//   <행동>     — 역할이 하는 일. 글자 파랑
//
// 문장 끝에 `— 확인 전`이 붙은 문장(다른 문서에서 옮겨 와 아직 당사자가 확인하지 않은 것)은 점선으로 따로 보인다.
// 문장 끝 `— 전해 들음`(사용자가 다른 등장인물의 일을 전한 것), `— AI 추측`(에이전트 추측에 사용자가 동의만 한 것)은 개수를 센다.
//
// --check: 경고가 있으면 종료 코드 1 (pre-commit 등에서 쓴다)
// --status: 화면 없이 문서 상태만 출력한다 — 장면별 AS-IS 문장 수, 확인 전 문장, 불편함, 경고. 스킬이 할 일을 고르는 근거

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { execFile } from "node:child_process";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const input = resolve(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out") ?? "docs/DOMAIN.md");
const out = resolve(opt("--out") ?? join(tmpdir(), `${basename(input, ".md")}-view.html`));

const KINDS = {
  "[": { close: "]", kind: "역할", cls: "role" },
  "{": { close: "}", kind: "엔티티", cls: "entity" },
  "(": { close: ")", kind: "값객체", cls: "value" },
  "<": { close: ">", kind: "행동", cls: "action" },
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// 인라인: `코드`, **굵게**, [글](링크)
function inline(s) {
  const parts = s.split(/(`[^`]+`)/);
  return parts
    .map((p) => {
      if (p.startsWith("`") && p.endsWith("`") && p.length > 1) return `<code>${esc(p.slice(1, -1))}</code>`;
      return esc(p)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
    })
    .join("");
}

// 번호 문장: 표기를 읽어 색칠하고, 쓰인 말을 모은다
function sentence(s, ctx) {
  let html = "";
  let buf = "";
  const found = [];
  let i = 0;
  while (i < s.length) {
    const k = KINDS[s[i]];
    if (k) {
      const j = s.indexOf(k.close, i + 1);
      const inner = j > 0 ? s.slice(i + 1, j) : "";
      if (j > 0 && inner.trim() && !/[\[\]{}()<>]/.test(inner)) {
        html += inline(buf);
        buf = "";
        const word = inner.trim();
        found.push({ word, kind: k.kind });
        html += `<span class="${k.cls}" title="${k.kind}">${esc(word)}</span>`;
        i = j + 1;
        continue;
      }
      ctx.warn(`닫히지 않았거나 비어 있는 ${k.kind} 표기 '${s[i]}'`);
    }
    buf += s[i];
    i++;
  }
  html += inline(buf);
  return { html, found };
}

function render(md) {
  const lines = md.replace(/\r/g, "").split("\n");
  const warnings = [];
  const uses = new Map(); // word -> Set(kind)
  let pending = 0;
  let heard = 0; // — 전해 들음
  let guessed = 0; // — AI 추측
  let cases = 0; // 「사례」 표의 C 행
  const scenes = []; // 「장면 목록」 표의 장면 이름
  const asis = new Map(); // AS-IS 제목 -> 문장 수
  let pains = 0; // 「불편함」 표의 P 행
  const glossary = new Map(); // 용어 -> 구분(없으면 "")
  let section = "";
  let lineNo = 0;
  const ctx = { warn: (m) => warnings.push(`${lineNo}행 [${section || "머리말"}] ${m}`) };
  const html = [];
  let list = null; // "ol" | "ul"
  let i = 0;

  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };

  while (i < lines.length) {
    const line = lines[i];
    lineNo = i + 1;

    if (line.startsWith("```")) {
      closeList();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      html.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      i++;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      if (h[1].length <= 2) section = h[2].trim();
      if (h[1].length <= 2 && /^AS-IS/.test(section)) asis.set(section, 0);
      html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }

    if (line.startsWith("|")) {
      closeList();
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(rows[1] && /^[\s|:-]+$/.test(rows[1]) ? 2 : 1).map(cells);
      const termCol = head.indexOf("용어");
      const kindCol = head.indexOf("구분");
      const isGlossary = section.startsWith("용어") && termCol >= 0;
      const sceneCol = head.indexOf("장면");
      if (section.startsWith("장면 목록") && sceneCol >= 0) for (const r of body) if (r[sceneCol]) scenes.push(r[sceneCol]);
      if (section.startsWith("불편함")) pains += body.filter((r) => /^P\d+/.test(r[0] ?? "")).length;
      if (section.startsWith("사례")) cases += body.filter((r) => /^C\d+/.test(r[0] ?? "")).length;
      const cls = { 역할: "role", 엔티티: "entity", 값객체: "value" };
      let t = `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>`;
      for (const r of body) {
        if (isGlossary && r[termCol]) glossary.set(r[termCol], kindCol >= 0 ? r[kindCol] ?? "" : "");
        t += "<tr>";
        r.forEach((c, ci) => {
          const k = isGlossary && ci === termCol && kindCol >= 0 ? cls[r[kindCol]] : undefined;
          t += `<td>${k ? `<span class="${k}">${esc(c)}</span>` : inline(c)}</td>`;
        });
        t += "</tr>";
      }
      html.push(t + "</tbody></table>");
      continue;
    }

    const ol = line.match(/^(\d+)\.\s+(.*)$/);
    if (ol) {
      if (list !== "ol") {
        closeList();
        html.push(`<ol start="${ol[1]}">`);
        list = "ol";
      }
      const story = /^(AS-IS|TO-BE)/.test(section);
      if (story && ol[2].trim()) {
        const { html: s, found } = sentence(ol[2], ctx);
        for (const f of found) {
          if (!uses.has(f.word)) uses.set(f.word, new Set());
          uses.get(f.word).add(f.kind);
        }
        if (!found.some((f) => f.kind === "역할")) ctx.warn(`[역할]이 없는 문장: ${ol[1]}. ${ol[2]}`);
        if (!found.some((f) => f.kind === "행동")) ctx.warn(`<행동>이 없는 문장: ${ol[1]}. ${ol[2]}`);
        if (asis.has(section)) asis.set(section, asis.get(section) + 1);
        const unconfirmed = /—\s*확인 전/.test(ol[2]);
        if (unconfirmed) pending++;
        if (/—\s*전해 들음/.test(ol[2])) heard++;
        if (/—\s*AI 추측/.test(ol[2])) guessed++;
        html.push(`<li class="story${unconfirmed ? " pending" : ""}">${s}</li>`);
      } else {
        html.push(`<li>${inline(ol[2])}</li>`);
      }
      i++;
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (list !== "ul") {
        closeList();
        html.push("<ul>");
        list = "ul";
      }
      html.push(`<li>${inline(ul[1])}</li>`);
      i++;
      continue;
    }

    closeList();
    if (line.startsWith(">")) html.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
    else if (line.trim()) html.push(`<p>${inline(line)}</p>`);
    i++;
  }
  closeList();

  // 용어 대조: 문장에 쓴 말이 「용어」에 있고, 같은 구분으로 쓰였는가
  if (glossary.size) {
    for (const [word, kinds] of uses) {
      if (kinds.has("행동")) continue;
      if (!glossary.has(word)) warnings.push(`「용어」에 없는 말: ${word} (${[...kinds].join("·")})`);
      else {
        const g = glossary.get(word);
        for (const k of kinds) if (g && g !== k) warnings.push(`'${word}'이(가) 「용어」에는 ${g}, 문장에서는 ${k}로 쓰였다`);
      }
    }
  }
  for (const [word, kinds] of uses) {
    const nonAction = [...kinds].filter((k) => k !== "행동");
    if (nonAction.length > 1) warnings.push(`'${word}'이(가) 여러 구분으로 쓰였다: ${nonAction.join(", ")}`);
  }

  return { body: html.join("\n"), warnings, uses, pending, scenes, asis, pains, heard, guessed, cases };
}

if (!existsSync(input)) {
  console.log(`문서 없음: ${input}`);
  process.exit(flag("--status") ? 0 : 1);
}
const md = readFileSync(input, "utf8");
const { body, warnings, uses, pending, scenes, asis, pains, heard, guessed, cases } = render(md);

if (flag("--status")) {
  const asisTitles = [...asis.keys()];
  const noAsis = scenes.filter((sc) => !asisTitles.some((t) => t.includes(sc)));
  const emptyAsis = asisTitles.filter((t) => asis.get(t) === 0);
  console.log(`문서: ${input}`);
  console.log(`장면 목록: ${scenes.length}개`);
  console.log(`AS-IS: ${asisTitles.length}개 — ${asisTitles.map((t) => `${t} (${asis.get(t)}문장)`).join(" / ") || "없음"}`);
  console.log(`AS-IS가 없는 장면: ${noAsis.length}개${noAsis.length ? " — " + noAsis.join(", ") : ""}`);
  console.log(`문장이 빈 AS-IS: ${emptyAsis.length}개${emptyAsis.length ? " — " + emptyAsis.join(", ") : ""}`);
  console.log(`확인 전 문장: ${pending}개`);
  console.log(`불편함: ${pains}개`);
  console.log(`전해 들음 문장: ${heard}개 (당사자 확인 질문으로 남긴다)`);
  console.log(`AI 추측 문장: ${guessed}개 (코치가 수업에서 확인한다)`);
  console.log(`사례: ${cases}개`);
  console.log(`표기 경고: ${warnings.length}개`);
  process.exit(0);
}

const count = (kind) => [...uses].filter(([, k]) => k.has(kind)).map(([w]) => w);
const chips = (kind, cls) =>
  count(kind)
    .map((w) => `<span class="${cls}">${esc(w)}</span>`)
    .join(" ") || '<span class="muted">없음</span>';

const page = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>${esc(basename(input))}</title>
<style>
  body { font-family: Pretendard, -apple-system, "Apple SD Gothic Neo", sans-serif; color: #111827; max-width: 920px; margin: 40px auto; padding: 0 24px; line-height: 1.75; }
  h1 { font-size: 28px; } h2 { margin-top: 40px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; } h3 { margin-top: 28px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; vertical-align: top; } th { background: #f9fafb; }
  code { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  pre { background: #f3f4f6; padding: 12px; border-radius: 8px; overflow-x: auto; }
  blockquote { border-left: 3px solid #d1d5db; margin: 8px 0; padding-left: 12px; color: #4b5563; }
  ol li.story { font-size: 17px; margin: 4px 0; }
  ol li.story.pending { color: #6b7280; border-bottom: 1px dashed #d1d5db; }
  .role, .entity, .value { font-weight: 700; padding: 1px 2px; border-radius: 3px; }
  .role { background: #d1fae5; } .entity { background: #fef3c7; } .value { background: #ede9fe; }
  .action { font-weight: 700; color: #2563eb; }
  .panel { background: #f8fafc; border-radius: 12px; padding: 16px 20px; margin-bottom: 24px; }
  .panel p { margin: 6px 0; } .muted { color: #9ca3af; }
  .warn { background: #fef2f2; border-radius: 12px; padding: 12px 20px; margin-bottom: 24px; font-size: 14px; }
  .warn li { margin: 2px 0; }
</style></head><body>
<div class="panel">
  <p><span class="role">역할</span> <code>[ ]</code> &nbsp; <span class="entity">엔티티</span> <code>{ }</code> &nbsp; <span class="value">값객체</span> <code>( )</code> &nbsp; <span class="action">행동</span> <code>&lt; &gt;</code></p>
  <p>역할 ${count("역할").length}: ${chips("역할", "role")}</p>
  <p>엔티티 ${count("엔티티").length}: ${chips("엔티티", "entity")}</p>
  <p>값객체 ${count("값객체").length}: ${chips("값객체", "value")}</p>
  <p>행동 ${count("행동").length}: ${chips("행동", "action")}</p>
  ${pending ? `<p>확인 전 문장 ${pending}개 — 점선으로 표시</p>` : ""}
  <p>전해 들음 ${heard} · AI 추측 ${guessed} · 사례 ${cases}</p>
</div>
${warnings.length ? `<div class="warn"><strong>표기 경고 ${warnings.length}개</strong><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
${body}
</body></html>`;

writeFileSync(out, page);
console.log(`→ ${out}`);
if (pending) console.log(`확인 전 문장 ${pending}개`);
if (warnings.length) {
  console.log(`표기 경고 ${warnings.length}개`);
  for (const w of warnings) console.log(`  - ${w}`);
}
if (!flag("--no-open") && !flag("--check")) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(cmd, [out], () => {});
}
if (flag("--check") && warnings.length) process.exit(1);
