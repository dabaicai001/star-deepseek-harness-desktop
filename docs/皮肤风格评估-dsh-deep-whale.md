# 皮肤风格评估:dsh-deep-whale / maid-atelier(支线 C)

> 评估日期:2026-08-14
> 来源:[Small-tailqwq/dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale)(main,tree `89d9884`)
> 分析对象:`maid-atelier/src/client/maid-atelier.module.css`(2571 行)、`skin.json`、`NOTICE`、仓库根/皮肤 README
> 性质:本文件是**评估产出**,不改任何代码;token 候选落地须另走 `docs/设计系统.md` 第 9 章流程。
> 下文中 `CSS:L<n>` 均指 `maid-atelier/src/client/maid-atelier.module.css` 行号。

---

## C-1 风格元素评估提取

### 1. 配色(实际取色)

皮肤自带一套独立色板 + 对 dsh `--dsw-alias-*` token 的覆盖,亮/暗双套(CSS:L5-86):

| 角色 | 亮 | 暗 | 来源 |
|---|---|---|---|
| navy 梯度 950/900/800 | `#091333` / `#10204d` / `#1c326b` | 同色板 | CSS:L8-10 |
| 靛蓝 indigo / 长春花蓝 periwinkle | `#526aa8` / `#8ea5da` | 同色板 | CSS:L11-12 |
| 陶瓷白 porcelain | `#f8f6f0` | — | CSS:L13 |
| **柔金 gold / gold-soft** | `#c5a468` / `#e2cfaa` | 边框用 `#d3b477`(rgba 211,180,119) | CSS:L14-15, L65 |
| 墨 ink(主文字) | `#172347` | `#e7ecf7` | CSS:L16, L67 |
| 页面底色 | `#dce6f5` | `#080f27` | CSS:L7, L54 |
| 玻璃面 glass | `rgba(248,250,255,.68)` | `rgba(13,25,59,.74)` | CSS:L17, L55 |
| 分层 bg layer1→3 | `rgba(248,250,255,.72)`→`.88` | `rgba(18,31,67,.9)`→`rgba(32,49,91,.94)` | CSS:L21-23, L58-60 |
| 边框 l1/l2(蓝调) | `rgba(71,91,145,.18)`→`.30` | `rgba(151,169,216,.20)`→`.34` | CSS:L25-27, L62-64 |
| 边框 l3(**金色描边**) | `rgba(197,164,104,.64)` | `rgba(211,180,119,.66)` | CSS:L28, L65 |
| hover / active | 长春花蓝 `.12` / **金 `.24`** | 淡蓝 `.14` / **金 `.24`** | CSS:L36-37, L73-74 |

**评估**:
- 柔金 `#c5a468` 的使用纪律值得注意:只出现在**边框 l3、active 态、running 辉光、徽标**等点缀位置,从不做大块填充(全文件金色系共 34 处,均为 rgba 低透明描边/辉光)。这一"暖色只作次级强调"的用法与方案 8.2 判断一致。
- navy 梯度(`#091333`→`#1c326b`)与 StarHub `--bg` 家族同属深海蓝,数值可作校准参考,但**不新增 token**(现有 `--bg` 体系已覆盖该角色)。
- 长春花蓝/靛蓝(`#8ea5da`/`#526aa8`)作为主交互色 → **与 StarHub 风格冲突不采纳**:青色 `--cyan` 是品牌强调色,不接受第二个蓝系主色。

### 2. 圆角梯度

| 场景 | 值 | 来源 |
|---|---|---|
| chip / 小标签 | 4px | CSS:L354 |
| 行 / 输入 | 7~8px | CSS:L531, L1283, L1320 |
| 胶囊按钮 | 999px | CSS:L1349 |
| 气泡(assistant) | **18px 18px 18px 7px**(不对称,左下小角) | CSS:L2154 |
| composer 卡 | 34px;hero 态 `clamp(26px, 2vw, 34px)` | CSS:L1603, L1625 |
| 大装饰框 | 38px | CSS:L1846 |

