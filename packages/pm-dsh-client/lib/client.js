window.__ModuleLoader__.load({
  id: "@workloom/dsh-pm-client",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    const productName = "WorkLoom PM";
    const promptIdeas = [
      {
        id: "workloom-pm-idea-prd",
        title: "把想法写成可验收的 PRD",
        detail: "澄清用户、范围、不做清单和验收条件",
        prompt: "把这个产品想法整理成可执行的 PRD：先澄清目标用户、问题、边界和不做清单，再给出可验证的验收条件与首期交付范围。",
      },
      {
        id: "workloom-pm-idea-build",
        title: "从需求走到代码与测试",
        detail: "由产品总监编排研发、验证和交付回执",
        prompt: "实现一个边界明确的小型功能，包含需求定义、代码、自动化测试、运行说明和真实交付回执；不要对外发布。",
      },
      {
        id: "workloom-pm-idea-review",
        title: "复盘问题并生成回归用例",
        detail: "形成复现、根因、修复方案和验证矩阵",
        prompt: "分析一个产品问题，输出最小复现、根因排查步骤、修复方案、正常/边界/异常回归用例和交付检查单。",
      },
    ];

    function WorkLoomMark({ size = 24, className }) {
      return React.createElement("svg", {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        className,
        "aria-hidden": "true",
        "data-workloom-pm": "mark",
      }, React.createElement("rect", {
        x: 1.25, y: 1.25, width: 21.5, height: 21.5, rx: 6.5,
        stroke: "currentColor", strokeWidth: 1.5, opacity: 0.55,
      }), React.createElement("path", {
        d: "M5 7.2 8.1 17l3.85-6.2 3.85 6.2L19 7.2",
        stroke: "currentColor", strokeWidth: 2.1, strokeLinecap: "round", strokeLinejoin: "round",
      }));
    }

    function WorkLoomName() {
      return React.createElement("span", {
        "data-workloom-pm": "brand",
        style: { whiteSpace: "nowrap", fontWeight: 560 },
      }, productName);
    }

    function createIdea(idea) {
      function IdeaButton({ inputActions }) {
        return React.createElement("button", {
          type: "button",
          "data-workloom-pm": "prompt",
          onClick: () => inputActions.setDraft(idea.prompt),
          style: {
            display: "grid",
            gap: 4,
            minWidth: 0,
            padding: "10px 12px",
            border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
            borderRadius: 12,
            background: "transparent",
            color: "inherit",
            textAlign: "left",
            cursor: "pointer",
          },
        }, React.createElement("strong", { style: { fontSize: 13, fontWeight: 560 } }, idea.title),
        React.createElement("span", { style: { fontSize: 12, opacity: 0.65, lineHeight: 1.45 } }, idea.detail));
      }
      return IdeaButton;
    }

    const inject = ["slots"];
    function apply(ctx) {
      if (typeof document !== "undefined") {
        const previousTitle = document.title;
        const enforceTitle = () => {
          if (document.title !== productName) document.title = productName;
        };
        enforceTitle();
        const observer = new MutationObserver(enforceTitle);
        if (document.head) observer.observe(document.head, { childList: true, subtree: true, characterData: true });
        ctx.effect(() => () => {
          observer.disconnect();
          document.title = previousTitle;
        });
      }
      ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.inject("sidebar.brand.name", function* () {
        yield ctx.slots.register({ name: "sidebar.brand.mark" }, WorkLoomMark);
        yield ctx.slots.register({ name: "sidebar.brand.name" }, WorkLoomName);
      }));
      ctx.slots.inject("conversation.hero.brand.mark", () =>
        ctx.slots.register({ name: "conversation.hero.brand.mark" }, WorkLoomMark));
      for (const [index, idea] of promptIdeas.entries()) {
        ctx.slots.inject("conversation.hero.options", () => ctx.slots.register({
          name: "conversation.hero.options",
          id: idea.id,
          order: index,
        }, createIdea(idea)));
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
