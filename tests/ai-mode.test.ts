import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAiModeUrl, MAX_SELECTION_LENGTH } from "../src/lib/ai-mode";

test("queries Google AI Mode in Simplified Chinese without sending the article title by default", () => {
  const url = new URL(buildAiModeUrl({ text: "  柯克斯奖  ", title: "未选择发送的文章标题" }));
  assert.equal(url.origin, "https://www.google.com");
  assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("udm"), "50");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["q", "udm"]);
  assert.match(url.searchParams.get("q")!, /简体中文/);
  assert.match(url.searchParams.get("q")!, /「柯克斯奖」/);
  assert.doesNotMatch(url.searchParams.get("q")!, /未选择发送的文章标题|文章标题|上下文/);
});

test("query punctuation cannot become extra URL parameters or a fragment", () => {
  const text = '书名 &udm=14&q=elsewhere#fragment? "引用" + 100% / 😀';
  const url = new URL(buildAiModeUrl({ text }));
  assert.equal(url.searchParams.get("udm"), "50");
  assert.equal(url.searchParams.getAll("q").length, 1);
  assert.equal(url.searchParams.size, 2);
  assert.equal(url.hash, "");
  assert.ok(url.searchParams.get("q")!.includes(text));
});

test("only nonempty context opts into including article information", () => {
  const withoutContext = new URL(buildAiModeUrl({ text: "作家", title: "私人标题", context: " \n " }));
  assert.doesNotMatch(withoutContext.searchParams.get("q")!, /私人标题|上下文/);

  const withContext = new URL(buildAiModeUrl({ text: "作家", title: " 作家访谈 ", context: " 他在访谈中谈到了创作。 " }));
  const question = withContext.searchParams.get("q")!;
  assert.match(question, /文章标题：作家访谈/);
  assert.match(question, /上下文：他在访谈中谈到了创作。/);

  const onlyContext = new URL(buildAiModeUrl({ text: "作家", context: "一句上下文" }));
  assert.match(onlyContext.searchParams.get("q")!, /上下文：一句上下文/);
  assert.doesNotMatch(onlyContext.searchParams.get("q")!, /文章标题/);
});

test("rejects empty or overlong selections instead of truncating what the user selected", () => {
  assert.throws(() => buildAiModeUrl({ text: " \n\t " }), Error);
  assert.throws(() => buildAiModeUrl({ text: "象".repeat(MAX_SELECTION_LENGTH + 1) }), Error);
  assert.throws(() => buildAiModeUrl({ text: "😀".repeat(MAX_SELECTION_LENGTH + 1) }), Error);
});

test("selection limits count Unicode characters and preserve a valid selection in full", () => {
  const selection = "😀".repeat(MAX_SELECTION_LENGTH - 1) + "象";
  const question = new URL(buildAiModeUrl({ text: ` ${selection} ` })).searchParams.get("q")!;
  assert.ok(question.includes(`「${selection}」`));
  assert.ok(!question.includes("�"));
});

test("long title and context are bounded including the ellipsis without splitting Unicode characters", () => {
  const question = new URL(buildAiModeUrl({
    text: "文学奖",
    title: "😀".repeat(101),
    context: "𠮷".repeat(241),
  })).searchParams.get("q")!;
  const title = question.split("文章标题：")[1].split("\n")[0];
  const context = question.split("上下文：")[1];
  assert.equal(Array.from(title).length, 100);
  assert.equal(Array.from(context).length, 240);
  assert.equal(title, "😀".repeat(99) + "…");
  assert.equal(context, "𠮷".repeat(239) + "…");
  assert.ok(!question.includes("�"));
});

test("title and context at their exact bounds are preserved without an ellipsis", () => {
  const title = "象".repeat(100);
  const context = "😀".repeat(240);
  const question = new URL(buildAiModeUrl({ text: "大象", title, context })).searchParams.get("q")!;
  assert.ok(question.includes(`文章标题：${title}\n`));
  assert.ok(question.endsWith(`上下文：${context}`));
  assert.ok(!question.includes("…"));
});