**评估**:4→8→18→34 的梯度方向与方案 9.2 已拍板的"chip 4~6 / 行 8 / 卡片 16~22 / 胶囊 999px"一致,**方案 9.2 已覆盖**;composer 的 34px 偏大,与 StarHub 工具向定位不符,不照搬。唯一增量是**不对称气泡圆角**(18/18/18/7,左下小角指示发言人方向),dsh 原生方案没有这一特征,列为 token 候选。

### 3. 阴影 / 质感参数

| 项 | 值 | 来源 |
|---|---|---|
| 面板大阴影(亮) | `0 18px 54px rgba(15,30,72,.2), 0 2px 8px rgba(15,30,72,.12)` | CSS:L18 |
| 面板大阴影(暗) | `0 18px 58px rgba(0,0,0,.38), 0 2px 10px rgba(0,0,0,.3)` | CSS:L56 |
| composer hero 阴影(亮) | `0 18px 52px rgba(29,48,94,.18)` + **inset 高光** `inset 0 1px rgba(255,255,255,.76)` | CSS:L1629-1631 |
| 气泡阴影(轻) | `0 4px 14px rgba(19,38,87,.08)` / 暗 `0 4px 16px rgba(0,0,0,.22)` | CSS:L2156, L2163 |
| 玻璃模糊 | hero 卡 `blur(2.5~3px) saturate(.88~.94)`;问答卡 `blur(16px) saturate(.9)` | CSS:L1632, L1640, L2220 |
| 金色辉光(running 态) | `drop-shadow(0 0 6px rgba(197,164,104,.7))` | CSS:L2184 |
| 顶帘双层渐变(titlebar 暗) | `rgba(4,11,38,.98)`→`rgba(23,41,92,.9)` 四段 + 金线 `rgba(211,180,119,.5)` | CSS:L2522-2531 |

**评估**:
- "双层阴影(大柔和 + 小贴边)"的写法与方案 9.3 的 lv1~lv3 收敛方向可比,但数值量级(18px/54px)属于**华丽装饰系**,与 9.2 扁平化拍板冲突 → 玻璃拟态/大投影**默认不采纳**(方案 9.5 结论,本次复核确认)。轻量档 `0 4px 14px …08` 与 9.3 lv1/lv2 接近,已被覆盖。
- inset 顶部高光 `inset 0 1px rgba(255,255,255,.x)` 是玻璃质感的关键一笔;cyber.css 组件类本有"伪元素高光"惯例,此写法可作为**实现技法参考**,不单设 token。
- 金色 running 辉光参数(6px  blur、70% 透明)可作青色版 running 态的对标参考。

### 4. 动效参数

| 项 | 值 | 来源 |
|---|---|---|
| 布局级缓动(角色退场/卡位) | `cubic-bezier(0.22, 0.78, 0.2, 1)`,520~620ms | CSS:L112-119, L1617 |
| 常规过渡 | 140~150ms `ease`;trim 层 520ms `cubic-bezier(0.4,0,0.2,1)` | CSS:L890, L1876, L200 |
| thinking 扫光 | 色带宽 240px,`2.8s ease-in-out infinite`;关键帧 `left:-240px → 100%`,opacity 0→1(15%)→1(88%)→0;配色 金 30% + 长春花蓝 24% | CSS:L2170-2181 |
| 会话 jewel chase | 1s linear 阶梯 opacity `1 → .72 → .42 → .18`(三段追光) | CSS:L1206-1225 |
| 入场动画 | ribbon 420ms / 内容 260ms 延迟 90ms,`cubic-bezier(0.2,0.74,0.22,1)` | CSS:L1099-1105 |
| reduced-motion | 全量降级:动画改静态透明度阶梯、transition 清零 | CSS:L2541-2570 |

**评估**:
- `cubic-bezier(0.22,0.78,0.2,1)` + 520~620ms 是"装饰位移"档,方案 9.5 已判定缓动由 dsh 原生方案(`0.4,0,0.2,1` + 0.2s 基准)覆盖 → **已覆盖,不入基准**;但该长档曲线在大位移场景(AiView 侧栏开合、面板 docking)手感更好,列为**补充档候选**。
- 扫光思路方案 9.2 已采纳(青色版);本次补齐精确参数(240px 带宽 / 2.8s / opacity 关键帧节奏),作 D2 落地实现参考,不需单设 token。
- jewel chase 的 opacity 阶梯(1/.72/.42/.18)可直接借给 AI running 状态点,列为候选。

