## Dockyard



## UI - shadcn-htmx

**shadcn-style UI components for [htmx v4](https://htmx.org) + [Tailwind CSS v4](https://tailwindcss.com) — built on web standards, not hacks.**

![Components: 82](https://img.shields.io/badge/components-82-8b5cf6)
![htmx v4](https://img.shields.io/badge/htmx-v4-3366cc)
![Tailwind CSS v4](https://img.shields.io/badge/Tailwind%20CSS-v4-38bdf8)

### Flavours

| Flavour      | Language / engine          | What you copy                     |
| ------------ | -------------------------- | --------------------------------- |
| **HTML**     | Raw markup (`.html`)       | A copy-paste snippet              |

### Quick start

The fastest path is the **flavour-aware CLI**. Pick your stack once, then add components — only *your* framework's file lands in your project.

```sh
bunx shadcn-htmx init --flavour html        # jsx | jinja | go | phoenix | html
bunx shadcn-htmx add button dialog combobox  # writes only the Jinja2 files
bunx shadcn-htmx list                         # browse every component
```

`init` writes a `shadcn-htmx.json` so later commands need no flags — it's
pre-pointed at the hosted registry (`https://shadcn-htmx.productdevbook.com/r`);
override it with the `registry` field or `--registry` to self-host.

### Components

**82 components** across six categories — every interactive one mapped to its
WAI-ARIA APG pattern, every other to a native HTML element, Web API, or modern CSS
feature.

| Category       | Components |
| -------------- | ---------- |
| **Forms**      | Button · Input · Textarea · Label · Checkbox · Combobox · Switch · Radio Group · Select · Slider · Number Input · Range Slider · Listbox · Form Field · File Upload · Date Time Picker · Active Search · Edit In Place · Output · Segmented Control · Rating · Color Picker · Autosize Textarea · Cascading Select · Autocomplete |
| **Layout**     | Card · Table · Collapsible · Toolbar · Grid · Treegrid · Splitter · Landmarks · Aspect Ratio · Auto Grid · Scroll Area · Snap List · Container Card · Sticky Header · Exclusive Accordion |
| **Display**    | Avatar · Badge · Separator · Carousel · Copy Button · Kbd · Highlight · Relative Time · Figure · Responsive Image · Media Player · Selectable Table · Delete Row |
| **Feedback**   | Alert · Progress · Skeleton · Toast · Meter · Feed · Status · Lazy Load · Optimistic Toggle · Scroll Progress |
| **Overlays**   | Dialog · Dropdown Menu · Popover · Tooltip · Alert Dialog · Sheet · Hover Card |
| **Navigation** | Accordion · Pagination · Tabs · Breadcrumb · Link · Menubar · Tree · Skip Link · Theme Toggle · Split Button · Sidebar · Load More |





## 依赖优先原则
实现任何通用功能前，必须先检查是否有现成的成熟库可用：
1. 先查 package.json 已有依赖能否满足
2. 再评估 npm 上的主流包（周下载量、维护状态），优先用 Context7 查其文档
3. 只有确认现成方案不满足需求时才手写实现，并在回复中说明为什么不用现成库
通用功能包括但不限于：日期处理、校验、ID 生成、重试/限流、文件监听、CLI 解析、日志等。