---

## token 候选表

> 状态图例:✅ 可入 token 候选(待设计系统流程评审) · ⏸ 备选默认不采纳(9.5) · ➖ 实现参考,不设 token

| 建议 token / 参数 | 值(暗色为主) | 来源 | 状态 | 采纳理由 |
|---|---|---|---|---|
| `--cyber-radius-bubble` | `18px 18px 18px 7px` | CSS:L2154 | ✅ | 不对称气泡圆角,左下小角指示发言人;dsh 原生无此特征,是 maid-atelier 唯一未被 9.2 覆盖的圆角增量;与 9.2 卡片 16~22 梯度兼容 |
| `--cyber-ease-emphasize`(长档补充) | `cubic-bezier(0.22, 0.78, 0.2, 1)` + 520ms | CSS:L112-119 | ✅ | 大位移/布局级动画补充档;基准档(0.2s `0.4,0,0.2,1`)9.2 已定,此档仅用于面板 docking、侧栏开合等大行程 |
| AI running 状态点 opacity 阶梯 | `1 → .72 → .42 → .18`(1s linear) | CSS:L1209-1225 | ✅ | 三段追光式阶梯比匀速脉冲更有"行进感";值可直接进 keyframes,配 `--cyan` 色 |
| `--cyber-accent-gold`(备选) | `#c5a468`(暗态描边 `#d3b477`) | CSS:L14, L65 | ⏸ | 8.2 列为可选暖色点缀(仅边框/active/hover);9.5 已拍板默认不采纳(与扁平化+青色单强调冲突),如未来需要走 token 增补流程 |
| thinking 扫光参数 | 带宽 240px、2.8s ease-in-out、关键帧 0/15/88/100% | CSS:L2170-2181 | ➖ | 思路 9.2 已采纳(青色版),此处数值作 D2 实现参考,不需 token |
| running 辉光对标 | `drop-shadow(0 0 6px <accent 70%>)` | CSS:L2184 | ➖ | 换 `--cyan` 即为 StarHub 版;技法参考 |
| inset 顶部高光 | `inset 0 1px rgba(255,255,255,.08~.76)` | CSS:L1631, L1776 | ➖ | 玻璃质感关键笔,作 `.cyber-*` 伪元素高光技法参考,不设 token |
| navy 梯度 / 长春花蓝 / 玻璃模糊 / 大投影 | — | CSS:L8-12, L18, L1632 | ❌ 不采纳 | navy 已由 `--bg` 家族覆盖;长春花蓝与 `--cyan` 冲突;玻璃拟态与 18px/54px 大投影属华丽装饰系,违反 9.2 扁平化拍板(9.5 确认) |

---

## C-2 素材评估(不入库,仅参考)

### 素材清单

`maid-atelier/assets/` 共 11 个 WebP 位图 + 2 张预览图:

| 素材 | 大小 | 用途 |
|---|---|---|
| `maid-atelier-maid-left-v5.webp` / `maid-right-v6.webp` | 286KB / 520KB | 双女仆立绘(透明层独立挂载) |
| `maid-atelier-palace-day-v4.webp` / `palace-night-v4.webp` | 279KB / 270KB | 整屏工坊场景背景(亮/暗成对) |
| `maid-bottom-crest-v1.webp` / `maid-bottom-trim-tile-v1.webp` | 45KB / 1KB | 底部蕾丝带(纹章 + 平铺条) |
| `maid-composer-frame-v4.webp` / `maid-settings-frame-v1.webp` | 95KB / 32KB | composer / 设置页装饰框 |
| `maid-sidebar-corner-v1.webp` | 31KB | Q 版侧栏角饰 |
| `maid-workspace-ribbon-v2.webp` / `maid-workspace-shield-v2.webp` | 44KB / 22KB | 工作区缎带 / 徽盾 |
| `preview/light.webp` / `dark.webp` | 各 ~254KB | 效果预览 |

运行时素材以 data URI 内嵌进 client bundle(`src/client/art.ts` 506KB、`background-art.generated.ts` 1.8MB、`chrome-art.generated.ts` 274KB 等),激活不依赖远程资源。

### 许可链(三创署名链,见 `NOTICE`)

1. **一创 上善**(Pixiv 62155430)—— 鲸鱼娘角色形象原作
2. **二创 ZipZipPipe**(Pixiv 18604994)—— 加入 DeepSeek 元素的女仆鲸鱼娘二次设计(**生成模型:GPT Image 2**)
3. **三创 Small-tailqwq**(dsh-deep-whale)—— 本皮肤的 DeepSeek 元素再设计

整体 **CC BY-NC-SA 4.0**:署名须保留完整创作链;非商业性使用;衍生须相同方式共享。

### 为什么不可入库

- **NC(非商业)与 MIT 直接冲突**:StarHub 以 MIT 发布,不限制商用;混入 NC 素材会使整个分发包丧失商用自由,下游用户无法安全再分发。
- **SA(相同方式共享)具传染性**:衍生作品须以 CC BY-NC-SA 再许可,与 MIT 的宽松条款不兼容;哪怕只入库一张位图,含该素材的构建产物许可状态都会被污染。
- **署名链义务重**:任何使用都须完整保留一创→二创→三创链,桌面应用分发形态下难以合规履行。
- **额外风险**:二创素材由 GPT Image 2 生成,其训练/输出权属本身处于灰色地带,进一步放大合规不确定性。

结论:**素材、CSS 成品、data URI 内嵌串一律不入库、不拷贝**(与方案 8.2 一致);本评估文档仅记录数值与思路,不含任何原仓库内容复制。

### "仅参考"的具体参考点

1. **信息密度纪律**:装饰再华丽也不侵占内容轴——对话激活时双立绘自动退向视口安全边缘并降不透明度(0.9,窄屏 0.74,CSS:L144-181),`pointer-events: none` + `contain: strict` 保证零交互干扰。StarHub 若做 AI 面板装饰,同样遵守"内容轴优先、装饰可退避"。
2. **装饰层级模型**:`character-stage` z-0(整屏)→ `top-trim` z-20(顶帘)→ 内容层,各装饰层独立 `position: fixed`、独立销毁(apply 的 effect 销毁器全量还原 CSS/DOM 写入)。层级与生命周期分离的思路可参考。
3. **状态钩子稳定性**:用 `data-phase` / `data-state='running'` / `data-chat-flow-kind` 等**语义 data 属性**做动画钩子,而非脆弱类名——StarHub D2 改 AI 界面时应沿用此约定(我们已有同类做法,互相印证)。
4. **亮暗素材成对**:背景图 day/night 成对制作、按主题热切换;StarHub 若将来引入场景化背景,素材管线需同样成对。
5. **reduced-motion 全量降级**:所有装饰动画在 `prefers-reduced-motion` 下退化为静态透明度阶梯(CSS:L2541-2570),降级面覆盖完整,值得对照检查我们的降级是否同样无遗漏。

---

## 结论:与方案 8.2 / 9.5 的对照

- **确认 8.2**:风格导入清单四项(分层 token 组织、玻璃拟态参数、柔金次级强调、缓动手感)本次均已复核到精确数值与行号;"装饰层与素材不迁移、不引入该仓库任何文件"的策略维持不变,并在 C-2 补齐了完整素材清单与许可链细节(含二创为 GPT Image 2 生成这一新增风险点)。
- **确认 9.5**:缓动与扫光已被 dsh 原生方案覆盖——本次补充确认扫光的精确参数可作 D2 实现参考;玻璃拟态与柔金默认不采纳,维持原判(柔金降级为 ⏸ 备选 token,仅在明确需要暖色点缀时走增补流程)。
- **本次新增增量**(8.2/9.5 未覆盖):① 不对称气泡圆角 `18px 18px 18px 7px`;② 长档缓动 `cubic-bezier(0.22,0.78,0.2,1)` 作为大位移补充档;③ jewel chase opacity 阶梯用于 running 状态点。三者列入上方 token 候选表,落地与否由支线 A(D0 token 层)评审决定。
